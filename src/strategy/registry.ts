/**
 * Strategy interface + registry — Sprint 4.5 multi-strategy architecture.
 *
 * Design:
 *   - IStrategy: pure scan contract. Zero I/O. Each strategy implements this.
 *   - StrategyRegistry: fan-out dispatcher. Calls all registered strategies per tick.
 *   - Adapters wrap existing pipelines (layered, quant) without rewriting them.
 *
 * Architecture:
 *   Feed → onCandleTick() → registry.runAll() ──┬─→ LayeredAdapter.scan()
 *                                                ├─→ QuantAdapter.scan()
 *                                                └─→ Future strategies...
 *                                                         ↓
 *                                              emitter.emit('setup', {strategyId})
 */

import type { Candle, CandleInterval, Signal, PatternType, StrategyContext } from '../types.js'
import { log } from '../lib/logger.js'

// ─── IStrategy Interface ────────────────────────────────────────────────────

/**
 * Pure strategy contract. All strategies implement this interface.
 *
 * Rules:
 *   - scan() is pure: zero I/O, no side effects beyond module-level dedup state
 *   - scan() returns Signal | null — registry handles emit + tracking
 *   - minCandles() tells registry how many candles to fetch
 *   - clearState() resets module-level state (for backtest isolation)
 */
export interface IStrategy {
  /** Unique strategy identifier. Used as DB strategy_id, Map key, env config key. */
  readonly id: string

  /** Human-readable display name for dashboard/telegram. */
  readonly name: string

  /** Pattern types this strategy can emit. Used for invalidation routing. */
  readonly patternTypes: ReadonlyArray<PatternType>

  /**
   * Pure scan function. Called once per closed candle per coin/interval.
   * Returns Signal if entry conditions met, null otherwise.
   *
   * Adapters for existing pipelines (layered, quant) handle emit internally
   * and return null — they use the legacy void-return pattern.
   * New strategies should return Signal for registry-managed emit.
   */
  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null

  /** Minimum candles needed before scan() produces valid results. */
  minCandles(): number

  /** Clear any module-level mutable state (dedup maps, etc.). Called by backtest reset. */
  clearState(): void
}

// ─── StrategyRegistry ───────────────────────────────────────────────────────

/**
 * Registry of all trading strategies. Manages registration, fan-out, and lifecycle.
 *
 * State:
 *   strategies: Map<id, IStrategy>       — all registered strategies
 *   enabled:    Map<id, boolean>         — per-strategy enable/disable
 *   activeOnly: string | null            — if set, runAll() only runs this strategy (backtest isolation)
 */
export class StrategyRegistry {
  private strategies = new Map<string, IStrategy>()
  private enabled = new Map<string, boolean>()
  private activeOnly: string | null = null

  /** Register a strategy. Rejects duplicate IDs. */
  register(strategy: IStrategy): void {
    if (this.strategies.has(strategy.id)) {
      throw new Error(`Strategy '${strategy.id}' already registered`)
    }
    this.strategies.set(strategy.id, strategy)
    this.enabled.set(strategy.id, true)
  }

  /** Get all registered strategies. */
  getAll(): IStrategy[] {
    return Array.from(this.strategies.values())
  }

  /** Get a strategy by ID. */
  get(id: string): IStrategy | undefined {
    return this.strategies.get(id)
  }

  /** Get all enabled strategy IDs. */
  getEnabledIds(): string[] {
    return Array.from(this.enabled.entries())
      .filter(([, v]) => v)
      .map(([k]) => k)
  }

  /** Check if a strategy is enabled. */
  isEnabled(id: string): boolean {
    return this.enabled.get(id) ?? false
  }

  /**
   * Enable a strategy.
   * @throws if strategy not registered
   */
  enable(id: string): void {
    if (!this.strategies.has(id)) {
      throw new Error(`Strategy '${id}' not registered`)
    }
    this.enabled.set(id, true)
  }

  /**
   * Disable a strategy.
   * Does NOT close open positions — caller must verify no open positions first (E30).
   * @throws if strategy not registered
   */
  disable(id: string): void {
    if (!this.strategies.has(id)) {
      throw new Error(`Strategy '${id}' not registered`)
    }
    this.enabled.set(id, false)
  }

  /**
   * Backtest isolation: only run this strategy during runAll().
   * Pass null to restore fan-out to all enabled strategies.
   */
  activateOnly(id: string | null): void {
    if (id !== null && !this.strategies.has(id)) {
      throw new Error(`Strategy '${id}' not registered`)
    }
    this.activeOnly = id
  }

  /**
   * Fan-out: run all enabled strategies on this tick.
   * Each strategy's scan() is wrapped in try/catch — one strategy throwing
   * does not block others (error isolation per E26).
   *
   * Returns array of (strategyId, Signal) pairs for strategies that returned
   * a non-null Signal. Adapters for legacy pipelines emit internally and
   * return null — they won't appear in the return value.
   */
  runAll(
    coin: string,
    interval: CandleInterval,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
  ): Array<{ strategyId: string; signal: Signal }> {
    const results: Array<{ strategyId: string; signal: Signal }> = []

    for (const [id, strategy] of this.strategies) {
      // Skip disabled strategies (unless activeOnly overrides)
      if (this.activeOnly !== null) {
        if (id !== this.activeOnly) continue
      } else if (!this.enabled.get(id)) {
        continue
      }

      // Skip if not enough candles for this strategy
      if (candles.length < strategy.minCandles()) continue

      try {
        const signal = strategy.scan(coin, interval, candles, idx, context)
        if (signal !== null) {
          results.push({ strategyId: id, signal })
        }
      } catch (err) {
        // Error isolation: log and continue. One strategy failure does not block others.
        log.error('strategy', `'${id}' threw during scan(${coin}, ${interval}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return results
  }

  /** Clear all strategies' module-level state. Used by backtest reset. */
  clearAllState(): void {
    for (const strategy of this.strategies.values()) {
      strategy.clearState()
    }
    this.activeOnly = null
  }

  /** Number of registered strategies. */
  get size(): number {
    return this.strategies.size
  }
}

// ─── Singleton Registry ─────────────────────────────────────────────────────

let registry: StrategyRegistry | null = null

/** Get or create the singleton StrategyRegistry. */
export function getStrategyRegistry(): StrategyRegistry {
  if (!registry) {
    registry = new StrategyRegistry()
  }
  return registry
}

/** Reset registry (tests only). */
export function resetStrategyRegistry(): void {
  registry = null
}
