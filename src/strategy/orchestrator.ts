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
  StrategyContext,
} from '../types.js'
import { appendCandle, getCandles } from '../feed/store.js'
import { getStrategyRegistry, type StrategyRegistry } from './registry.js'
import { clearQuantState } from './strategies/quant/pipeline.js'
import { computeExpiresAtBar, setupId } from './shared/invalidation.js'
import { getOrCreateStats, resetPipelineStats } from './diagnostics.js'
import { detectRegime } from '../indicators/core.js'
import { determineBias } from './strategies/layered/layers/bias.js'
import { findPivots } from '../indicators/smc.js'
import {
  MIN_CANDLES_FOR_SCAN,
  INDICATOR_WINDOW,
  TIMEFRAMES,
  SIGNAL_TIMEFRAMES,
  HTF_MAP,
  getActiveExchange,
  getEffectivePaperTrade,
  PAPER_WALLET_STRATEGY_IDS,
} from '../config.js'
import { getPaperTracker } from '../agent/paper-tracker.js'
import { log } from '../lib/logger.js'
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

/**
 * Run all strategies on the last fully closed bar (idx = length - 2), same as WS path.
 * Used after REST/PG backfill so bias/status/setups appear without waiting for the next TF close.
 */
function dispatchClosedBarScan(coin: string, interval: CandleInterval, registry: StrategyRegistry): void {
  const maxMin = Math.max(INDICATOR_WINDOW, ...registry.getAll().map(s => s.minCandles()))
  const activeExchange = getActiveExchange()
  const candles = getCandles(coin, interval, maxMin + 2)
  if (candles.length < MIN_CANDLES_FOR_SCAN + 1) return

  const idx = candles.length - 2

  // Build HTF context for ICT top-down analysis (SMC-SD uses this)
  const htfInterval = HTF_MAP[interval]
  const htfCandles = htfInterval !== interval ? getCandles(coin, htfInterval, Math.max(maxMin + 2, INDICATOR_WINDOW)) : []
  let context: StrategyContext | undefined
  if (htfInterval !== interval && htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
    context = { htfCandles, htfInterval }
  }

  // Update statusState with regime/bias so TUI watchlist shows data regardless of which strategy is active.
  const sk = `${coin}|${interval}`
  const confirmedSlice = candles.slice(0, idx + 1)
  const regime = detectRegime(confirmedSlice, idx)
  const pivots = findPivots(confirmedSlice, idx, 3)
  const bias = determineBias(confirmedSlice, idx, htfCandles, pivots)
  const activeCount = Array.from(activeSetups.values()).filter(s => s.coin === coin && s.interval === interval).length
  statusState.set(sk, {
    coin,
    interval,
    regime,
    bias: bias?.bias ?? 'neutral',
    biasConfidence: bias?.confidence ?? 0,
    confluenceGrade: null,
    activeCount,
    lastUpdateAt: Date.now(),
  })

  const signalResults = registry.runAll(coin, interval, candles, idx, context)

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
      exchange: activeExchange,
    }
    activeSetups.set(id, setup)
    const stats = getOrCreateStats(strategyId)
    stats.setupsTracked++
    pipelineEmitter.emit('setup', setup)

    // Promote confluenceGrade in statusState when a setup is detected
    const existing = statusState.get(sk)
    if (existing && signal.confluenceGrade) {
      statusState.set(sk, { ...existing, confluenceGrade: signal.confluenceGrade, activeCount: existing.activeCount + 1 })
    }

    const rrRaw = Math.abs(signal.tpPrice - signal.entryPrice) / Math.abs(signal.entryPrice - signal.slPrice)
    const rr = isNaN(rrRaw) ? 0 : rrRaw
    const grade = signal.confluenceGrade ?? 'C'
    const count = signal.confluenceCount ?? 0
    const regime = signal.patternData['regime'] as string | undefined
    const zoneOrigin = signal.patternData['zoneOrigin'] as string | undefined
    log.info('pipeline',
      `⚡ SETUP | ${coin} ${interval.toUpperCase()} [${activeExchange}] | ${signal.side.toUpperCase()} ${signal.type}${zoneOrigin ? ` at ${zoneOrigin}` : ''} | ` +
      `${grade} (${count}/7) | conf:${signal.confidence.toFixed(2)}${regime ? ` | ${regime}` : ''} | ` +
      `entry:${fmtP(signal.entryPrice)} sl:${fmtP(signal.slPrice)} tp:${fmtP(signal.tpPrice)} | R:R 1:${rr.toFixed(2)} | ` +
      `ttl:${setup.expiresAtBar - setup.detectedAtBar}bars | [${strategyId}]`,
    )
  }
}

function fmtP(n: number): string {
  return n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(2) : n.toFixed(4)
}

/** Seed WS dedup map so the first live tick matches `prevTs === candle.t` for the current bar. */
function seedLastCandleTsFromStore(coin: string, interval: CandleInterval): void {
  const sk = `${coin}|${interval}`
  const candles = getCandles(coin, interval, 2)
  if (candles.length === 0) return
  lastCandleTs.set(sk, candles[candles.length - 1].t)
}

/**
 * After backfill: run one scan per coin/TF (except 1m) and seed lastCandleTs from store.
 * Call only after StrategyRegistry is populated (and after agent subscribes if setups must be handled).
 */
export function bootstrapPipelineFromStore(coins: readonly string[]): void {
  const registry = getStrategyRegistry()
  if (registry.getAll().length === 0) {
    log.warn('pipeline', 'bootstrapPipelineFromStore: no strategies registered — skipping')
    return
  }
  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval
      if ((SIGNAL_TIMEFRAMES as readonly string[]).includes(interval)) {
        dispatchClosedBarScan(coin, interval, registry)
      }
      seedLastCandleTsFromStore(coin, interval)
    }
  }
  log.info('pipeline', `Bootstrap scan + WS seed | ${coins.length} coin(s) × ${TIMEFRAMES.length} TF`)
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Called by WS subscription on every candle tick. Dispatches to all registered strategies. */
export function onCandleTick(
  coin: string,
  interval: CandleInterval,
  candle: Candle,
): void {
  // Always store latest candle data
  appendCandle(coin, interval, candle)

  // ── Paper mode: evaluate multi-TP exits on every candle tick ───────────
  // Mirrors backtest bar-by-bar evaluation — check SL/TP/trailing on each candle.
  if (getEffectivePaperTrade()) {
    for (const stratId of PAPER_WALLET_STRATEGY_IDS) {
      const result = getPaperTracker(stratId).checkCandle(coin, interval, candle)
      if (result && result.action === 'full_close') {
        pipelineEmitter.emit('paper_exit', {
          coin, strategyId: stratId,
          exitReason: result.exitReason,
          closePrice: result.closePrice,
          pnl: result.pnl,
        })
      }
    }
  }

  // ── Closed-candle gate ──────────────────────────────────────────────────
  const sk = `${coin}|${interval}`
  const prevTs = lastCandleTs.get(sk)

  if (prevTs === candle.t) return  // same candle still forming
  lastCandleTs.set(sk, candle.t)

  // First tick for this coin/tf — no previous closed candle yet
  if (prevTs === undefined) return

  // Non-signal TFs: store candles only (e.g. 1m for entry refinement / price proxy)
  if (!(SIGNAL_TIMEFRAMES as readonly string[]).includes(interval)) return

  dispatchClosedBarScan(coin, interval, getStrategyRegistry())
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
  // Setup keys are "strategyId:coin|interval|type" — match ":coin|" anywhere in key
  const setupNeedle = `:${coin}|`
  for (const k of activeSetups.keys()) { if (k.includes(setupNeedle)) activeSetups.delete(k) }
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

/** Clear layered pipeline state only (not quant/smc-sd). Used by LayeredStrategyAdapter. */
export function clearLayeredState(): void {
  // Only delete setups belonging to the layered strategy
  for (const k of activeSetups.keys()) {
    if (k.startsWith('layered:')) activeSetups.delete(k)
  }
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
