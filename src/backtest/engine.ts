/**
 * Backtest engine — replay historical candles through Sprint 1+2 pipeline.
 *
 * Design:
 *   - Reuses production pipeline (onCandleTick) — ZERO duplicate logic
 *   - Feeds candles one by one chronologically
 *   - Pipeline emits 'setup' events → simulator fills instantly
 *   - Simulator checks SL/TP on each bar
 *   - Collects trades → computes metrics
 *
 * Key invariant: NO look-ahead bias.
 *   Store only contains candles up to current replay point because
 *   we feed them one by one via appendCandle (inside onCandleTick).
 *
 * Limitations:
 *   - Order flow data (delta, book, funding, OI) not available in backtest.
 *     Pipeline handles this gracefully — confirmZones returns zero boosts.
 *   - Instant fill assumption (no queue/latency simulation).
 */

import type { Candle, CandleInterval, ActiveSetup } from '../types.js'
import type { BacktestConfig, BacktestResult } from './types.js'
import { TradeSimulator } from './simulator.js'
import { computeMetrics, buildEquityCurve } from './metrics.js'
import {
  onCandleTick,
  getPipelineEmitter,
  clearPipelineState,
} from '../strategy/orchestrator.js'
import { getPipelineStats } from '../strategy/diagnostics.js'
import { getStrategyRegistry } from '../strategy/registry.js'
import { clearStore, clearOnPersist, getCandles } from '../feed/store.js'
import { atr } from '../indicators/core.js'
import { BACKTEST_SLIPPAGE_PCT, BACKTEST_COMMISSION_PCT, ATR_TRAIL_MULTIPLIER, INDICATOR_WINDOW, BACKTEST_CHUNK_SIZE } from '../config.js'

/**
 * Run a backtest on historical candle data.
 *
 * @param candles - Map of "COIN:INTERVAL" → sorted Candle[] (ascending by t)
 * @param config  - Backtest configuration (coins, timeframes, capital, etc.)
 * @returns BacktestResult with trades, metrics, and equity curve
 */
export function runBacktest(
  candles: Map<string, Candle[]>,
  config: BacktestConfig,
): BacktestResult {
  // ── Reset shared state ──────────────────────────────────────────────────
  clearPipelineState()
  clearStore()
  clearOnPersist()  // prevent DB writes during backtest
  getStrategyRegistry().clearAllState()  // reset per-strategy dedup (critical for walk-forward isolation)
  getStrategyRegistry().activateOnly(config.strategy ?? 'smc-sd')

  const slippage = config.slippagePct ?? BACKTEST_SLIPPAGE_PCT
  const commission = config.commissionPct ?? BACKTEST_COMMISSION_PCT
  const exitMode = config.exitMode ?? 'multi'
  const strategyId = config.strategy ?? 'smc-sd'
  const simulator = new TradeSimulator(config.initialCapital, slippage, commission, exitMode, strategyId)

  // ── Wire pipeline → simulator ───────────────────────────────────────────
  const emitter = getPipelineEmitter()
  let currentBarIndex = 0
  let currentInterval: CandleInterval = '1h'
  let currentCoin: string = ''

  const onSetup = (setup: ActiveSetup) => {
    // Compute ATR at fill time from store (candles already appended)
    const storeCandles = getCandles(setup.coin, setup.interval, INDICATOR_WINDOW)
    const idx = storeCandles.length - 2  // closed candle (same as pipeline)
    const atrVal = idx >= 14 ? atr(storeCandles, idx, 14) : 0
    const trailMult = ATR_TRAIL_MULTIPLIER[setup.interval] ?? 2.0

    simulator.tryFill(setup, currentBarIndex, atrVal, trailMult)
  }
  emitter.on('setup', onSetup)

  try {
    // ── Build chronological replay sequence ─────────────────────────────
    const replayEvents = buildReplaySequence(candles, config.coins, config.timeframes)

    // Validate: need enough candles
    if (replayEvents.length === 0) {
      return emptyResult(config)
    }

    // ── Replay candles ──────────────────────────────────────────────────
    for (let i = 0; i < replayEvents.length; i++) {
      const event = replayEvents[i]!
      currentBarIndex = i

      // Feed candle through production pipeline
      onCandleTick(event.coin, event.interval, event.candle)

      // Check all open positions for SL/TP hits on this bar
      simulator.checkBar(event.coin, event.candle, i)
    }

    // ── Close remaining positions at last price ──────────────────────────
    const lastEvent = replayEvents[replayEvents.length - 1]!
    if (simulator.openPositionCount() > 0) {
      simulator.closeAll(
        lastEvent.candle.c,
        replayEvents.length - 1,
        lastEvent.candle.t,
      )
    }

    // ── Compute results ─────────────────────────────────────────────────
    const trades = simulator.getTrades()
    const metrics = computeMetrics(trades, config.initialCapital)
    const equityCurve = buildEquityCurve(trades, config.initialCapital)

    // Capture pipeline diagnostic stats before cleanup
    const pipelineStatsSnapshot = getPipelineStats(config.strategy ?? 'smc-sd')

    return { config, metrics, trades, equityCurve, pipelineStats: pipelineStatsSnapshot }
  } finally {
    // ── Cleanup: remove listener + reset state ──────────────────────────
    emitter.off('setup', onSetup)
    getStrategyRegistry().activateOnly(null)  // restore fan-out
    clearPipelineState()
    clearStore()
  }
}

// ─── Internal ───────────────────────────────────────────────────────────────

interface ReplayEvent {
  coin: string
  interval: CandleInterval
  candle: Candle
}

/**
 * Build a chronologically sorted list of replay events from candle data.
 * Interleaves all coin×TF candles by timestamp for correct multi-asset replay.
 */
function buildReplaySequence(
  candles: Map<string, Candle[]>,
  coins: string[],
  timeframes: CandleInterval[],
): ReplayEvent[] {
  const events: ReplayEvent[] = []

  for (const coin of coins) {
    for (const tf of timeframes) {
      const key = `${coin}|${tf}`
      const data = candles.get(key)
      if (!data || data.length === 0) continue

      for (const candle of data) {
        events.push({ coin, interval: tf, candle })
      }
    }
  }

  // Sort by timestamp (ascending). Stable sort preserves coin×TF order for same ts.
  events.sort((a, b) => a.candle.t - b.candle.t)

  return events
}

function emptyResult(config: BacktestConfig): BacktestResult {
  return {
    config,
    metrics: computeMetrics([], config.initialCapital),
    trades: [],
    equityCurve: [{ ts: 0, equity: config.initialCapital }],
  }
}

// ─── Async Variant (Browser-triggered) ─────────────────────────────────────

/** Progress callback fired every BACKTEST_CHUNK_SIZE bars. */
export interface BacktestProgress {
  bar: number
  total: number
  pct: number   // 0–100
  phase: 'replaying' | 'computing' | 'done' | 'error'
}

/**
 * Async backtest that yields to the event loop every BACKTEST_CHUNK_SIZE bars.
 * Keeps SSE / Telegram responsive during long runs.
 *
 * Same logic as runBacktest() — extracted replay loop with setTimeout(0) yields.
 */
export async function runBacktestAsync(
  candles: Map<string, Candle[]>,
  config: BacktestConfig,
  onProgress?: (p: BacktestProgress) => void,
): Promise<BacktestResult> {
  clearPipelineState()
  clearStore()
  clearOnPersist()
  getStrategyRegistry().activateOnly(config.strategy ?? 'smc-sd')

  const slippage = config.slippagePct ?? BACKTEST_SLIPPAGE_PCT
  const commission = config.commissionPct ?? BACKTEST_COMMISSION_PCT
  const asyncExitMode = config.exitMode ?? 'multi'
  const simulator = new TradeSimulator(config.initialCapital, slippage, commission, asyncExitMode, config.strategy ?? 'smc-sd')

  const emitter = getPipelineEmitter()
  let currentBarIndex = 0

  const onSetup = (setup: ActiveSetup) => {
    const storeCandles = getCandles(setup.coin, setup.interval, INDICATOR_WINDOW)
    const idx = storeCandles.length - 2
    const atrVal = idx >= 14 ? atr(storeCandles, idx, 14) : 0
    const trailMult = ATR_TRAIL_MULTIPLIER[setup.interval] ?? 2.0
    simulator.tryFill(setup, currentBarIndex, atrVal, trailMult)
  }
  emitter.on('setup', onSetup)

  try {
    const replayEvents = buildReplaySequence(candles, config.coins, config.timeframes)

    if (replayEvents.length === 0) {
      onProgress?.({ bar: 0, total: 0, pct: 100, phase: 'done' })
      return emptyResult(config)
    }

    const total = replayEvents.length
    const chunkSize = BACKTEST_CHUNK_SIZE

    // Replay with async yields
    for (let i = 0; i < total; i++) {
      const event = replayEvents[i]!
      currentBarIndex = i

      onCandleTick(event.coin, event.interval, event.candle)
      simulator.checkBar(event.coin, event.candle, i)

      // Yield every chunkSize bars
      if (i > 0 && i % chunkSize === 0) {
        onProgress?.({ bar: i, total, pct: Math.round((i / total) * 100), phase: 'replaying' })
        await new Promise<void>((r) => setTimeout(r, 0))
      }
    }

    onProgress?.({ bar: total, total, pct: 99, phase: 'computing' })

    // Close remaining
    const lastEvent = replayEvents[total - 1]!
    if (simulator.openPositionCount() > 0) {
      simulator.closeAll(lastEvent.candle.c, total - 1, lastEvent.candle.t)
    }

    const trades = simulator.getTrades()
    const metrics = computeMetrics(trades, config.initialCapital)
    const equityCurve = buildEquityCurve(trades, config.initialCapital)
    const pipelineStatsSnapshot = getPipelineStats(config.strategy ?? 'smc-sd')

    onProgress?.({ bar: total, total, pct: 100, phase: 'done' })

    return { config, metrics, trades, equityCurve, pipelineStats: pipelineStatsSnapshot }
  } finally {
    emitter.off('setup', onSetup)
    getStrategyRegistry().activateOnly(null)  // restore fan-out
    clearPipelineState()
    clearStore()
  }
}
