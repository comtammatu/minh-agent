/**
 * Exchange Pool — per-strategy ExchangeService factory (Sprint 4.5 S4).
 *
 * Creates and manages separate ExchangeService instances per strategy,
 * each with its own agent wallet for signing orders.
 *
 * Modes:
 *   - Multi-wallet: STRATEGY_WALLETS env set → one ExchangeService per strategy
 *   - Single-wallet (fallback): no env → shared ExchangeService for all strategies
 *
 * Design decisions:
 *   - E25: Constructor injection with optional WalletConfig
 *   - V3: Agent wallet per strategy (software-enforced capital allocation)
 *   - V5: Feature flag via STRATEGY_WALLETS env — no env = single wallet mode
 */

import { ExchangeService } from './exchange-service.js'
import { parseStrategyWallets, type WalletConfig } from '../config.js'
import { log } from '../lib/logger.js'

export class ExchangePool {
  /** Per-strategy ExchangeService instances. */
  private instances = new Map<string, ExchangeService>()

  /** Shared fallback instance (single-wallet mode or unknown strategyId). */
  private shared: ExchangeService | null = null

  /** Wallet configs parsed from STRATEGY_WALLETS env. */
  private walletConfigs: Map<string, WalletConfig>

  /** Whether init() has been called. */
  private initialized = false

  constructor() {
    this.walletConfigs = parseStrategyWallets()
  }

  /**
   * Initialize the pool: create and init all ExchangeService instances.
   * Eager init — fail-fast if any wallet key is invalid.
   *
   * Multi-wallet mode: creates per-strategy instances from STRATEGY_WALLETS.
   * Single-wallet mode: creates one shared instance from PRIVATE_KEY env.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    if (this.walletConfigs.size === 0) {
      // Single-wallet fallback: one shared instance for all strategies
      log.info('exchange-pool', 'Single-wallet mode (no STRATEGY_WALLETS env)')
      this.shared = new ExchangeService()
      await this.shared.init()
    } else {
      // Multi-wallet mode: per-strategy instances
      log.info('exchange-pool', `Multi-wallet mode: ${this.walletConfigs.size} strategy wallets configured`)

      // Also create a shared fallback from env (for unknown strategyIds)
      this.shared = new ExchangeService()
      await this.shared.init()

      for (const [strategyId, config] of this.walletConfigs) {
        const svc = new ExchangeService(config)
        await svc.init()
        this.instances.set(strategyId, svc)
        log.info('exchange-pool', `Initialized wallet for strategy "${strategyId}": ${svc.getWalletAddress().slice(0, 6)}...${svc.getWalletAddress().slice(-4)}`)
      }
    }

    this.initialized = true
    log.info('exchange-pool', `ExchangePool ready (${this.instances.size} strategy instances + shared fallback)`)
  }

  /**
   * Get ExchangeService for a strategy.
   * Returns the per-strategy instance if configured, otherwise the shared fallback.
   */
  get(strategyId: string): ExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    return this.instances.get(strategyId) ?? this.shared!
  }

  /** Get the shared fallback instance. */
  getShared(): ExchangeService {
    if (!this.initialized) {
      throw new Error('ExchangePool not initialized — call init() first')
    }
    return this.shared!
  }

  /** Check if a strategy has a dedicated wallet (not using shared fallback). */
  hasDedicatedWallet(strategyId: string): boolean {
    return this.instances.has(strategyId)
  }

  /** Get all registered strategy IDs with dedicated wallets. */
  getStrategyIds(): string[] {
    return [...this.instances.keys()]
  }

  /** Whether the pool is in multi-wallet mode. */
  isMultiWallet(): boolean {
    return this.walletConfigs.size > 0
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
