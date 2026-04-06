/**
 * Quant baseline strategy — EMA trend filter + RSI pullback.
 *
 * Purpose: simple, well-studied quant strategy to benchmark against
 * the 5-layer Wyckoff/SMC pipeline. Produces frequent signals for
 * statistically valid backtest results.
 *
 * Rules:
 *   Trend:  EMA(50) > EMA(200) = bullish → only long
 *           EMA(50) < EMA(200) = bearish → only short
 *   Entry:  RSI(14) < 35 in bullish = buy pullback (QUANT_RSI_OVERSOLD)
 *           RSI(14) > 65 in bearish = sell rally (QUANT_RSI_OVERBOUGHT)
 *   SL:    ATR(14) × 2.0 below/above entry
 *   TP:    ATR(14) × 3.0 (1.5 R:R)
 *
 * Pure function — zero I/O. Emits ActiveSetup via pipeline emitter.
 */

import type { Candle, CandleInterval, ActiveSetup, SignalSide } from '../types.js'
import { ema, rsi, atr } from '../indicators/core.js'
import { getPipelineEmitter } from './orchestrator.js'
import { getOrCreateStats } from './diagnostics.js'
import { computeExpiresAtBar, setupId } from './invalidation.js'
import {
  QUANT_EMA_FAST,
  QUANT_EMA_SLOW,
  QUANT_RSI_PERIOD,
  QUANT_RSI_OVERSOLD,
  QUANT_RSI_OVERBOUGHT,
  QUANT_ATR_SL_MULT,
  QUANT_ATR_TP_MULT,
} from '../config.js'

// ── Dedup: track last signal bar per coin to avoid duplicates ────────────────

const lastSignalBar = new Map<string, number>()

export function clearQuantState(): void {
  lastSignalBar.clear()
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export function runQuantPipeline(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): void {
  const stats = getOrCreateStats('quant')
  stats.totalTicks++

  // Need enough candles for EMA(200) — candles array must have >= QUANT_EMA_SLOW entries
  if (candles.length < QUANT_EMA_SLOW) return

  // Compute indicators at closed candle
  const ema50 = ema(candles, idx, QUANT_EMA_FAST)
  const ema200 = ema(candles, idx, QUANT_EMA_SLOW)
  const rsiVal = rsi(candles, idx, QUANT_RSI_PERIOD)
  const atrVal = atr(candles, idx, QUANT_RSI_PERIOD)

  if (isNaN(ema50) || isNaN(ema200) || isNaN(rsiVal) || isNaN(atrVal) || atrVal <= 0) return

  // Determine trend regime
  const bullish = ema50 > ema200
  const bearish = ema50 < ema200

  // Check entry conditions
  let side: SignalSide | null = null
  if (bullish && rsiVal < QUANT_RSI_OVERSOLD) {
    side = 'long'
  } else if (bearish && rsiVal > QUANT_RSI_OVERBOUGHT) {
    side = 'short'
  }

  if (!side) return

  stats.passL1Bias++
  stats.passL2Structure++
  stats.passL3Zones++
  stats.passL5Trigger++
  stats.passConfluence++
  stats.passRisk++
  stats.passRegime++

  // Dedup: one signal per coin per bar
  const dedupKey = `${coin}|${interval}`
  if (lastSignalBar.get(dedupKey) === idx) return
  lastSignalBar.set(dedupKey, idx)

  const close = candles[idx]!.c
  const slDistance = atrVal * QUANT_ATR_SL_MULT
  const tpDistance = atrVal * QUANT_ATR_TP_MULT

  const entryPrice = close
  const slPrice = side === 'long' ? close - slDistance : close + slDistance
  const tpPrice = side === 'long' ? close + tpDistance : close - tpDistance

  const id = setupId(coin, interval, 'ema-rsi', 'quant')

  const setup: ActiveSetup = {
    id,
    coin,
    interval,
    type: 'ema-rsi',
    side,
    confidence: 0.6,
    entryPrice,
    slPrice,
    tpPrice,
    patternData: {
      ema50,
      ema200,
      rsi: rsiVal,
      atr: atrVal,
    },
    confluenceGrade: 'B',
    confluenceCount: 3,
    detectedAt: Date.now(),
    detectedAtBar: idx,
    expiresAtBar: computeExpiresAtBar('ema-rsi', idx),
  }

  stats.setupsTracked++
  getPipelineEmitter().emit('setup', setup)
}
