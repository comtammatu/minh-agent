/**
 * BybitExchangeService — Bybit linear perp implementation of IExchangeService.
 *
 * Auth: API key + secret from env (BYBIT_API_KEY / BYBIT_API_SECRET).
 * Category: 'linear' (USDT-margined perpetuals).
 * Symbol format: coin + 'USDT' (e.g. BTC → BTCUSDT).
 *
 * Key differences from ExchangeService (HL):
 * - Auth is API key/secret, not agent wallet private key
 * - SL/TP can be set inline at order placement (stopLoss / takeProfit params)
 * - No dead man's switch — caller must implement heartbeat cancellation
 * - Positions: use getPositionInfo() with category:'linear'
 * - No SymbolConverter needed — symbol = coin + 'USDT'
 */

import { RestClientV5 } from 'bybit-api'
import type { ExchangePositionSnapshot } from '../agent/types.js'
import { getHealthMonitor } from '../agent/self-healing.js'
import { log } from '../lib/logger.js'
import type { AccountState, PlaceOrderParams, OrderResult, PlaceTriggerParams } from './exchange-service.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BybitOrderParams {
  coin: string
  side: 'long' | 'short'
  type: 'market' | 'limit'
  price: number
  size: number
  reduceOnly: boolean
  slPrice?: number
  tpPrice?: number
  cloid?: string
}

// ─── BybitExchangeService ────────────────────────────────────────────────────

export class BybitExchangeService {
  readonly exchangeId = 'BB' as const

  private client: RestClientV5 | null = null
  // Keys stored privately — never passed to log.*
  private apiKey: string = ''
  private apiSecret: string = ''
  private testnet: boolean = false
  private initialized = false

  /** Cached account value for pipeline risk-filter compatibility. */
  private cachedAccountValue: number = 0

  /** coin → maxLeverage from getInstrumentsInfo (loaded once at init). */
  private maxLeverageMap: Map<string, number> = new Map()

  /** coin → risk tiers sorted ascending by riskLimitValue (lazy-loaded per coin). */
  private riskTierCache: Map<string, Array<{ riskLimitValue: number; maxLeverage: number }>> = new Map()

  /**
   * Initialize Bybit client.
   * Reads BYBIT_API_KEY / BYBIT_API_SECRET from env.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return

    const apiKey = process.env['BYBIT_API_KEY']
    const apiSecret = process.env['BYBIT_API_SECRET']
    if (!apiKey) {
      throw new Error('BYBIT_API_KEY env required for Bybit exchange operations')
    }
    if (!apiSecret) {
      throw new Error('BYBIT_API_SECRET env required for Bybit exchange operations')
    }

    // Store privately — NEVER log these values
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.testnet = process.env['BYBIT_TESTNET'] === 'true'

    this.client = new RestClientV5({
      key: this.apiKey,
      secret: this.apiSecret,
      testnet: this.testnet,
    })

    // Load maxLeverage per coin from getInstrumentsInfo (non-fatal)
    try {
      const instrResp = await this.client.getInstrumentsInfo({ category: 'linear' })
      for (const inst of instrResp.result?.list ?? []) {
        const coin = inst.symbol.endsWith('USDT') ? inst.symbol.slice(0, -4) : inst.symbol
        const maxLev = parseFloat(inst.leverageFilter.maxLeverage)
        if (Number.isFinite(maxLev) && maxLev > 0) this.maxLeverageMap.set(coin, maxLev)
      }
      log.info('bybit-svc', `Loaded maxLeverage for ${this.maxLeverageMap.size} instruments`)
    } catch (err) {
      log.warn('bybit-svc', `Failed to load maxLeverage data: ${err instanceof Error ? err.message : err}`)
    }

    this.initialized = true
    log.info('bybit-svc', `BybitExchangeService initialized (testnet=${this.testnet})`)
  }

  /** Ensure init() has been called. */
  private ensureInit(): void {
    if (!this.initialized || !this.client) {
      throw new Error('BybitExchangeService not initialized — call init() first')
    }
  }

  /** Normalize coin name to Bybit linear symbol. */
  private toSymbol(coin: string): string {
    return `${coin}USDT`
  }

  // ── Order Placement ────────────────────────────────────────────────────────

  /**
   * Place a single order (market or limit) on Bybit linear perps.
   *
   * Market: timeInForce = 'IOC', side: 'Buy'/'Sell'
   * Limit:  timeInForce = 'GTC'
   *
   * positionIdx: 0 = one-way mode (default for linear perpetuals).
   *
   * Maps from PlaceOrderParams (shared shape with HL ExchangeService).
   */
  async placeOrder(params: PlaceOrderParams | BybitOrderParams): Promise<OrderResult> {
    this.ensureInit()

    const symbol = this.toSymbol(params.coin)
    const side = params.side === 'long' ? 'Buy' : 'Sell'
    const orderType = params.type === 'market' ? 'Market' : 'Limit'
    const timeInForce = params.type === 'market' ? 'IOC' : 'GTC'

    // Resolve optional SL/TP prices (BybitOrderParams supports inline SL/TP)
    const bbParams = params as BybitOrderParams
    const slPrice = bbParams.slPrice
    const tpPrice = bbParams.tpPrice

    const submitParams: Parameters<RestClientV5['submitOrder']>[0] = {
      category: 'linear',
      symbol,
      side,
      orderType,
      qty: String(params.size),
      timeInForce,
      positionIdx: 0,
      reduceOnly: params.reduceOnly,
      ...(params.type === 'limit' ? { price: String(params.price) } : {}),
      ...(slPrice !== undefined ? { stopLoss: String(slPrice) } : {}),
      ...(tpPrice !== undefined ? { takeProfit: String(tpPrice) } : {}),
      ...(params.cloid ? { orderLinkId: params.cloid } : {}),
    }

    try {
      const resp = await this.client!.submitOrder(submitParams)

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit error code ${resp.retCode}`
        log.error('bybit-exec', `placeOrder failed: ${errMsg} [${symbol}]`)
        return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: errMsg }
      }

      const orderId = resp.result?.orderId ?? null
      // Bybit market orders may fill immediately — orderId signals submitted
      log.info('bybit-exec', `placeOrder OK: ${symbol} ${side} orderId=${orderId}`)
      return {
        success: true,
        // Bybit orderId is a string; coerce to number (NaN if non-numeric) or keep null
        oid: orderId ? (Number.isFinite(Number(orderId)) ? Number(orderId) : null) : null,
        avgPx: null,   // not returned at submit time (poll trades for fill px)
        totalSz: null,
        status: 'submitted',
        error: null,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `placeOrder exception: ${msg}`)
      throw err
    }
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  /**
   * Cancel an order by Bybit orderId.
   * @param coin  Coin name (e.g. 'BTC')
   * @param orderId  Exchange order ID (string)
   */
  async cancelOrder(coin: string, orderId: string): Promise<OrderResult> {
    this.ensureInit()

    const symbol = this.toSymbol(coin)

    try {
      const resp = await this.client!.cancelOrder({
        category: 'linear',
        symbol,
        orderId,
      })

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit cancel error code ${resp.retCode}`
        log.error('bybit-exec', `cancelOrder failed: ${errMsg} [${symbol} orderId=${orderId}]`)
        return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: errMsg }
      }

      log.info('bybit-exec', `cancelOrder OK: ${symbol} orderId=${orderId}`)
      return { success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `cancelOrder exception: ${msg}`)
      throw err
    }
  }

  /**
   * Cancel by cloid (orderLinkId in Bybit terms).
   * @param coin  Coin name (e.g. 'BTC')
   * @param cloid  Client order ID
   */
  async cancelByCloid(coin: string, cloid: string): Promise<OrderResult> {
    this.ensureInit()

    const symbol = this.toSymbol(coin)

    try {
      const resp = await this.client!.cancelOrder({
        category: 'linear',
        symbol,
        orderLinkId: cloid,
      })

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit cancel error code ${resp.retCode}`
        log.error('bybit-exec', `cancelByCloid failed: ${errMsg} [${symbol}]`)
        return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: errMsg }
      }

      log.info('bybit-exec', `cancelByCloid OK: ${symbol} cloid=${cloid.slice(0, 10)}...`)
      return { success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `cancelByCloid exception: ${msg}`)
      throw err
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  /**
   * Fetch all open linear perp positions.
   * Returns normalized ExchangePositionSnapshot[] for PositionMonitor reconciliation.
   *
   * Uses settleCoin:'USDT' to fetch all linear positions in one call.
   * Filters out zero-size positions (closed).
   */
  async getPositions(): Promise<ExchangePositionSnapshot[]> {
    this.ensureInit()

    try {
      const resp = await this.client!.getPositionInfo({
        category: 'linear',
        settleCoin: 'USDT',
      })

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit getPositionInfo error code ${resp.retCode}`
        log.error('bybit-exec', `getPositions failed: ${errMsg}`)
        return []
      }

      const list = resp.result?.list ?? []

      const snaps: ExchangePositionSnapshot[] = []
      for (const pos of list) {
        const size = parseFloat(pos.size)
        // Bybit: side 'Buy' = long (positive), 'Sell' = short (negative)
        const signedSize = pos.side === 'Buy' ? size : -size
        if (signedSize === 0) continue

        const levRaw = pos.leverage ? parseFloat(pos.leverage) : undefined
        const liqPrice = pos.liqPrice && pos.liqPrice !== '' ? parseFloat(pos.liqPrice) : null

        // Extract coin from symbol (e.g. 'BTCUSDT' → 'BTC')
        const coin = pos.symbol.endsWith('USDT')
          ? pos.symbol.slice(0, -4)
          : pos.symbol

        const snap: ExchangePositionSnapshot = {
          coin,
          size: signedSize,
          entryPrice: parseFloat(pos.avgPrice),
          unrealizedPnl: parseFloat(pos.unrealisedPnl),
          liquidationPrice: liqPrice,
        }
        if (Number.isFinite(levRaw) && (levRaw ?? 0) > 0) snap.leverage = levRaw as number
        snaps.push(snap)
      }
      getHealthMonitor().recordSuccess('exchange')
      return snaps
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `getPositions exception: ${msg}`)
      getHealthMonitor().recordError('exchange', msg)
      return []
    }
  }

  /**
   * Fetch a single position for a specific coin.
   * Returns null if no open position found.
   */
  async getPosition(coin: string): Promise<ExchangePositionSnapshot | null> {
    const positions = await this.getPositions()
    return positions.find(p => p.coin === coin) ?? null
  }

  // ── Account State ──────────────────────────────────────────────────────────

  /**
   * Query Bybit UNIFIED wallet balance and map to AccountState.
   * Updates cachedAccountValue.
   *
   * Maps:
   *   accountValue    → totalEquity (total portfolio value)
   *   totalNtlPos     → totalPerpUPL (unrealized PnL proxy; Bybit doesn't expose totalNtlPos directly)
   *   totalMarginUsed → totalInitialMargin
   *   withdrawable    → totalAvailableBalance
   *   spotUsdcBalance → USDC coin walletBalance in the account
   *   effectiveBalance → totalEquity (unified account includes spot+perp)
   */
  async getAccountState(): Promise<AccountState> {
    this.ensureInit()

    try {
      const resp = await this.client!.getWalletBalance({ accountType: 'UNIFIED' })

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit getWalletBalance error code ${resp.retCode}`
        log.error('bybit-exec', `getAccountState failed: ${errMsg}`)
        throw new Error(errMsg)
      }

      const wallet = resp.result?.list?.[0]
      if (!wallet) {
        throw new Error('Bybit getWalletBalance: empty result')
      }

      const accountValue = parseFloat(wallet.totalEquity)
      const totalNtlPos = parseFloat(wallet.totalPerpUPL)
      const totalMarginUsed = parseFloat(wallet.totalInitialMargin)
      const withdrawable = parseFloat(wallet.totalAvailableBalance)

      // Find USDC spot balance in the coin list
      const usdcCoin = wallet.coin.find(c => c.coin === 'USDC')
      const spotUsdcBalance = usdcCoin ? parseFloat(usdcCoin.walletBalance) : 0

      const state: AccountState = {
        accountValue,
        totalNtlPos: Number.isFinite(totalNtlPos) ? totalNtlPos : 0,
        totalMarginUsed: Number.isFinite(totalMarginUsed) ? totalMarginUsed : 0,
        withdrawable: Number.isFinite(withdrawable) ? withdrawable : 0,
        spotUsdcBalance: Number.isFinite(spotUsdcBalance) ? spotUsdcBalance : 0,
        // Bybit UNIFIED already aggregates spot+perp — no need to double-add
        effectiveBalance: Number.isFinite(accountValue) ? accountValue : 0,
      }

      this.cachedAccountValue = state.effectiveBalance
      log.info('bybit-exec', `getAccountState OK: equity=${accountValue.toFixed(2)}`)
      getHealthMonitor().recordSuccess('exchange')
      return state
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `getAccountState exception: ${msg}`)
      getHealthMonitor().recordError('exchange', msg)
      throw err
    }
  }

  /** Get cached account value (from last getAccountState call). */
  getCachedAccountValue(): number {
    return this.cachedAccountValue
  }

  // ── HL-specific no-ops ─────────────────────────────────────────────────────

  /**
   * Dead man's switch is not supported on Bybit.
   * Callers should implement their own heartbeat cancellation (e.g. cancelAll on shutdown).
   */
  scheduleCancel(_timestampMs: number): void {
    log.warn('bybit-svc', 'scheduleCancel not supported on Bybit — use heartbeat cancellation instead')
  }

  /** Get max leverage for a coin (from getInstrumentsInfo). Returns undefined if unknown. */
  getMaxLeverage(coin: string): number | undefined {
    return this.maxLeverageMap.get(coin)
  }

  /**
   * Load and cache risk tiers for a coin (lazy, called once per coin).
   * Tiers are sorted ascending by riskLimitValue so callers can use find().
   */
  private async loadRiskTiers(coin: string): Promise<Array<{ riskLimitValue: number; maxLeverage: number }>> {
    if (this.riskTierCache.has(coin)) return this.riskTierCache.get(coin)!

    const symbol = this.toSymbol(coin)
    try {
      const resp = await this.client!.getRiskLimit({ category: 'linear', symbol })
      const tiers = (resp.result?.list ?? [])
        .map(t => ({
          riskLimitValue: parseFloat(t.riskLimitValue),
          maxLeverage: parseFloat(t.maxLeverage),
        }))
        .filter(t => Number.isFinite(t.riskLimitValue) && Number.isFinite(t.maxLeverage))
        .sort((a, b) => a.riskLimitValue - b.riskLimitValue)

      this.riskTierCache.set(coin, tiers)
      log.info('bybit-svc', `Loaded ${tiers.length} risk tiers for ${symbol}`)
      return tiers
    } catch (err) {
      log.warn('bybit-svc', `loadRiskTiers failed for ${symbol}: ${err instanceof Error ? err.message : err}`)
      return []
    }
  }

  /**
   * Set cross leverage for a coin before placing an entry order.
   *
   * If sizeUsd is provided, selects the appropriate risk tier for the position size
   * and caps leverage at tier.maxLeverage (not just leverageFilter.maxLeverage).
   * Falls back to leverageFilter.maxLeverage if risk tiers unavailable.
   * Non-fatal: order still proceeds if setLeverage fails.
   */
  async setLeverage(coin: string, leverage: number, sizeUsd?: number): Promise<void> {
    this.ensureInit()

    const symbol = this.toSymbol(coin)

    // Resolve effective maxLeverage: prefer risk-tier cap over flat leverageFilter cap
    let effectiveMaxLev = this.maxLeverageMap.get(coin)

    if (sizeUsd !== undefined && sizeUsd > 0) {
      const tiers = await this.loadRiskTiers(coin)
      if (tiers.length > 0) {
        // First tier where position fits (sizeUsd ≤ tier.riskLimitValue)
        const lastTier = tiers[tiers.length - 1]!
        const tier = tiers.find(t => sizeUsd <= t.riskLimitValue) ?? lastTier
        if (tier === lastTier && sizeUsd > tier.riskLimitValue) {
          log.warn('bybit-svc', `setLeverage: ${symbol} sizeUsd=${sizeUsd.toFixed(0)} exceeds all risk tiers (max=${tier.riskLimitValue}), using lowest leverage ${tier.maxLeverage}x`)
        }
        effectiveMaxLev = tier.maxLeverage
      }
    }

    const lev = effectiveMaxLev !== undefined
      ? Math.min(Math.max(1, Math.ceil(leverage)), effectiveMaxLev)
      : Math.max(1, Math.ceil(leverage))

    try {
      const resp = await this.client!.setLeverage({
        category: 'linear',
        symbol,
        buyLeverage: String(lev),
        sellLeverage: String(lev),
      })

      if (resp.retCode !== 0) {
        // retCode 110043 = leverage not modified (already set) — treat as OK
        if (resp.retCode === 110043) {
          log.info('bybit-svc', `setLeverage: ${symbol} already at ${lev}x`)
          return
        }
        log.warn('bybit-svc', `setLeverage failed: ${resp.retMsg} [${symbol}]`)
        return
      }

      log.info('bybit-svc', `setLeverage: ${symbol} → ${lev}x${effectiveMaxLev !== undefined ? ` (tierMax=${effectiveMaxLev}x)` : ''}`)
    } catch (err) {
      log.warn('bybit-svc', `setLeverage exception: ${err instanceof Error ? err.message : err}`)
    }
  }

  /** Reload symbols (no-op: Bybit uses coin+USDT naming, no lookup needed). */
  reloadSymbols(): Promise<void> {
    return Promise.resolve()
  }

  // ── IExchangeService identity / symbol methods ─────────────────────────────

  /** Wallet address (signing key). Bybit uses API key — return masked prefix. */
  getWalletAddress(): string {
    if (!this.initialized || !this.apiKey) return 'BYBIT'
    return `BYBIT:${this.apiKey.slice(0, 8)}`
  }

  /** Account address (same as wallet for Bybit — no separate agent wallet concept). */
  getAccountAddress(): string {
    return this.getWalletAddress()
  }

  /**
   * Bybit does not use integer asset IDs — always returns undefined.
   * Callers must handle undefined and not pass it to HL-specific logic.
   */
  getAssetId(_coin: string): number | undefined {
    return undefined
  }

  /**
   * Bybit size decimals vary by symbol; always returns undefined here.
   * Size precision must be queried from the instruments_info endpoint if needed.
   */
  getSzDecimals(_coin: string): number | undefined {
    return undefined
  }

  /**
   * Bybit does not support separate trigger (SL/TP) orders — SL/TP must be set
   * inline via `stopLoss`/`takeProfit` params on `placeOrder` (BybitOrderParams).
   * This stub warns and returns a failure so callers can handle gracefully.
   */
  async placeTrigger(params: PlaceTriggerParams): Promise<OrderResult> {
    log.warn('bybit-svc', `placeTrigger not supported on Bybit — set slPrice/tpPrice inline on placeOrder (${params.coin} ${params.tpsl})`)
    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'placeTrigger not supported on Bybit — use placeOrder slPrice/tpPrice params' }
  }

  /**
   * Cancel order by numeric oid. Delegates to cancelOrder (converts oid to string).
   * Bybit order IDs are strings; numeric oid from HL-style flow is coerced.
   */
  async cancelByOid(coin: string, oid: number): Promise<OrderResult> {
    return this.cancelOrder(coin, String(oid))
  }

  /**
   * Modify trigger order (trail stop SL update).
   * Not yet implemented for Bybit — logs warning and returns failure.
   * TODO: implement via Bybit amendOrder with updated stopLoss.
   */
  async modifyTrigger(
    _coin: string,
    _oid: number,
    _side: 'long' | 'short',
    _newTriggerPrice: number,
    _size: number,
    _isMarket: boolean,
    _tpsl: 'tp' | 'sl',
  ): Promise<OrderResult> {
    log.warn('bybit-svc', 'modifyTrigger not yet implemented on Bybit — trail stop updates are no-ops')
    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'modifyTrigger not yet implemented on Bybit' }
  }

  /**
   * Aggregate fill size + VWAP for an entry order by cloid.
   * Not yet implemented — returns null so caller falls back to entry price estimate.
   * TODO: implement via Bybit trade history filtered by orderLinkId.
   */
  async getFillAggregateByCloid(_cloid: string, _coin: string): Promise<{ avgPx: number; totalSz: number } | null> {
    return null
  }
}
