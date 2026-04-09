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

import type { Candle, CandleInterval, ActiveSetup, SignalSide } from '../../../types.js'
import { ema, rsi, atr, adx, volumeRatio, detectRegime } from '../../../indicators/core.js'
import { getPipelineEmitter, getActiveSetupsMap } from '../../orchestrator.js'
import { getOrCreateStats } from '../../diagnostics.js'
import { computeExpiresAtBar, setupId } from '../../shared/invalidation.js'
import {
  QUANT_EMA_FAST,
  QUANT_EMA_SLOW,
  QUANT_RSI_PERIOD,
  QUANT_RSI_OVERSOLD,
  QUANT_RSI_OVERBOUGHT,
  QUANT_ATR_SL_MULT,
  QUANT_ATR_TP_MULT,
  QUANT_MIN_EMA_SEPARATION_PCT,
  QUANT_DEDUP_BARS,
  QUANT_ADX_MIN,
  MAX_TRADE_SL_PCT,
  getActiveExchange,
} from '../../../config.js'
import { log } from '../../../lib/logger.js'

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

  // EMA separation filter: reject choppy markets where EMAs are too close
  const emaGap = Math.abs(ema50 - ema200) / ema200
  if (emaGap < QUANT_MIN_EMA_SEPARATION_PCT) return

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

  // ADX filter: only trade in trending markets (ADX > min threshold)
  const adxVal = adx(candles, idx)
  if (!isNaN(adxVal) && adxVal < QUANT_ADX_MIN) return

  // Regime filter: only block VOLATILE (spiky ATR spike = unreliable entries).
  // Counter-trend is intentional here — RSI pullback in an EMA uptrend is locally BEAR
  // by SMA definition, so applying counter penalty would kill every valid pullback signal.
  const regime = detectRegime(candles, idx)
  if (regime === 'VOLATILE') return

  // Dynamic confidence scoring
  let confidence = 0.55
  if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05
  if (rsiVal < 25 || rsiVal > 75) confidence += 0.05
  const volRatio = volumeRatio(candles, idx, 20)
  if (!isNaN(volRatio) && volRatio > 1.3) confidence += 0.05

  stats.passL1Bias++
  stats.passL2Structure++
  stats.passL3Zones++
  stats.passL5Trigger++
  stats.passConfluence++
  stats.passRisk++
  stats.passRegime++

  // Dedup: cooldown of N bars per coin|interval
  const dedupKey = `${coin}|${interval}`
  const lastBar = lastSignalBar.get(dedupKey)
  if (lastBar !== undefined && idx - lastBar <= QUANT_DEDUP_BARS) return
  lastSignalBar.set(dedupKey, idx)

  const close = candles[idx]!.c
  const slDistance = atrVal * QUANT_ATR_SL_MULT
  const tpDistance = atrVal * QUANT_ATR_TP_MULT

  const entryPrice = close
  const slPrice = side === 'long' ? close - slDistance : close + slDistance
  const tpPrice = side === 'long' ? close + tpDistance : close - tpDistance

  // SL% cap — reject trades where SL distance exceeds MAX_TRADE_SL_PCT (prevents oversized 4h ATR stops)
  if (slDistance / close > MAX_TRADE_SL_PCT) return

  const id = setupId(coin, interval, 'ema-rsi', 'quant')
  const activeExchange = getActiveExchange()

  const setup: ActiveSetup = {
    id,
    coin,
    interval,
    type: 'ema-rsi',
    side,
    confidence: Math.min(confidence, 1),
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
    strategyId: 'quant',
    exchange: activeExchange,
  }

  getActiveSetupsMap().set(id, setup)
  stats.setupsTracked++

  const rrRaw = Math.abs(tpPrice - entryPrice) / Math.abs(entryPrice - slPrice)
  const rr = isNaN(rrRaw) ? 0 : rrRaw
  log.info('pipeline',
    `⚡ SETUP | ${coin} ${interval.toUpperCase()} [${activeExchange}] | ${side.toUpperCase()} ema-rsi | ` +
    `B (3/7) | conf:${setup.confidence.toFixed(2)} regime:${regime} | ` +
    `entry:${entryPrice.toFixed(2)} sl:${slPrice.toFixed(2)} tp:${tpPrice.toFixed(2)} | R:R 1:${rr.toFixed(2)} | ` +
    `ema50:${ema50.toFixed(2)} ema200:${ema200.toFixed(2)} rsi:${rsiVal.toFixed(1)} gap:${(emaGap*100).toFixed(2)}% | ` +
    `ttl:${setup.expiresAtBar - setup.detectedAtBar}bars | [quant]`,
  )

  getPipelineEmitter().emit('setup', setup)
}
