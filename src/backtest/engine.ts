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
 * Limitations (v1):
 *   - Order flow data (delta, book, funding, OI) not available in backtest.
 *     Pipeline handles this gracefully — confirmZones returns zero boosts.
 *   - No trailing stop or partial close (added in S3/S4 with agent wiring).
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
} from '../scanner/pipeline.js'
import { clearStore, clearOnPersist } from '../feed/store.js'
import { BACKTEST_SLIPPAGE_PCT, BACKTEST_COMMISSION_PCT } from '../config.js'

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

  const slippage = config.slippagePct ?? BACKTEST_SLIPPAGE_PCT
  const commission = config.commissionPct ?? BACKTEST_COMMISSION_PCT
  const simulator = new TradeSimulator(config.initialCapital, slippage, commission)

  // ── Wire pipeline → simulator ───────────────────────────────────────────
  const emitter = getPipelineEmitter()
  let currentBarIndex = 0

  const onSetup = (setup: ActiveSetup) => {
    simulator.tryFill(setup, currentBarIndex)
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

    return { config, metrics, trades, equityCurve }
  } finally {
    // ── Cleanup: remove listener + reset state ──────────────────────────
    emitter.off('setup', onSetup)
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
      const key = `${coin}:${tf}`
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
