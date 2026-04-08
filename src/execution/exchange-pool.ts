/**
 * Exchange Pool — shared ExchangeService factory (Sprint 4.5 S4/S10).
 *
 * Both HL and Bybit use a single shared wallet/account for all strategies:
 *   HL:  one shared HLExchangeService (Hyperliquid Vault main wallet)
 *   BB:  one shared BybitExchangeService (Bybit main wallet)
 *
 * All strategies route to the same shared instance — no per-strategy split.
 *
 * Design decisions:
 *   - S10: activeExchange read once in init(), cached — never per-get()
 */

import { ExchangeService, getExchangeService } from './exchange-service.js'
import { BybitExchangeService } from './bybit-exchange-service.js'
import {
  getActiveExchange,
  SIMULATED_ACCOUNT,
} from '../config.js'
import type { ExchangeId } from '../types.js'
import { log } from '../lib/logger.js'

/**
 * Union of all exchange service types managed by the pool.
 * Consumers that need HL-specific methods (getWalletAddress, reloadSymbols, etc.)
 * should narrow via instanceof ExchangeService check.
 */
export type IExchangeService = ExchangeService | BybitExchangeService

export class ExchangePool {
  /** Shared instance for all strategies. */
  private shared: IExchangeService | null = null

  /** Active exchange, read once in init() and cached. */
  private activeExchange: ExchangeId = 'HL'

  /** Whether init() completed successfully. */
  private initialized = false

  /** True after {@link init} succeeds. If false, {@link get} must not be called. */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Initialize the pool: create and init the shared exchange service instance.
   * Routes to HL or Bybit based on ACTIVE_EXCHANGE env.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    this.activeExchange = getActiveExchange()
    log.info('exchange-pool', `Active exchange: ${this.activeExchange}`)

    if (this.activeExchange === 'BB') {
      log.info('exchange-pool', 'Bybit single-wallet mode')
      const svc = new BybitExchangeService()
      await svc.init()
      this.shared = svc
    } else {
      log.info('exchange-pool', 'HL single-wallet mode')
      this.shared = new ExchangeService()
      await this.shared.init()
    }

    this.initialized = true
    log.info('exchange-pool', 'ExchangePool ready (shared wallet)')
  }

  /**
   * Get exchange service for a strategy.
   * Always returns the shared instance — all strategies share one wallet.
   *
   * @param strategyId Strategy identifier (e.g. 'layered', 'quant', 'smc-sd'). Ignored — kept for API compat.
   * @param exchange Override exchange for this lookup. Defaults to {@link activeExchange}.
   */
  get(_strategyId: string, exchange?: ExchangeId): IExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    const ex = exchange ?? this.activeExchange
    if (this.shared) return this.shared
    return this.getFallback(ex)
  }

  /**
   * Get ExchangeService for a strategy (typed as ExchangeService for backward compat).
   * Only valid when activeExchange === 'HL'. Throws if called in BB mode.
   * @deprecated Prefer {@link get} which returns IExchangeService.
   */
  getHL(strategyId: string): ExchangeService {
    const svc = this.get(strategyId, 'HL')
    if (!(svc instanceof ExchangeService)) {
      throw new Error(`ExchangePool.getHL: pool is not in HL mode (activeExchange=${this.activeExchange})`)
    }
    return svc
  }

  /** Get the shared instance. */
  getShared(): IExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    return this.shared!
  }

  /** Always false — single shared wallet, no dedicated per-strategy instances. */
  hasDedicatedWallet(_strategyId: string): boolean {
    return false
  }

  /** Always empty — no per-strategy instances. */
  getStrategyIds(): string[] {
    return []
  }

  /** Always false — single shared wallet for all strategies. */
  isMultiWallet(): boolean {
    return false
  }

  /** Active exchange cached at init(). */
  getActiveExchangeId(): ExchangeId {
    return this.activeExchange
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fallback when shared is null (pre-init compat, scripts, tests).
   * HL: returns singleton ExchangeService.
   * BB: throws — BB mode requires explicit init().
   */
  private getFallback(exchange: ExchangeId): IExchangeService {
    if (exchange === 'HL') return getExchangeService()
    throw new Error(`No BybitExchangeService initialized for exchange=${exchange}. Call ExchangePool.init() first.`)
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let poolInstance: ExchangePool | null = null

/** Get or create the singleton ExchangePool. */
export function getExchangePool(): ExchangePool {
  if (!poolInstance) {
    poolInstance = new ExchangePool()
  }
  return poolInstance
}

/** Reset ExchangePool (tests only). */
export function resetExchangePool(): void {
  poolInstance = null
}

/**
 * Cached effective balance (USD) for the main account.
 * Routes through {@link ExchangePool.get} when the pool is initialized; otherwise
 * falls back to the singleton {@link getExchangeService} (pre-init, tests, scripts).
 */
export function getCachedAccountValueForStrategy(strategyId: string): number {
  try {
    const svc = getExchangePool().get(strategyId)
    return svc.getCachedAccountValue() || SIMULATED_ACCOUNT
  } catch {
    return getExchangeService().getCachedAccountValue() || SIMULATED_ACCOUNT
  }
}
