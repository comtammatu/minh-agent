/**
 * Wyckoff Indicators — phase detection + spring/UTAD events.
 * 4 phases: accumulation, markup, distribution, markdown.
 * 2 events: spring (false breakdown), utad (false breakout above distribution).
 * Pure functions. Zero I/O.
 */

import type { Candle, WyckoffPhase, WyckoffEvent } from '../types.js'
import { sma, atr, volumeRatio } from './core.js'

export interface WyckoffResult {
  phase: WyckoffPhase | null
  confidence: number
  event: WyckoffEvent | null
}

// ─── Spring / UTAD event helpers ──────────────────────────────────────────────

function isSpring(candles: Candle[], idx: number, lookback: number): boolean {
  if (idx < lookback + 1) return false
  let rangeLow = Infinity
  for (let i = idx - lookback; i < idx; i++) {
    const l = candles[i]!.l
    if (l < rangeLow) rangeLow = l
  }
  const c = candles[idx]!
  return c.l < rangeLow && c.c > rangeLow
}

function isUTAD(candles: Candle[], idx: number, lookback: number): boolean {
  if (idx < lookback + 1) return false
  let rangeHigh = -Infinity
  for (let i = idx - lookback; i < idx; i++) {
    const h = candles[i]!.h
    if (h > rangeHigh) rangeHigh = h
  }
  const c = candles[idx]!
  return c.h > rangeHigh && c.c < rangeHigh
}

// ─── Phase detection ──────────────────────────────────────────────────────────

/**
 * Detect Wyckoff phase at idx.
 *
 * Decision criteria:
 *   ATR(20)/ATR(50) < 0.7 (tight range):
 *     trendSlope < -0.02 → accumulation (optionally + spring)
 *     trendSlope > +0.02 → distribution (optionally + utad)
 *   ATR(20)/ATR(50) > 1.2 (expanding range):
 *     trendSlope > +0.02 → markup
 *     trendSlope < -0.02 → markdown
 */
export function detectWyckoff(
  candles: Candle[],
  idx: number,
  params: { rangePeriod?: number; trendPeriod?: number } = {},
): WyckoffResult {
  const rp = params.rangePeriod ?? 20
  const tp = params.trendPeriod ?? 50

  if (idx < tp) return { phase: null, confidence: 0, event: null }

  const atrShort = atr(candles, idx, rp)
  const atrLong = atr(candles, idx, tp)
  if (isNaN(atrShort) || isNaN(atrLong) || atrLong === 0) return { phase: null, confidence: 0, event: null }

  const atrRatio = atrShort / atrLong

  const smaLong = sma(candles, idx, tp)
  const smaPrev = sma(candles, idx - rp, tp)
  if (isNaN(smaLong) || isNaN(smaPrev) || smaPrev === 0) return { phase: null, confidence: 0, event: null }

  const trendSlope = (smaLong - smaPrev) / smaPrev
  const volR = volumeRatio(candles, idx, rp)
  const volDecreasing = !isNaN(volR) && volR < 0.8
  const volSpike = !isNaN(volR) && volR > 2.0

  let phase: WyckoffPhase | null = null
  let confidence = 0
  let event: WyckoffEvent | null = null

  if (atrRatio < 0.7) {
    if (trendSlope < -0.02) {
      phase = 'accumulation'
      confidence = 0.6
      if (volDecreasing) confidence += 0.15
      if (isSpring(candles, idx, rp)) { confidence += 0.2; event = 'spring' }
    } else if (trendSlope > 0.02) {
      phase = 'distribution'
      confidence = 0.6
      if (volDecreasing) confidence += 0.15
      if (isUTAD(candles, idx, rp)) { confidence += 0.2; event = 'utad' }
    }
  } else if (atrRatio > 1.2) {
    if (trendSlope > 0.02) {
      phase = 'markup'
      confidence = 0.7
      if (volSpike) confidence += 0.15
    } else if (trendSlope < -0.02) {
      phase = 'markdown'
      confidence = 0.7
      if (volSpike) confidence += 0.15
    }
  }

  return { phase, confidence: Math.min(confidence, 1), event }
}
