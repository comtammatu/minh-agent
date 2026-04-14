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
  DecisionTrace,
  MarketRegime,
  StrategyContext,
} from '../types.js'
import type { AgentAction } from '../agent/types.js'
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
import { buildSetupDecisionTrace, buildStatusDecisionTrace } from './decision-trace.js'

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
const decisionTraceState = new Map<string, DecisionTrace>()
const traceKeyBySetupId = new Map<string, string>()
const traceKeyByPositionId = new Map<string, string>()

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

function decisionTraceKey(coin: string, interval: CandleInterval, strategyId: string): string {
  return `${coin}|${interval}|${strategyId}`
}

function setDecisionTrace(trace: DecisionTrace): void {
  const key = decisionTraceKey(trace.coin, trace.interval, trace.strategyId)
  const prev = decisionTraceState.get(key)
  if (prev?.outcome.setupId !== undefined && prev.outcome.setupId !== trace.outcome.setupId) {
    traceKeyBySetupId.delete(prev.outcome.setupId)
  }
  if (prev?.outcome.positionId !== undefined && prev.outcome.positionId !== trace.outcome.positionId) {
    traceKeyByPositionId.delete(prev.outcome.positionId)
  }
  decisionTraceState.set(key, trace)
  if (trace.outcome.setupId !== undefined) {
    traceKeyBySetupId.set(trace.outcome.setupId, key)
  }
  if (trace.outcome.positionId !== undefined) {
    traceKeyByPositionId.set(trace.outcome.positionId, key)
  }
  pipelineEmitter.emit('decision_trace', trace)
}

/** Publish a trace from non-pipeline runtime sources (tests/UI/runtime lifecycle). */
export function publishDecisionTrace(trace: DecisionTrace): void {
  setDecisionTrace(trace)
}

function getTraceByKey(key: string | null): DecisionTrace | null {
  if (key === null) return null
  return decisionTraceState.get(key) ?? null
}

function findLatestTraceKeyForCoinStrategy(coin: string, strategyId: string): string | null {
  let bestKey: string | null = null
  let bestTs = -1
  for (const [key, trace] of decisionTraceState) {
    if (trace.coin !== coin || trace.strategyId !== strategyId) continue
    if (trace.ts > bestTs) {
      bestTs = trace.ts
      bestKey = key
    }
  }
  return bestKey
}

function cloneTrace(trace: DecisionTrace): DecisionTrace {
  return {
    ...trace,
    regime: { ...trace.regime },
    roles: {
      ...trace.roles,
      ...(trace.roles.wyckoff !== undefined ? { wyckoff: { ...trace.roles.wyckoff } } : {}),
      ...(trace.roles.bull !== undefined ? { bull: { ...trace.roles.bull } } : {}),
      ...(trace.roles.bear !== undefined ? { bear: { ...trace.roles.bear } } : {}),
      ...(trace.roles.risk !== undefined ? { risk: { ...trace.roles.risk } } : {}),
      ...(trace.roles.judge !== undefined ? { judge: { ...trace.roles.judge } } : {}),
      ...(trace.roles.guardian !== undefined ? { guardian: { ...trace.roles.guardian } } : {}),
      ...(trace.roles.executor !== undefined ? { executor: { ...trace.roles.executor } } : {}),
    },
    timeline: trace.timeline.map(item => ({ ...item })),
    outcome: { ...trace.outcome },
  }
}

const DECISION_TRACE_TIMELINE_LIMIT = 8

function appendTimeline(
  trace: DecisionTrace,
  actor: 'scanner' | 'judge' | 'executor' | 'guardian',
  action: string,
  summary: string,
): void {
  trace.timeline.push({
    ts: trace.ts,
    actor,
    action,
    summary,
  })
  if (trace.timeline.length > DECISION_TRACE_TIMELINE_LIMIT) {
    trace.timeline.splice(0, trace.timeline.length - DECISION_TRACE_TIMELINE_LIMIT)
  }
}

function strategyFromDetails(details: Record<string, unknown>): string | null {
  const strategyId = details['strategyId']
  return typeof strategyId === 'string' && strategyId.length > 0 ? strategyId : null
}

function resolveTraceKeyForAction(action: AgentAction): string | null {
  if (action.type === 'place_order') {
    const strategyId = action.setup.strategyId ?? 'system'
    return decisionTraceKey(action.setup.coin, action.setup.interval, strategyId)
  }
  if (action.type === 'close_position' || action.type === 'update_stop' || action.type === 'partial_close') {
    return traceKeyByPositionId.get(action.positionId) ?? null
  }
  if (action.type !== 'log_journal') return null

  const details = action.details
  const setupId = details['setupId']
  if (typeof setupId === 'string') {
    const found = traceKeyBySetupId.get(setupId)
    if (found !== undefined) return found
  }
  const positionId = details['positionId']
  if (typeof positionId === 'string') {
    const found = traceKeyByPositionId.get(positionId)
    if (found !== undefined) return found
  }
  const strategyId = strategyFromDetails(details)
  if (strategyId !== null) return findLatestTraceKeyForCoinStrategy(action.coin, strategyId)
  return null
}

/** Apply agent action lifecycle updates to the latest matching decision trace. */
export function recordDecisionTraceAgentAction(action: AgentAction): void {
  const key = resolveTraceKeyForAction(action)
  const trace = getTraceByKey(key)
  if (trace === null) return

  const next = cloneTrace(trace)
  next.ts = Date.now()

  if (action.type === 'place_order') {
    next.roles.executor = {
      role: 'executor',
      state: 'submitting',
      summary: `Submitting ${action.setup.side.toUpperCase()} order to ${action.setup.exchange}.`,
    }
    next.outcome.action = 'enter'
    next.outcome.summary = 'Executor is submitting the order to the exchange.'
    appendTimeline(next, 'executor', 'submit', next.outcome.summary)
    setDecisionTrace(next)
    return
  }

  if (action.type === 'close_position') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'exit_ready',
      summary: `Guardian is closing the position: ${action.reason}.`,
      actions: [`close_position:${action.reason}`],
    }
    next.outcome.action = 'exit'
    next.outcome.summary = `Closing position: ${action.reason}.`
    appendTimeline(next, 'guardian', 'close', next.outcome.summary)
    setDecisionTrace(next)
    return
  }

  if (action.type === 'update_stop') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'trail_sl',
      summary: `Guardian moved stop to ${action.newStopPrice.toFixed(2)}.`,
      actions: [`trail_sl:${action.newStopPrice.toFixed(2)}`],
    }
    next.outcome.action = 'trail_sl'
    next.outcome.summary = `Stop updated to ${action.newStopPrice.toFixed(2)}.`
    appendTimeline(next, 'guardian', 'trail_sl', next.outcome.summary)
    setDecisionTrace(next)
    return
  }

  if (action.type === 'partial_close') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'partial_tp',
      summary: `Guardian scaled out ${(action.closePct * 100).toFixed(0)}% of the position.`,
      actions: [`partial_close:${(action.closePct * 100).toFixed(0)}%`],
    }
    next.outcome.action = 'partial_close'
    next.outcome.summary = `Scaled out ${(action.closePct * 100).toFixed(0)}% of the position.`
    appendTimeline(next, 'guardian', 'partial_close', next.outcome.summary)
    setDecisionTrace(next)
    return
  }

  if (action.type !== 'log_journal') return

  const details = action.details
  switch (action.eventType) {
    case 'enter': {
      const positionId = typeof details['positionId'] === 'string' ? details['positionId'] : undefined
      next.roles.executor = {
        role: 'executor',
        state: 'filled',
        summary: 'Order filled and position is live.',
      }
      next.roles.guardian = {
        role: 'guardian',
        state: 'holding',
        summary: 'Guardian is monitoring the open position.',
        actions: ['hold'],
      }
      next.outcome.action = 'hold'
      next.outcome.summary = 'Position is open and under guardian monitoring.'
      if (positionId !== undefined) next.outcome.positionId = positionId
      appendTimeline(next, 'executor', 'filled', 'Order filled and position is live.')
      appendTimeline(next, 'guardian', 'hold', next.outcome.summary)
      setDecisionTrace(next)
      return
    }
    case 'exit': {
      const positionId = typeof details['positionId'] === 'string' ? details['positionId'] : undefined
      const reason = typeof details['reason'] === 'string' ? details['reason'] : 'closed'
      next.roles.executor = {
        role: 'executor',
        state: 'closed',
        summary: `Position closed: ${reason}.`,
      }
      next.roles.guardian = {
        role: 'guardian',
        state: 'exit_ready',
        summary: `Guardian completed exit: ${reason}.`,
        actions: [`exit:${reason}`],
      }
      next.outcome.action = 'exit'
      next.outcome.summary = `Position closed: ${reason}.`
      if (positionId !== undefined) next.outcome.positionId = positionId
      appendTimeline(next, 'executor', 'closed', next.outcome.summary)
      setDecisionTrace(next)
      return
    }
    case 'skip': {
      const reason = typeof details['reason'] === 'string' ? details['reason'] : ''
      if (!reason.toLowerCase().includes('order')) return
      next.roles.executor = {
        role: 'executor',
        state: 'rejected',
        summary: reason.length > 0 ? reason : 'Order was rejected or skipped.',
      }
      next.outcome.action = 'skip'
      next.outcome.summary = reason.length > 0 ? reason : 'Order was rejected or skipped.'
      appendTimeline(next, 'executor', 'rejected', next.outcome.summary)
      setDecisionTrace(next)
      return
    }
    case 'invalidate': {
      const reason = typeof details['reason'] === 'string' ? details['reason'] : 'invalidated'
      next.roles.guardian = {
        role: 'guardian',
        state: 'exit_ready',
        summary: `Guardian flagged invalidation: ${reason}.`,
        actions: [`invalidate:${reason}`],
      }
      next.outcome.summary = `Setup invalidated: ${reason}.`
      appendTimeline(next, 'guardian', 'invalidate', next.outcome.summary)
      setDecisionTrace(next)
      return
    }
  }
}

export interface DecisionTraceMonitorEvent {
  positionId: string
  coin: string
  strategyId: string
  action: 'hold' | 'trail_update' | 'partial_close' | 'close'
  summary: string
}

/** Apply guardian-side monitor updates (trail, partial, hold, pending exit). */
export function recordDecisionTraceMonitorEvent(event: DecisionTraceMonitorEvent): void {
  const key =
    traceKeyByPositionId.get(event.positionId) ??
    findLatestTraceKeyForCoinStrategy(event.coin, event.strategyId)
  const trace = getTraceByKey(key)
  if (trace === null) return

  const next = cloneTrace(trace)
  next.ts = Date.now()

  if (event.action === 'hold') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'holding',
      summary: event.summary,
      actions: ['hold'],
    }
    next.outcome.action = 'hold'
  } else if (event.action === 'trail_update') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'trail_sl',
      summary: event.summary,
      actions: ['trail_sl'],
    }
    next.outcome.action = 'trail_sl'
  } else if (event.action === 'partial_close') {
    next.roles.guardian = {
      role: 'guardian',
      state: 'partial_tp',
      summary: event.summary,
      actions: ['partial_close'],
    }
    next.outcome.action = 'partial_close'
  } else {
    next.roles.guardian = {
      role: 'guardian',
      state: 'exit_ready',
      summary: event.summary,
      actions: ['close'],
    }
    next.outcome.action = 'exit'
  }

  next.outcome.summary = event.summary
  next.outcome.positionId = event.positionId
  appendTimeline(next, 'guardian', event.action, event.summary)
  setDecisionTrace(next)
}

export interface DecisionTracePaperExitEvent {
  coin: string
  strategyId: string
  exitReason: string
  closePrice: number
  pnl: number
}

/** Update traces when enhanced paper tracking closes a position outside the agent action loop. */
export function recordDecisionTracePaperExit(event: DecisionTracePaperExitEvent): void {
  const key = findLatestTraceKeyForCoinStrategy(event.coin, event.strategyId)
  const trace = getTraceByKey(key)
  if (trace === null) return

  const next = cloneTrace(trace)
  next.ts = Date.now()
  next.roles.executor = {
    role: 'executor',
    state: 'closed',
    summary: `Paper exit: ${event.exitReason} @ ${event.closePrice.toFixed(2)}.`,
  }
  next.roles.guardian = {
    role: 'guardian',
    state: 'exit_ready',
    summary: `Guardian closed paper position with PnL ${event.pnl.toFixed(2)}.`,
    actions: [`paper_exit:${event.exitReason}`],
  }
  next.outcome.action = 'exit'
  next.outcome.summary = `Paper exit ${event.exitReason} (${event.pnl.toFixed(2)}).`
  appendTimeline(next, 'executor', 'paper_exit', `Paper exit: ${event.exitReason}.`)
  appendTimeline(next, 'guardian', 'exit', next.outcome.summary)
  setDecisionTrace(next)
}

function removeSetupById(id: string): void {
  const existing = activeSetups.get(id)
  if (!existing) return
  activeSetups.delete(id)
  decrementActiveSetupCount(setupCountKey(existing))
  traceKeyBySetupId.delete(id)
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

  const trace = buildStatusDecisionTrace({
    coin,
    interval,
    exchange: getActiveExchange(),
    regime,
    bias,
    wyckoff,
    breaks,
    activeCount: activeSetupCount(coin, interval),
  })
  setDecisionTrace(trace)
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

  const regime = getCachedRegime(coin, interval, candles, idx)
  const pivots = getCachedPivots3(coin, interval, candles, idx)
  const wyckoff = getCachedWyckoff(coin, interval, candles, idx)
  const breaks = getCachedStructureBreaks(coin, interval, candles, idx)
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

    const trace = buildSetupDecisionTrace({
      setup,
      regime,
      bias,
      wyckoff,
      breaks,
      activeCount: activeSetupCount(coin, interval),
    })
    setDecisionTrace(trace)

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
    const signalRegime = signal.patternData['regime'] as string | undefined
    const zoneOrigin = signal.patternData['zoneOrigin'] as string | undefined
    log.info('pipeline',
      `⚡ SETUP | ${coin} ${interval.toUpperCase()} [${activeExchange}] | ${signal.side.toUpperCase()} ${signal.type}${zoneOrigin ? ` at ${zoneOrigin}` : ''} | ` +
      `${grade} (${count}/7) | conf:${signal.confidence.toFixed(2)}${signalRegime ? ` | ${signalRegime}` : ''} | ` +
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

/** Get the latest decision traces keyed by coin/interval/strategy. */
export function getDecisionTraces(): DecisionTrace[] {
  return Array.from(decisionTraceState.values())
}

/** Find a decision trace by setup id. */
export function getDecisionTraceBySetupId(setupId: string): DecisionTrace | null {
  const key = traceKeyBySetupId.get(setupId)
  return key != null ? decisionTraceState.get(key) ?? null : null
}

/** Find a decision trace by position id. */
export function getDecisionTraceByPositionId(positionId: string): DecisionTrace | null {
  const key = traceKeyByPositionId.get(positionId)
  return key != null ? decisionTraceState.get(key) ?? null : null
}

/** Get traces for a coin sorted newest-first. */
export function getDecisionTracesForCoin(coin: string): DecisionTrace[] {
  return Array.from(decisionTraceState.values())
    .filter(trace => trace.coin === coin)
    .sort((a, b) => b.ts - a.ts)
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
  for (const k of decisionTraceState.keys()) { if (k.startsWith(prefix)) decisionTraceState.delete(k) }
  for (const k of lastCandleTs.keys()) { if (k.startsWith(prefix)) lastCandleTs.delete(k) }
  for (const k of activeSetupCounts.keys()) { if (k.startsWith(prefix)) activeSetupCounts.delete(k) }
  for (const k of lastStatusUpdateBarClock.keys()) { if (k.startsWith(prefix)) lastStatusUpdateBarClock.delete(k) }
  for (const k of statusRefreshCounts.keys()) { if (k.startsWith(prefix)) statusRefreshCounts.delete(k) }
  for (const k of scanCandlesBuffers.keys()) { if (k.startsWith(prefix)) scanCandlesBuffers.delete(k) }
  for (const k of htfCandlesBuffers.keys()) { if (k.startsWith(prefix)) htfCandlesBuffers.delete(k) }
  for (const [setupId, key] of traceKeyBySetupId) {
    if (key.startsWith(prefix)) traceKeyBySetupId.delete(setupId)
  }
  for (const [positionId, key] of traceKeyByPositionId) {
    if (key.startsWith(prefix)) traceKeyByPositionId.delete(positionId)
  }
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
    decisionTraceState.clear()
    traceKeyBySetupId.clear()
    traceKeyByPositionId.clear()
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
