/**
 * Exchange Service — single point of contact with Hyperliquid L1 (Sprint 2 S10).
 *
 * Responsibilities:
 *   - Initialize wallet (viem privateKeyToAccount) from PRIVATE_KEY env var
 *   - Initialize HL ExchangeClient + SymbolConverter (asset ID / szDecimals lookup)
 *   - Place orders (market, limit, trigger SL/TP) with correct precision formatting
 *   - Cancel orders (by oid or cloid)
 *   - Modify trigger orders (trail stop SL updates)
 *   - Query clearinghouseState (account balance, open positions)
 *   - Cache accountValue for pipeline risk-filter (R11, R17)
 *
 * Design:
 *   - Singleton pattern (same as OrderManager, PositionMonitor)
 *   - ALL exchange I/O goes through this module — no other module imports @nktkas/hyperliquid exchange
 *   - SDK's SymbolConverter handles asset ID + szDecimals mapping
 *   - SDK's formatPrice/formatSize handle HL precision rules (5 sig figs, szDecimals rounding)
 *   - Wallet private key loaded once, never logged, never exported
 *
 * HL API notes (from docs):
 *   - Asset ID: integer index from meta.universe (perps), NOT coin name
 *   - Price: string, max 5 sig figs, max (6 - szDecimals) decimal places for perps
 *   - Size: string, truncated to szDecimals decimal places
 *   - Market order: use { limit: { tif: "FrontendMarket" } } (IOC-like)
 *   - Trigger SL: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } }
 *   - Trigger TP: { trigger: { isMarket: false, triggerPx, tpsl: "tp" } }
 *   - Grouping: "na" for entry, "normalTpsl" for SL/TP attached to position
 *   - Cancel by oid: { cancels: [{ a: assetId, o: oid }] }
 *   - Cancel by cloid: { cancels: [{ asset: assetId, cloid }] }
 *   - Nonce: timestamp in ms (SDK handles this internally)
 *   - Numeric values in responses are strings → parseFloat
 *   - Response status always "ok" even on error — check statuses array
 *   - Minimum order value: $10
 */

import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid'
import { SymbolConverter, formatPrice, formatSize } from '@nktkas/hyperliquid/utils'
import { privateKeyToAccount } from 'viem/accounts'
import type { ExchangePositionSnapshot } from '../agent/types.js'
import { info } from '../feed/rest.js'
import { acquire } from '../feed/rate-limiter.js'
import { log } from '../lib/logger.js'
import { withRetry, isRetryableExchangeError, is503 } from '../lib/retry.js'
import { getHealthMonitor } from '../agent/self-healing.js'
import { RETRY, HL_MIN_ORDER_NOTIONAL_USD, type WalletConfig } from '../config.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  coin: string
  side: 'long' | 'short'
  type: 'market' | 'limit'
  price: number        // reference price (market) or limit price
  size: number         // in coin units (pre-formatting)
  reduceOnly: boolean
  cloid?: string       // 0x + 32 hex chars
}

export interface PlaceTriggerParams {
  coin: string
  side: 'long' | 'short'  // close side
  triggerPrice: number
  size: number
  isMarket: boolean        // SL = true (trigger-market), TP = false (trigger-limit)
  tpsl: 'tp' | 'sl'
  cloid?: string
}

export interface OrderResult {
  success: boolean
  /** HL oid (number) — set on resting or filled */
  oid: number | null
  /** Fill info — set on immediate fill */
  avgPx: number | null
  totalSz: number | null
  /** Status string for trigger orders */
  status: string | null
  error: string | null
}

export interface AccountState {
  accountValue: number
  totalNtlPos: number
  totalMarginUsed: number
  withdrawable: number
  /** Spot USDC balance (unified account keeps funds here). */
  spotUsdcBalance: number
  /** Effective total = perp accountValue + spot USDC (true available capital). */
  effectiveBalance: number
}

// ─── Exchange Service ───────────────────────────────────────────────────────

export class ExchangeService {
  private exchange: ExchangeClient | null = null
  private converter: SymbolConverter | null = null
  private transport: HttpTransport
  private walletAddress: string = ''
  /** Main account address for info queries (differs from walletAddress in agent mode). */
  private accountAddress: string = ''

  /** Cached account value — refreshed on each getAccountState() call. */
  private cachedAccountValue: number = 0

  /** coin → maxLeverage from meta.universe (loaded once at init). */
  private maxLeverageMap: Map<string, number> = new Map()

  /** Whether the service has been initialized. */
  private initialized = false

  /** Optional wallet config injected via constructor (per-strategy wallet mode). */
  private walletConfig: WalletConfig | undefined

  /**
   * @param walletConfig Optional per-strategy wallet config (E25: constructor injection).
   *   If provided, init() uses these credentials instead of env vars.
   *   If omitted, falls back to PRIVATE_KEY / ACCOUNT_ADDRESS env vars (backward compat).
   */
  constructor(walletConfig?: WalletConfig) {
    this.transport = new HttpTransport()
    this.walletConfig = walletConfig
  }

  /**
   * Initialize wallet + ExchangeClient + SymbolConverter.
   * Must be called before any exchange operation.
   * Safe to call multiple times (idempotent).
   *
   * Uses injected WalletConfig if provided, otherwise falls back to env vars.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    const privateKey = this.walletConfig?.privateKey ?? process.env.PRIVATE_KEY
    if (!privateKey) {
      throw new Error('PRIVATE_KEY env var is required for exchange operations')
    }

    // Validate format: must start with 0x
    if (!privateKey.startsWith('0x')) {
      throw new Error('PRIVATE_KEY must start with 0x')
    }

    const wallet = privateKeyToAccount(privateKey as `0x${string}`)
    this.walletAddress = wallet.address

    // Resolve account address: injected config > env var > derived from PK
    const accountAddr = this.walletConfig?.accountAddress ?? process.env.ACCOUNT_ADDRESS
    if (accountAddr) {
      if (!accountAddr.startsWith('0x') || accountAddr.length !== 42) {
        throw new Error('ACCOUNT_ADDRESS must be a valid 0x-prefixed Ethereum address (42 chars)')
      }
      this.accountAddress = accountAddr
      log.info('exchange-service', `Agent wallet mode: signing=${this.walletAddress.slice(0, 6)}...${this.walletAddress.slice(-4)}, account=${this.accountAddress.slice(0, 6)}...${this.accountAddress.slice(-4)}`)
    } else {
      this.accountAddress = wallet.address
      log.warn('exchange-service', `Main wallet mode (no ACCOUNT_ADDRESS) — consider using an agent wallet for safety`)
      log.info('exchange-service', `Wallet: ${this.walletAddress.slice(0, 6)}...${this.walletAddress.slice(-4)}`)
    }

    this.exchange = new ExchangeClient({ transport: this.transport, wallet })
    this.converter = await SymbolConverter.create({ transport: this.transport })

    // Load maxLeverage per coin from meta.universe
    try {
      const meta = await info.meta()
      for (const asset of meta.universe) {
        this.maxLeverageMap.set(asset.name, asset.maxLeverage)
      }
      log.info('exchange-service', `Loaded maxLeverage for ${this.maxLeverageMap.size} assets`)
    } catch (err) {
      log.warn('exchange-service', `Failed to load maxLeverage data: ${err instanceof Error ? err.message : err}`)
    }

    this.initialized = true
    log.info('exchange-service', 'ExchangeService initialized (wallet + SymbolConverter)')
  }

  /** Ensure init() has been called. */
  private ensureInit(): void {
    if (!this.initialized || !this.exchange || !this.converter) {
      throw new Error('ExchangeService not initialized — call init() first')
    }
  }

  /** Get signing wallet address (agent wallet in agent mode, main wallet otherwise). */
  getWalletAddress(): string {
    return this.walletAddress
  }

  /** Get main account address (for info queries: balance, positions). */
  getAccountAddress(): string {
    return this.accountAddress
  }

  /** Reload SymbolConverter mappings (call after coin-selector refresh). */
  async reloadSymbols(): Promise<void> {
    this.ensureInit()
    await this.converter!.reload()
    log.info('exchange-service', 'SymbolConverter reloaded')
  }

  // ── Asset Lookup ──────────────────────────────────────────────────────────

  /** Get HL asset ID for a coin name. Returns undefined if unknown. */
  getAssetId(coin: string): number | undefined {
    this.ensureInit()
    return this.converter!.getAssetId(coin)
  }

  /** Get szDecimals for a coin. Returns undefined if unknown. */
  getSzDecimals(coin: string): number | undefined {
    this.ensureInit()
    return this.converter!.getSzDecimals(coin)
  }

  /** Get max leverage for a coin (from meta.universe). Returns undefined if unknown. */
  getMaxLeverage(coin: string): number | undefined {
    return this.maxLeverageMap.get(coin)
  }

  // ── Leverage ──────────────────────────────────────────────────────────────

  /**
   * Set cross leverage for a coin before placing an entry order.
   * Ensures margin used = sizeUsd / leverage ≤ targetMarginUsd.
   * leverage must be integer ≥ 1.
   */
  async setLeverage(coin: string, leverage: number): Promise<void> {
    this.ensureInit()
    const assetId = this.converter!.getAssetId(coin)
    if (assetId === undefined) {
      log.warn('exchange-service', `setLeverage: unknown asset ${coin}`)
      return
    }
    const maxLev = this.maxLeverageMap.get(coin)
    const lev = maxLev !== undefined
      ? Math.min(Math.max(1, Math.ceil(leverage)), maxLev)
      : Math.max(1, Math.ceil(leverage))
    try {
      await acquire()
      await this.exchange!.updateLeverage({ asset: assetId, isCross: true, leverage: lev })
      log.info('exchange-service', `setLeverage: ${coin} → ${lev}x cross${maxLev !== undefined ? ` (max=${maxLev}x)` : ''}`)
    } catch (err) {
      // Non-fatal: order placement still proceeds, HL uses existing leverage
      log.warn('exchange-service', `setLeverage failed for ${coin}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ── Order Placement ───────────────────────────────────────────────────────

  /**
   * Place a single entry order (market or limit).
   *
   * Market orders use tif "FrontendMarket" (IOC-like, fills immediately or cancels).
   * Limit orders use tif "Gtc" (rests on book until filled/cancelled).
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    this.ensureInit()

    const assetId = this.converter!.getAssetId(params.coin)
    if (assetId === undefined) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Unknown asset: ${params.coin}` }
    }

    const szDecimals = this.converter!.getSzDecimals(params.coin) ?? 0
    const priceStr = formatPrice(params.price, szDecimals)
    const sizeStr = formatSize(params.size, szDecimals)

    // Validate minimum order value (HL)
    const orderNotional = params.price * params.size
    if (orderNotional < HL_MIN_ORDER_NOTIONAL_USD) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Order notional $${orderNotional.toFixed(2)} < $${HL_MIN_ORDER_NOTIONAL_USD} minimum` }
    }

    const isBuy = params.side === 'long'
    const tif = params.type === 'market' ? 'FrontendMarket' as const : 'Gtc' as const

    log.info('exchange-service', `Placing ${params.type} ${params.side} ${params.coin}: price=${priceStr} size=${sizeStr} [asset=${assetId}]`)

    const health = getHealthMonitor()
    const retryResult = await withRetry(async () => {
      await acquire()
      const response = await this.exchange!.order({
        orders: [{
          a: assetId,
          b: isBuy,
          p: priceStr,
          s: sizeStr,
          r: params.reduceOnly,
          t: { limit: { tif } },
          ...(params.cloid ? { c: params.cloid as `0x${string}` } : {}),
        }],
        grouping: 'na',
      })
      return this.parseOrderStatus(response.response.data.statuses[0])
    }, {
      maxAttempts: RETRY.exchangeMaxAttempts,
      initialDelayMs: RETRY.initialDelayMs,
      jitterFraction: RETRY.jitterFraction,
      shouldRetry: (err) => isRetryableExchangeError(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('exchange-service', `Order retry ${attempt}: ${msg} (backoff ${delayMs}ms)${is503(err) ? ' [MAINTENANCE]' : ''}`)
      },
    })

    if (retryResult.success && retryResult.value) {
      health.recordSuccess('exchange')
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `Order failed after ${retryResult.attempts} attempts: ${msg}`)
    health.recordError('exchange', msg)
    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: msg }
  }

  /**
   * Place a trigger order (SL or TP) on exchange.
   * Uses grouping "normalTpsl" — fixed size, doesn't adjust with position.
   *
   * R9: SL = trigger-market (isMarket=true), TP = trigger-limit (isMarket=false).
   */
  async placeTrigger(params: PlaceTriggerParams): Promise<OrderResult> {
    this.ensureInit()

    const assetId = this.converter!.getAssetId(params.coin)
    if (assetId === undefined) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Unknown asset: ${params.coin}` }
    }

    const szDecimals = this.converter!.getSzDecimals(params.coin) ?? 0
    const triggerPxStr = formatPrice(params.triggerPrice, szDecimals)
    const sizeStr = formatSize(params.size, szDecimals)
    const isBuy = params.side === 'long'

    log.info('exchange-service', `Placing ${params.tpsl.toUpperCase()} trigger ${params.coin}: triggerPx=${triggerPxStr} size=${sizeStr} isMarket=${params.isMarket}`)

    const health = getHealthMonitor()
    const retryResult = await withRetry(async () => {
      await acquire()
      const response = await this.exchange!.order({
        orders: [{
          a: assetId,
          b: isBuy,
          p: triggerPxStr,
          s: sizeStr,
          r: true,  // trigger orders are always reduce-only
          t: {
            trigger: {
              isMarket: params.isMarket,
              triggerPx: triggerPxStr,
              tpsl: params.tpsl,
            },
          },
          ...(params.cloid ? { c: params.cloid as `0x${string}` } : {}),
        }],
        grouping: 'normalTpsl',
      })
      return this.parseOrderStatus(response.response.data.statuses[0])
    }, {
      maxAttempts: RETRY.exchangeMaxAttempts,
      initialDelayMs: RETRY.initialDelayMs,
      jitterFraction: RETRY.jitterFraction,
      shouldRetry: (err) => isRetryableExchangeError(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('exchange-service', `Trigger retry ${attempt}: ${msg} (backoff ${delayMs}ms)${is503(err) ? ' [MAINTENANCE]' : ''}`)
      },
    })

    if (retryResult.success && retryResult.value) {
      health.recordSuccess('exchange')
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `Trigger failed after ${retryResult.attempts} attempts: ${msg}`)
    health.recordError('exchange', msg)
    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: msg }
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  /** Cancel order by exchange oid (with retry for transient errors). */
  async cancelByOid(coin: string, oid: number): Promise<OrderResult> {
    this.ensureInit()

    const assetId = this.converter!.getAssetId(coin)
    if (assetId === undefined) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Unknown asset: ${coin}` }
    }

    log.info('exchange-service', `Cancelling order: ${coin} oid=${oid}`)

    const retryResult = await withRetry(
      async () => {
        await acquire()
        const response = await this.exchange!.cancel({
          cancels: [{ a: assetId, o: oid }],
        })
        const status = response.response.data.statuses[0]
        if (status === 'success') {
          return { success: true as const, oid, avgPx: null, totalSz: null, status: 'cancelled' as const, error: null }
        }
        const errorMsg = typeof status === 'object' && 'error' in status ? status.error : 'Unknown cancel error'
        throw new Error(errorMsg)
      },
      {
        maxAttempts: RETRY.exchangeMaxAttempts,
        initialDelayMs: RETRY.initialDelayMs,
        jitterFraction: RETRY.jitterFraction,
        shouldRetry: (err) => isRetryableExchangeError(err),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('exchange-service', `Cancel retry ${attempt} for ${coin} oid=${oid}: ${msg} (backoff ${delayMs}ms)`)
        },
      },
    )

    if (retryResult.success && retryResult.value) {
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `Cancel failed after ${retryResult.attempts} attempts: ${msg}`)
    return { success: false, oid, avgPx: null, totalSz: null, status: null, error: msg }
  }

  /** Cancel order by cloid (with retry for transient errors). */
  async cancelByCloid(coin: string, cloid: string): Promise<OrderResult> {
    this.ensureInit()

    const assetId = this.converter!.getAssetId(coin)
    if (assetId === undefined) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Unknown asset: ${coin}` }
    }

    log.info('exchange-service', `Cancelling by cloid: ${coin} cloid=${cloid.slice(0, 10)}...`)

    const retryResult = await withRetry(
      async () => {
        await acquire()
        const response = await this.exchange!.cancelByCloid({
          cancels: [{ asset: assetId, cloid: cloid as `0x${string}` }],
        })
        const status = response.response.data.statuses[0]
        if (status === 'success') {
          return { success: true as const, oid: null, avgPx: null, totalSz: null, status: 'cancelled' as const, error: null }
        }
        const errorMsg = typeof status === 'object' && 'error' in status ? status.error : 'Unknown cancel error'
        throw new Error(errorMsg)
      },
      {
        maxAttempts: RETRY.exchangeMaxAttempts,
        initialDelayMs: RETRY.initialDelayMs,
        jitterFraction: RETRY.jitterFraction,
        shouldRetry: (err) => isRetryableExchangeError(err),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('exchange-service', `CancelByCloid retry ${attempt} for ${coin}: ${msg} (backoff ${delayMs}ms)`)
        },
      },
    )

    if (retryResult.success && retryResult.value) {
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `CancelByCloid failed after ${retryResult.attempts} attempts: ${msg}`)
    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: msg }
  }

  // ── Modify (trail stop SL updates) ────────────────────────────────────────

  /**
   * Modify an existing trigger order (e.g. trail stop SL update).
   * Uses the HL modify endpoint — replaces the order in-place by oid.
   */
  async modifyTrigger(
    coin: string,
    oid: number,
    side: 'long' | 'short',
    newTriggerPrice: number,
    size: number,
    isMarket: boolean,
    tpsl: 'tp' | 'sl',
  ): Promise<OrderResult> {
    this.ensureInit()

    const assetId = this.converter!.getAssetId(coin)
    if (assetId === undefined) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: `Unknown asset: ${coin}` }
    }

    const szDecimals = this.converter!.getSzDecimals(coin) ?? 0
    const triggerPxStr = formatPrice(newTriggerPrice, szDecimals)
    const sizeStr = formatSize(size, szDecimals)
    const isBuy = side === 'long'

    log.info('exchange-service', `Modifying ${tpsl.toUpperCase()} trigger: ${coin} oid=${oid} newPx=${triggerPxStr}`)

    const retryResult = await withRetry(
      async () => {
        await acquire()
        await this.exchange!.modify({
          oid,
          order: {
            a: assetId,
            b: isBuy,
            p: triggerPxStr,
            s: sizeStr,
            r: true,
            t: {
              trigger: {
                isMarket,
                triggerPx: triggerPxStr,
                tpsl,
              },
            },
          },
        })
        return { success: true as const, oid, avgPx: null, totalSz: null, status: 'modified' as const, error: null }
      },
      {
        maxAttempts: RETRY.slTpMaxAttempts,
        initialDelayMs: RETRY.initialDelayMs,
        jitterFraction: RETRY.jitterFraction,
        shouldRetry: (err) => isRetryableExchangeError(err),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('exchange-service', `Modify trigger retry ${attempt} for ${coin} oid=${oid}: ${msg} (backoff ${delayMs}ms)`)
        },
      },
    )

    if (retryResult.success && retryResult.value) {
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `Modify trigger failed after ${retryResult.attempts} attempts: ${msg}`)
    return { success: false, oid, avgPx: null, totalSz: null, status: null, error: msg }
  }

  // ── Account State ─────────────────────────────────────────────────────────

  /**
   * Query HL clearinghouseState for account summary.
   * Updates cached accountValue (used by pipeline risk-filter R11).
   */
  async getAccountState(): Promise<AccountState> {
    this.ensureInit()

    const health = getHealthMonitor()
    const retryResult = await withRetry(async () => {
      await acquire()
      // Query both perp and spot state (unified account keeps USDC in spot)
      const [state, spotState] = await Promise.all([
        info.clearinghouseState({ user: this.accountAddress as `0x${string}` }),
        info.spotClearinghouseState({ user: this.accountAddress as `0x${string}` }),
      ])
      const accountValue = parseFloat(state.marginSummary.accountValue)
      const spotUsdc = spotState.balances
        .filter((b: { coin: string; total: string }) => b.coin === 'USDC')
        .reduce((sum: number, b: { total: string }) => sum + parseFloat(b.total), 0)
      return {
        accountValue,
        totalNtlPos: parseFloat(state.marginSummary.totalNtlPos),
        totalMarginUsed: parseFloat(state.marginSummary.totalMarginUsed),
        withdrawable: parseFloat(state.withdrawable),
        spotUsdcBalance: spotUsdc,
        effectiveBalance: accountValue + spotUsdc,
      } satisfies AccountState
    }, {
      maxAttempts: RETRY.exchangeMaxAttempts,
      initialDelayMs: RETRY.initialDelayMs,
      jitterFraction: RETRY.jitterFraction,
      shouldRetry: (err) => isRetryableExchangeError(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('exchange-service', `getAccountState retry ${attempt}: ${msg} (backoff ${delayMs}ms)`)
      },
    })

    if (retryResult.success && retryResult.value) {
      this.cachedAccountValue = retryResult.value.effectiveBalance
      health.recordSuccess('exchange')
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `getAccountState failed after ${retryResult.attempts} attempts: ${msg}`)
    health.recordError('exchange', msg)
    throw retryResult.lastError
  }

  /** Get cached account value (from last getAccountState call). */
  getCachedAccountValue(): number {
    return this.cachedAccountValue
  }

  /**
   * Query open positions from HL clearinghouseState.
   * Returns normalized ExchangePositionSnapshot[] for PositionMonitor reconciliation.
   */
  async getPositions(): Promise<ExchangePositionSnapshot[]> {
    this.ensureInit()

    const health = getHealthMonitor()
    const retryResult = await withRetry(async () => {
      await acquire()
      const state = await info.clearinghouseState({ user: this.accountAddress as `0x${string}` })
      return state.assetPositions.map(ap => {
        const pos = ap.position
        const szi = parseFloat(pos.szi)
        const levRaw = pos.leverage as { value?: number } | undefined
        const leverage = typeof levRaw?.value === 'number' && levRaw.value > 0 ? levRaw.value : undefined
        return {
          coin: pos.coin,
          size: szi,
          entryPrice: parseFloat(pos.entryPx),
          unrealizedPnl: parseFloat(pos.unrealizedPnl),
          liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
          leverage,
        }
      }).filter(p => p.size !== 0)
    }, {
      maxAttempts: RETRY.exchangeMaxAttempts,
      initialDelayMs: RETRY.initialDelayMs,
      jitterFraction: RETRY.jitterFraction,
      shouldRetry: (err) => isRetryableExchangeError(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('exchange-service', `getPositions retry ${attempt}: ${msg} (backoff ${delayMs}ms)`)
      },
    })

    if (retryResult.success && retryResult.value) {
      health.recordSuccess('exchange')
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    log.error('exchange-service', `getPositions failed after ${retryResult.attempts} attempts: ${msg}`)
    health.recordError('exchange', msg)
    return []
  }

  /**
   * Aggregate executed size and VWAP for an entry order by cloid (userFills).
   * Used when the order rested before filling so {@link placeOrder} did not return inline `filled`.
   */
  async getFillAggregateByCloid(cloid: string, coin: string): Promise<{ avgPx: number; totalSz: number } | null> {
    this.ensureInit()
    try {
      await acquire()
      const fills = await info.userFills({
        user: this.accountAddress as `0x${string}`,
        aggregateByTime: false,
      })
      const matching = fills.filter(f => f.cloid === cloid && f.coin === coin)
      if (matching.length === 0) return null
      let totalSz = 0
      let notional = 0
      for (const f of matching) {
        const sz = Math.abs(parseFloat(f.sz))
        const px = parseFloat(f.px)
        if (sz <= 0 || !Number.isFinite(px)) continue
        totalSz += sz
        notional += sz * px
      }
      if (totalSz <= 0) return null
      return { avgPx: notional / totalSz, totalSz }
    } catch (err) {
      log.warn('exchange-service', `getFillAggregateByCloid failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  // ── Response Parsing ──────────────────────────────────────────────────────

  /** Parse a single order status from HL response. */
  private parseOrderStatus(
    status: { resting: { oid: number; cloid?: string } } | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } } | { error: string } | 'waitingForFill' | 'waitingForTrigger' | undefined,
  ): OrderResult {
    if (!status) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'No status in response' }
    }

    if (typeof status === 'string') {
      // "waitingForFill" or "waitingForTrigger"
      return { success: true, oid: null, avgPx: null, totalSz: null, status, error: null }
    }

    if ('resting' in status) {
      return { success: true, oid: status.resting.oid, avgPx: null, totalSz: null, status: 'resting', error: null }
    }

    if ('filled' in status) {
      return {
        success: true,
        oid: status.filled.oid,
        avgPx: parseFloat(status.filled.avgPx),
        totalSz: parseFloat(status.filled.totalSz),
        status: 'filled',
        error: null,
      }
    }

    if ('error' in status) {
      return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: status.error }
    }

    return { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'Unknown status format' }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: ExchangeService | null = null

/** Get or create the singleton ExchangeService. */
export function getExchangeService(): ExchangeService {
  if (!instance) {
    instance = new ExchangeService()
  }
  return instance
}

/** Reset ExchangeService (tests only). */
export function resetExchangeService(): void {
  instance = null
}
