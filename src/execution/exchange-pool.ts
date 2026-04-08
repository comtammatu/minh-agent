/**
 * Exchange Pool — per-strategy ExchangeService factory (Sprint 4.5 S4/S10).
 *
 * Creates and manages separate exchange service instances per strategy,
 * each with its own wallet/API credentials for signing orders.
 *
 * Modes:
 *   HL multi-wallet: STRATEGY_WALLETS env set → one HLExchangeService per strategy
 *   HL single-wallet (fallback): no env → shared HLExchangeService for all strategies
 *   BB multi-key: BYBIT_STRATEGY_KEYS env set → one BybitExchangeService per strategy
 *   BB single-key (fallback): no env → shared BybitExchangeService for all strategies
 *
 * Pool key format: "<exchangeId>:<strategyId>" e.g. "HL:layered", "BB:quant"
 *
 * Design decisions:
 *   - E25: Constructor injection with optional WalletConfig / API credentials
 *   - V3: Agent wallet per strategy (software-enforced capital allocation)
 *   - V5: Feature flag via STRATEGY_WALLETS / BYBIT_STRATEGY_KEYS env — no env = single mode
 *   - S10: activeExchange read once in init(), cached — never per-get()
 */

import { ExchangeService, getExchangeService } from './exchange-service.js'
import { HLExchangeService } from './hl-exchange-service.js'
import { BybitExchangeService } from './bybit-exchange-service.js'
import {
  parseStrategyWallets,
  parseBybitStrategyKeys,
  getActiveExchange,
  SIMULATED_ACCOUNT,
  type WalletConfig,
} from '../config.js'
import type { ExchangeId } from '../types.js'
import { log } from '../lib/logger.js'

/** Order used when creating multi-wallet instances and when picking shared fallback without PRIVATE_KEY env. */
const MULTI_WALLET_STRATEGY_ORDER = ['layered', 'quant', 'smc-sd'] as const

/**
 * Union of all exchange service types managed by the pool.
 * Consumers that need HL-specific methods (getWalletAddress, reloadSymbols, etc.)
 * should narrow via instanceof ExchangeService check.
 */
export type IExchangeService = ExchangeService | BybitExchangeService

export class ExchangePool {
  /** Per-strategy exchange instances, keyed as "<exchangeId>:<strategyId>". */
  private instances = new Map<string, IExchangeService>()

  /** Shared fallback instance (single-wallet/key mode or unknown strategyId). */
  private shared: IExchangeService | null = null

  /** Wallet configs parsed from STRATEGY_WALLETS env (HL only). */
  private walletConfigs: Map<string, WalletConfig>

  /** Active exchange, read once in init() and cached. */
  private activeExchange: ExchangeId = 'HL'

  /** Whether init() completed successfully. */
  private initialized = false

  constructor() {
    this.walletConfigs = parseStrategyWallets()
  }

  /** True after {@link init} succeeds. If false, {@link get} must not be called. */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Initialize the pool: create and init all exchange service instances.
   * Eager init — fail-fast if any wallet key or API credential is invalid.
   *
   * Routes to initHL() or initBybit() based on ACTIVE_EXCHANGE env.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    this.activeExchange = getActiveExchange()
    log.info('exchange-pool', `Active exchange: ${this.activeExchange}`)

    if (this.activeExchange === 'BB') {
      await this.initBybit()
    } else {
      await this.initHL()
    }

    this.initialized = true
    log.info('exchange-pool', `ExchangePool ready (${this.instances.size} strategy instances + shared fallback)`)
  }

  /**
   * Initialize HL exchange services (existing logic, unchanged).
   * Multi-wallet mode: creates per-strategy instances from STRATEGY_WALLETS.
   * Single-wallet mode: creates one shared instance from PRIVATE_KEY env.
   */
  private async initHL(): Promise<void> {
    if (this.walletConfigs.size === 0) {
      // Single-wallet fallback: one shared instance for all strategies
      log.info('exchange-pool', 'HL single-wallet mode (no STRATEGY_WALLETS env)')
      this.shared = new ExchangeService()
      await this.shared.init()
      return
    }

    // Multi-wallet mode: per-strategy instances
    log.info('exchange-pool', `HL multi-wallet mode: ${this.walletConfigs.size} strategy wallets configured`)

    const seen = new Set<string>()
    for (const strategyId of MULTI_WALLET_STRATEGY_ORDER) {
      const config = this.walletConfigs.get(strategyId)
      if (!config) continue
      const svc = new ExchangeService(config)
      await svc.init()
      this.instances.set(this.poolKey('HL', strategyId), svc)
      seen.add(strategyId)
      log.info('exchange-pool', `HL wallet for "${strategyId}": ${svc.getWalletAddress().slice(0, 6)}...${svc.getWalletAddress().slice(-4)}`)
    }
    for (const [strategyId, config] of this.walletConfigs) {
      if (seen.has(strategyId)) continue
      const svc = new ExchangeService(config)
      await svc.init()
      this.instances.set(this.poolKey('HL', strategyId), svc)
      log.info('exchange-pool', `HL wallet for "${strategyId}": ${svc.getWalletAddress().slice(0, 6)}...${svc.getWalletAddress().slice(-4)}`)
    }

    const envPk = process.env['PRIVATE_KEY']?.trim()
    if (envPk) {
      // Optional: separate signing key for unknown strategyIds / startup getShared()
      this.shared = new ExchangeService()
      await this.shared.init()
    } else {
      this.shared = this.pickSharedFromStrategyInstances()
      const hlShared = this.shared as HLExchangeService
      log.info(
        'exchange-pool',
        `HL shared fallback: reusing strategy wallet (${hlShared.getWalletAddress().slice(0, 6)}...) — set PRIVATE_KEY for distinct fallback`,
      )
    }
  }

  /**
   * Initialize Bybit exchange services.
   * Multi-key mode: BYBIT_STRATEGY_KEYS set → one BybitExchangeService per strategy.
   * Single-key mode: no env → shared BybitExchangeService for all strategies.
   */
  private async initBybit(): Promise<void> {
    const strategyKeys = parseBybitStrategyKeys()
    if (strategyKeys.size === 0) {
      // Single shared instance
      log.info('exchange-pool', 'Bybit single-key mode')
      const svc = new BybitExchangeService()
      await svc.init()
      this.shared = svc
      return
    }
    // Per-strategy instances
    log.info('exchange-pool', `Bybit multi-key mode: ${strategyKeys.size} strategy keys configured`)
    for (const [strategyId, { apiKey, apiSecret }] of strategyKeys) {
      const svc = new BybitExchangeService(apiKey, apiSecret)
      await svc.init()
      this.instances.set(this.poolKey('BB', strategyId), svc)
      log.info('exchange-pool', `Bybit key for "${strategyId}": ${apiKey.slice(0, 4)}...`)
    }
    // Shared fallback: reuse first strategy instance
    const first = this.instances.values().next().value as IExchangeService | undefined
    if (first) {
      this.shared = first
    }
  }

  /**
   * Get exchange service for a strategy.
   *
   * @param strategyId Strategy identifier (e.g. 'layered', 'quant', 'smc-sd').
   * @param exchange Override exchange for this lookup. Defaults to {@link activeExchange}.
   * @returns Per-strategy instance if configured, otherwise the shared fallback.
   */
  get(strategyId: string, exchange?: ExchangeId): IExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    const ex = exchange ?? this.activeExchange
    const key = this.poolKey(ex, strategyId)
    const instance = this.instances.get(key) ?? this.shared
    if (!instance) {
      return this.getFallback(ex)
    }
    return instance
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

  /** Get the shared fallback instance. */
  getShared(): IExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    return this.shared!
  }

  /** Check if a strategy has a dedicated wallet/key (not using shared fallback). */
  hasDedicatedWallet(strategyId: string): boolean {
    const key = this.poolKey(this.activeExchange, strategyId)
    return this.instances.has(key)
  }

  /** Get all registered strategy IDs with dedicated wallets/keys. */
  getStrategyIds(): string[] {
    const prefix = `${this.activeExchange}:`
    return [...this.instances.keys()]
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))
  }

  /** Whether the pool is in multi-wallet/key mode. */
  isMultiWallet(): boolean {
    return this.walletConfigs.size > 0 || parseBybitStrategyKeys().size > 0
  }

  /** Active exchange cached at init(). */
  getActiveExchangeId(): ExchangeId {
    return this.activeExchange
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Build pool key: "<exchangeId>:<strategyId>" */
  private poolKey(exchangeId: ExchangeId, strategyId: string): string {
    return `${exchangeId}:${strategyId}`
  }

  /**
   * Fallback when no instance found.
   * HL: returns singleton ExchangeService (pre-pool compat, scripts, tests).
   * BB: throws — BB mode requires explicit init().
   */
  private getFallback(exchange: ExchangeId): IExchangeService {
    if (exchange === 'HL') return getExchangeService()
    throw new Error(`No BybitExchangeService initialized for exchange=${exchange}. Call ExchangePool.init() first.`)
  }

  /**
   * When PRIVATE_KEY is unset, unknown strategyIds route to the first configured wallet
   * in {@link MULTI_WALLET_STRATEGY_ORDER}, else the first entry in the map.
   */
  private pickSharedFromStrategyInstances(): ExchangeService {
    for (const id of MULTI_WALLET_STRATEGY_ORDER) {
      const inst = this.instances.get(this.poolKey('HL', id))
      if (inst instanceof ExchangeService) return inst
    }
    for (const inst of this.instances.values()) {
      if (inst instanceof ExchangeService) return inst
    }
    throw new Error('ExchangePool HL multi-wallet mode: no strategy wallet instances created')
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
 * Cached effective balance (USD) for the main account used by a strategy's wallet.
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
