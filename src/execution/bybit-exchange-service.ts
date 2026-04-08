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
import { log } from '../lib/logger.js'
import type { AccountState, PlaceOrderParams, OrderResult } from './exchange-service.js'

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

  /**
   * Optional constructor injection for per-strategy keys (used by ExchangePool).
   * If provided, injected values take precedence over env vars in init().
   */
  constructor(
    private readonly injectedApiKey?: string,
    private readonly injectedApiSecret?: string,
  ) {}

  /**
   * Initialize Bybit client.
   * Reads from injected keys (constructor) or env vars (BYBIT_API_KEY / BYBIT_API_SECRET).
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return

    const apiKey = this.injectedApiKey ?? process.env['BYBIT_API_KEY']
    const apiSecret = this.injectedApiSecret ?? process.env['BYBIT_API_SECRET']
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

      return list
        .map(pos => {
          const size = parseFloat(pos.size)
          // Bybit: side 'Buy' = long (positive), 'Sell' = short (negative)
          const signedSize = pos.side === 'Buy' ? size : -size
          if (signedSize === 0) return null

          const leverage = pos.leverage ? parseFloat(pos.leverage) : undefined
          const liqPrice = pos.liqPrice && pos.liqPrice !== '' ? parseFloat(pos.liqPrice) : null

          // Extract coin from symbol (e.g. 'BTCUSDT' → 'BTC')
          const coin = pos.symbol.endsWith('USDT')
            ? pos.symbol.slice(0, -4)
            : pos.symbol

          return {
            coin,
            size: signedSize,
            entryPrice: parseFloat(pos.avgPrice),
            unrealizedPnl: parseFloat(pos.unrealisedPnl),
            liquidationPrice: liqPrice,
            leverage: Number.isFinite(leverage) && (leverage ?? 0) > 0 ? leverage : undefined,
          } satisfies ExchangePositionSnapshot
        })
        .filter((p): p is ExchangePositionSnapshot => p !== null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `getPositions exception: ${msg}`)
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
      return state
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bybit-exec', `getAccountState exception: ${msg}`)
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

  /**
   * Set leverage for a coin. Bybit supports setting leverage via setLeverage endpoint,
   * but the BybitExchangeService delegates leverage control to order params (positionIdx=0).
   * This is a no-op stub — set leverage via Bybit UI or extend this method if needed.
   */
  setLeverage(_coin: string, _leverage: number): Promise<void> {
    log.warn('bybit-svc', 'setLeverage not yet implemented — configure leverage in Bybit UI or extend this method')
    return Promise.resolve()
  }

  /** Reload symbols (no-op: Bybit uses coin+USDT naming, no lookup needed). */
  reloadSymbols(): Promise<void> {
    return Promise.resolve()
  }
}
