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
  DecisionTrace,
} from '../types.js'
import { appendCandle, getCandles, getCandlesInto } from '../feed/store.js'
import { getStrategyRegistry, type StrategyRegistry } from './registry.js'
import { computeExpiresAtBar, setupId } from './shared/invalidation.js'
import { getOrCreateStats, resetPipelineStats } from './diagnostics.js'
import { determineBias } from './shared/bias.js'
import {
  clearIndicatorCache,
  clearIndicatorCacheForCoin,
  getCachedPivots3,
  getCachedRegime,
  getCachedStructureBreaks,
  getCachedWyckoff,
} from './shared/indicator-cache.js'
import {
  MIN_CANDLES_FOR_SCAN,
  INDICATOR_WINDOW,
  TIMEFRAMES,
  SIGNAL_TIMEFRAMES,
  HTF_MAP,
  TIMEFRAME_MS,
  STATUS_UPDATE_EVERY_BARS,
  getActiveExchange,
  getEffectivePaperTrade,
  PAPER_WALLET_STRATEGY_IDS,
} from '../config.js'
import type { StrategyParams } from '../backtest/types.js'
import { getPaperTracker } from '../agent/paper-tracker.js'
import { log } from '../lib/logger.js'
import { EventEmitter } from 'events'

// ── Module-level state ──────────────────────────────────────────────────────

/** Per-trial strategy params set by backtest engine. null = live trading (use config.ts defaults). */
let activeStrategyParams: StrategyParams | null = null

/** Set active strategy params (called by backtest engine before/after run). */
export function setActiveStrategyParams(params: StrategyParams | null): void {
  activeStrategyParams = params
}

/** Get active strategy params (for testing). */
export function getActiveStrategyParams(): StrategyParams | null {
  return activeStrategyParams
}

const activeSetups = new Map<string, ActiveSetup>()
const activeSetupCounts = new Map<string, number>()
const lastStatusUpdateBarClock = new Map<string, number>()
const statusRefreshCounts = new Map<string, number>()
const scanCandlesBuffers = new Map<string, Candle[]>()
const htfCandlesBuffers = new Map<string, Candle[]>()

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

function statusKey(coin: string, interval: CandleInterval): string {
  return `${coin}|${interval}`
}

function setupCountKey(setup: ActiveSetup): string {
  return statusKey(setup.coin, setup.interval)
}

function incrementActiveSetupCount(key: string): void {
  activeSetupCounts.set(key, (activeSetupCounts.get(key) ?? 0) + 1)
}

function decrementActiveSetupCount(key: string): void {
  const next = (activeSetupCounts.get(key) ?? 0) - 1
  if (next <= 0) {
    activeSetupCounts.delete(key)
    return
  }
  activeSetupCounts.set(key, next)
}

function activeSetupCount(coin: string, interval: CandleInterval): number {
  return activeSetupCounts.get(statusKey(coin, interval)) ?? 0
}

function removeSetupById(id: string): void {
  const existing = activeSetups.get(id)
  if (!existing) return
  activeSetups.delete(id)
  decrementActiveSetupCount(setupCountKey(existing))
}

function requiredScanWindow(registry: StrategyRegistry): number {
  return Math.max(INDICATOR_WINDOW, registry.getMaxRunnableMinCandles())
}

function getOrCreateScanBuffer(coin: string, interval: CandleInterval): Candle[] {
  const sk = statusKey(coin, interval)
  let buf = scanCandlesBuffers.get(sk)
  if (!buf) {
    buf = []
    scanCandlesBuffers.set(sk, buf)
  }
  return buf
}

function getOrCreateHtfBuffer(coin: string, interval: CandleInterval): Candle[] {
  const sk = statusKey(coin, interval)
  let buf = htfCandlesBuffers.get(sk)
  if (!buf) {
    buf = []
    htfCandlesBuffers.set(sk, buf)
  }
  return buf
}

function barClockFor(timestampMs: number, interval: CandleInterval): number {
  return Math.floor(timestampMs / TIMEFRAME_MS[interval])
}

function shouldRefreshStatus(sk: string, interval: CandleInterval, barClock: number): boolean {
  const prev = lastStatusUpdateBarClock.get(sk)
  if (prev === undefined) return true
  return barClock - prev >= STATUS_UPDATE_EVERY_BARS[interval]
}

function refreshStatusSnapshot(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  htfCandles: Candle[],
): void {
  const sk = statusKey(coin, interval)
  const barClock = barClockFor(candles[idx]!.t, interval)
  if (!shouldRefreshStatus(sk, interval, barClock)) return

  // Status/watchlist path: compute at a separate cadence from setup detection.
  const regime = getCachedRegime(coin, interval, candles, idx)
  const pivots = getCachedPivots3(coin, interval, candles, idx)
  const wyckoff = getCachedWyckoff(coin, interval, candles, idx)
  const breaks = getCachedStructureBreaks(coin, interval, candles, idx)
  const htfInterval = HTF_MAP[interval]
  const htfIdx = htfCandles.length - 1
  const htfBreaks = htfCandles.length >= MIN_CANDLES_FOR_SCAN && htfInterval !== interval
    ? getCachedStructureBreaks(coin, htfInterval, htfCandles, htfIdx)
    : undefined
  const htfWyckoff = htfCandles.length >= MIN_CANDLES_FOR_SCAN && htfInterval !== interval
    ? getCachedWyckoff(coin, htfInterval, htfCandles, htfIdx)
    : undefined
  const bias = determineBias(candles, idx, htfCandles, pivots, {
    breaks,
    wyckoff,
    ...(htfBreaks !== undefined ? { htfBreaks } : {}),
    ...(htfWyckoff !== undefined ? { htfWyckoff } : {}),
  })
  const existing = statusState.get(sk)
  statusState.set(sk, {
    coin,
    interval,
    regime,
    bias: bias?.bias ?? 'neutral',
    biasConfidence: bias?.confidence ?? 0,
    confluenceGrade: existing?.confluenceGrade ?? null,
    activeCount: activeSetupCount(coin, interval),
    lastUpdateAt: Date.now(),
  })
  lastStatusUpdateBarClock.set(sk, barClock)
  statusRefreshCounts.set(sk, (statusRefreshCounts.get(sk) ?? 0) + 1)
}

/**
 * Run all strategies on the last fully closed bar (idx = length - 2), same as WS path.
 * Used after REST/PG backfill so bias/status/setups appear without waiting for the next TF close.
 */
function dispatchClosedBarScan(coin: string, interval: CandleInterval, registry: StrategyRegistry): void {
  const maxMin = requiredScanWindow(registry)
  const activeExchange = getActiveExchange()
  const candles = getCandlesInto(
    coin,
    interval,
    maxMin + 2,
    getOrCreateScanBuffer(coin, interval),
  )
  if (candles.length < MIN_CANDLES_FOR_SCAN + 1) return

  const idx = candles.length - 2

  // Build HTF context for ICT top-down analysis (SMC-SD uses this)
  const htfInterval = HTF_MAP[interval]
  const htfCandles = htfInterval !== interval
    ? getCandlesInto(
      coin,
      htfInterval,
      Math.max(maxMin + 2, INDICATOR_WINDOW),
      getOrCreateHtfBuffer(coin, htfInterval),
    )
    : []
  let context: StrategyContext | undefined
  if (htfInterval !== interval && htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
    context = { htfCandles, htfInterval }
  }

  refreshStatusSnapshot(coin, interval, candles, idx, htfCandles)

  const signalResults = registry.runAll(coin, interval, candles, idx, context, activeStrategyParams ?? undefined)

  for (const { strategyId, signal } of signalResults) {
    const sk = statusKey(coin, interval)
    const id = setupId(coin, interval, signal.type, strategyId)
    const existingSetup = activeSetups.get(id)
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
    if (!existingSetup) {
      incrementActiveSetupCount(sk)
    }
    const stats = getOrCreateStats(strategyId)
    stats.setupsTracked++
    pipelineEmitter.emit('setup', setup)

    // Promote confluenceGrade in statusState when a setup is detected
    const existing = statusState.get(sk)
    if (existing && signal.confluenceGrade) {
      statusState.set(sk, {
        ...existing,
        confluenceGrade: signal.confluenceGrade,
        activeCount: activeSetupCount(coin, interval),
      })
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
  const sk = statusKey(coin, interval)
  const candles = getCandles(coin, interval, 2)
  if (candles.length === 0) return
  const latest = candles[candles.length - 1]
  if (!latest) return
  lastCandleTs.set(sk, latest.t)
}

/**
 * After backfill: run one scan per coin/TF (except 1m) and seed lastCandleTs from store.
 * Call only after StrategyRegistry is populated (and after agent subscribes if setups must be handled).
 */
export function bootstrapPipelineFromStore(coins: readonly string[]): void {
  const registry = getStrategyRegistry()
  if (registry.size === 0) {
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
  const sk = statusKey(coin, interval)
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
  for (const k of activeSetups.keys()) {
    if (k.includes(setupNeedle)) removeSetupById(k)
  }
  for (const k of statusState.keys()) { if (k.startsWith(prefix)) statusState.delete(k) }
  for (const k of lastCandleTs.keys()) { if (k.startsWith(prefix)) lastCandleTs.delete(k) }
  for (const k of activeSetupCounts.keys()) { if (k.startsWith(prefix)) activeSetupCounts.delete(k) }
  for (const k of lastStatusUpdateBarClock.keys()) { if (k.startsWith(prefix)) lastStatusUpdateBarClock.delete(k) }
  for (const k of statusRefreshCounts.keys()) { if (k.startsWith(prefix)) statusRefreshCounts.delete(k) }
  for (const k of scanCandlesBuffers.keys()) { if (k.startsWith(prefix)) scanCandlesBuffers.delete(k) }
  for (const k of htfCandlesBuffers.keys()) { if (k.startsWith(prefix)) htfCandlesBuffers.delete(k) }
  clearIndicatorCacheForCoin(coin)
}

/**
 * Clear pipeline state. If strategyId given, clear only that strategy's stats.
 * Without strategyId, clears everything (all setups, status, timestamps, stats).
 */
export function clearPipelineState(strategyId?: string): void {
  if (strategyId) {
    // Granular: clear only setups belonging to this strategy + its stats
    for (const [id] of activeSetups) {
      if (id.startsWith(`${strategyId}:`)) removeSetupById(id)
    }
    resetPipelineStats(strategyId)
  } else {
    // Full clear
    activeSetups.clear()
    activeSetupCounts.clear()
    statusState.clear()
    lastCandleTs.clear()
    lastStatusUpdateBarClock.clear()
    statusRefreshCounts.clear()
    scanCandlesBuffers.clear()
    htfCandlesBuffers.clear()
    clearIndicatorCache()
    resetPipelineStats()
  }
}

// ── Aliases for StrategyRegistry adapter (Sprint 4.5) ────────────────────────

// ── Internals used by pipeline.ts ────────────────────────────────────────────

/** Get the mutable statusState map (for pipeline.ts to update during runPipeline). */
export function getStatusState(): Map<string, StatusSnapshot> {
  return statusState
}

/** Get status refresh count for a specific coin/tf (used by tests/benchmark diagnostics). */
export function getStatusRefreshCount(coin: string, interval: CandleInterval): number {
  return statusRefreshCounts.get(statusKey(coin, interval)) ?? 0
}

/** Get the mutable activeSetups map (for pipeline.ts to read/write during runPipeline). */
export function getActiveSetupsMap(): Map<string, ActiveSetup> {
  return activeSetups
}

// ── Decision Trace store (briefing / operator oversight) ───────────────────

const decisionTraces = new Map<string, DecisionTrace>()

function traceKey(trace: DecisionTrace): string {
  return `${trace.strategyId}:${trace.coin}:${trace.interval}`
}

/** Record or update a decision trace (called during pipeline evaluation). */
export function recordDecisionTrace(trace: DecisionTrace): void {
  decisionTraces.set(traceKey(trace), trace)
}

/** Get all active decision traces. */
export function getDecisionTraces(): DecisionTrace[] {
  return [...decisionTraces.values()]
}

/** Get decision traces filtered by coin, sorted by ts descending. */
export function getDecisionTracesForCoin(coin: string): DecisionTrace[] {
  return [...decisionTraces.values()]
    .filter(t => t.coin === coin)
    .sort((a, b) => b.ts - a.ts)
}

/** Find a trace by position ID. */
export function getDecisionTraceByPositionId(positionId: string): DecisionTrace | null {
  for (const trace of decisionTraces.values()) {
    if (trace.outcome.positionId === positionId) return trace
  }
  return null
}

/** Find a trace by setup ID. */
export function getDecisionTraceBySetupId(setupId: string): DecisionTrace | null {
  for (const trace of decisionTraces.values()) {
    if (trace.outcome.setupId === setupId) return trace
  }
  return null
}

/** Append an operator action to the most recent trace timeline. */
export function recordDecisionTraceAgentAction(
  action: { type: string; positionId?: string; reason?: string },
): void {
  // Find the matching trace by positionId, or fall back to most recent
  let target: DecisionTrace | undefined
  if (action.positionId != null) {
    target = getDecisionTraceByPositionId(action.positionId) ?? undefined
  }
  if (target == null) {
    // Fall back to most recent trace
    const all = getDecisionTraces().sort((a, b) => b.ts - a.ts)
    target = all[0]
  }
  if (target == null) return
  target.timeline.push({
    actor: 'executor',
    summary: `${action.type}${action.reason != null ? ` — ${action.reason}` : ''}`,
  })
}

/** Clear all decision traces (for tests). */
export function clearDecisionTraces(): void {
  decisionTraces.clear()
}
