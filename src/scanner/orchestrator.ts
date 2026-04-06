/**
 * Pipeline orchestrator — module-level state + WS tick dispatch.
 *
 * onCandleTick: closed-candle gate → fan-out to StrategyRegistry.
 * Owns: activeSetups, lastCandleTs, statusState, pipelineEmitter.
 */

import type {
  Candle,
  CandleInterval,
  ActiveSetup,
  ConfluenceGrade,
  MarketRegime,
} from '../types.js'
import { appendCandle, getCandles } from '../feed/store.js'
import { getStrategyRegistry } from './strategy.js'
import { clearQuantState } from './strategies/quant/pipeline.js'
import { computeExpiresAtBar, setupId } from './shared/invalidation.js'
import { getOrCreateStats, resetPipelineStats } from './diagnostics.js'
import {
  MIN_CANDLES_FOR_SCAN,
  INDICATOR_WINDOW,
} from '../config.js'
import { EventEmitter } from 'events'

// ── Module-level state ──────────────────────────────────────────────────────

const activeSetups = new Map<string, ActiveSetup>()

/**
 * Pipeline EventEmitter (R10).
 * Emits 'setup' when a new setup is tracked, 'invalidation' when one is removed.
 * Agent subscribes via getPipelineEmitter().
 */
const pipelineEmitter = new EventEmitter()

/** Get the pipeline event emitter for agent subscription. */
export function getPipelineEmitter(): EventEmitter {
  return pipelineEmitter
}

const lastCandleTs = new Map<string, number>()

export interface StatusSnapshot {
  coin: string
  interval: CandleInterval
  regime: MarketRegime
  bias: string
  biasConfidence: number
  confluenceGrade: ConfluenceGrade | null
  activeCount: number
  lastUpdateAt: number
}

const statusState = new Map<string, StatusSnapshot>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Called by WS subscription on every candle tick. Dispatches to all registered strategies. */
export function onCandleTick(
  coin: string,
  interval: CandleInterval,
  candle: Candle,
): void {
  // Always store latest candle data
  appendCandle(coin, interval, candle)

  // ── Closed-candle gate ──────────────────────────────────────────────────
  const sk = `${coin}|${interval}`
  const prevTs = lastCandleTs.get(sk)

  if (prevTs === candle.t) return  // same candle still forming
  lastCandleTs.set(sk, candle.t)

  // First tick for this coin/tf — no previous closed candle yet
  if (prevTs === undefined) return

  // 1m: store candles for entry refinement only, skip signal scan
  if (interval === '1m') return

  // Fan-out to all registered strategies via StrategyRegistry
  const registry = getStrategyRegistry()
  // Fetch enough candles for the most demanding strategy (+2 for closed-candle idx)
  const maxMin = Math.max(INDICATOR_WINDOW, ...registry.getAll().map(s => s.minCandles()))
  const candles = getCandles(coin, interval, maxMin + 2)
  if (candles.length < MIN_CANDLES_FOR_SCAN + 1) return

  const idx = candles.length - 2
  const signalResults = registry.runAll(coin, interval, candles, idx)

  // Handle modern strategies that return Signal directly (not legacy emit pattern)
  for (const { strategyId, signal } of signalResults) {
    const id = setupId(coin, interval, signal.type, strategyId)
    const setup: ActiveSetup = {
      ...signal,
      id,
      coin,
      interval,
      strategyId,
      detectedAt: Date.now(),
      detectedAtBar: idx,
      expiresAtBar: computeExpiresAtBar(signal.type, idx),
    }
    activeSetups.set(id, setup)
    const stats = getOrCreateStats(strategyId)
    stats.setupsTracked++
    pipelineEmitter.emit('setup', setup)
  }
}

/** Get current status snapshots for all coin/tf combinations. */
export function getStatus(): StatusSnapshot[] {
  return Array.from(statusState.values())
}

/** Get all currently active setups. */
export function getActiveSetups(): ActiveSetup[] {
  return Array.from(activeSetups.values())
}

/** Get unique list of coins that have at least one active setup. */
export function getActiveSetupCoins(): string[] {
  const coins = new Set<string>()
  for (const setup of activeSetups.values()) {
    coins.add(setup.coin)
  }
  return Array.from(coins)
}

/** Clear state for a specific coin (all timeframes). */
export function clearCoinState(coin: string): void {
  const prefix = `${coin}|`
  for (const k of activeSetups.keys()) { if (k.startsWith(prefix)) activeSetups.delete(k) }
  for (const k of statusState.keys()) { if (k.startsWith(prefix)) statusState.delete(k) }
  for (const k of lastCandleTs.keys()) { if (k.startsWith(prefix)) lastCandleTs.delete(k) }
}

/**
 * Clear pipeline state. If strategyId given, clear only that strategy's stats.
 * Without strategyId, clears everything (all setups, status, timestamps, stats, quant state).
 */
export function clearPipelineState(strategyId?: string): void {
  if (strategyId) {
    // Granular: clear only setups belonging to this strategy + its stats
    for (const [id] of activeSetups) {
      if (id.startsWith(`${strategyId}:`)) activeSetups.delete(id)
    }
    resetPipelineStats(strategyId)
    if (strategyId === 'quant') clearQuantState()
  } else {
    // Full clear
    activeSetups.clear()
    statusState.clear()
    lastCandleTs.clear()
    resetPipelineStats()
    clearQuantState()
  }
}

// ── Aliases for StrategyRegistry adapter (Sprint 4.5) ────────────────────────

/** Clear layered pipeline state only (not quant). Used by LayeredStrategyAdapter. */
export function clearLayeredState(): void {
  activeSetups.clear()
  statusState.clear()
  lastCandleTs.clear()
  resetPipelineStats('layered')
}

// ── Internals used by pipeline.ts ────────────────────────────────────────────

/** Get the mutable statusState map (for pipeline.ts to update during runPipeline). */
export function getStatusState(): Map<string, StatusSnapshot> {
  return statusState
}

/** Get the mutable activeSetups map (for pipeline.ts to read/write during runPipeline). */
export function getActiveSetupsMap(): Map<string, ActiveSetup> {
  return activeSetups
}
