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

export function isSpring(candles: Candle[], idx: number, lookback: number = 20): boolean {
  if (idx < lookback + 1) return false
  let rangeLow = Infinity
  for (let i = idx - lookback; i < idx; i++) {
    const l = candles[i]!.l
    if (l < rangeLow) rangeLow = l
  }
  const c = candles[idx]!
  return c.l < rangeLow && c.c > rangeLow
}

export function isUTAD(candles: Candle[], idx: number, lookback: number = 20): boolean {
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
 *   ATR(20)/ATR(50) < 0.7 (tight range = consolidation):
 *     Current slope flat (|trendSlope| < 0.02) + prior slope < -0.02 → accumulation
 *     Current slope flat (|trendSlope| < 0.02) + prior slope > +0.02 → distribution
 *     (Accumulation = sideway AFTER downtrend; Distribution = sideway AFTER uptrend)
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

  // Need 2× trendPeriod: current window + prior window for trend history
  if (idx < tp * 2) return { phase: null, confidence: 0, event: null }

  const atrShort = atr(candles, idx, rp)
  const atrLong = atr(candles, idx, tp)
  if (isNaN(atrShort) || isNaN(atrLong) || atrLong === 0) return { phase: null, confidence: 0, event: null }

  const atrRatio = atrShort / atrLong

  // Current slope: SMA change over recent rangePeriod bars
  const smaLong = sma(candles, idx, tp)
  const smaPrev = sma(candles, idx - rp, tp)
  if (isNaN(smaLong) || isNaN(smaPrev) || smaPrev === 0) return { phase: null, confidence: 0, event: null }
  const trendSlope = (smaLong - smaPrev) / smaPrev

  // Prior slope: SMA change over the window BEFORE the current consolidation
  // This tells us what trend preceded the current tight range
  const smaPriorEnd = sma(candles, idx - rp, tp)
  const smaPriorStart = sma(candles, idx - rp * 2, tp)
  const priorSlope = (!isNaN(smaPriorEnd) && !isNaN(smaPriorStart) && smaPriorStart !== 0)
    ? (smaPriorEnd - smaPriorStart) / smaPriorStart
    : 0

  const volR = volumeRatio(candles, idx, rp)
  const volDecreasing = !isNaN(volR) && volR < 0.8
  const volSpike = !isNaN(volR) && volR > 2.0

  let phase: WyckoffPhase | null = null
  let confidence = 0
  let event: WyckoffEvent | null = null

  if (atrRatio < 0.7) {
    // Tight range (consolidation). Need FLAT current slope + directional PRIOR slope.
    const isFlat = Math.abs(trendSlope) < 0.02
    if (isFlat && priorSlope < -0.02) {
      // Sideway after downtrend → accumulation (smart money buying quietly)
      phase = 'accumulation'
      confidence = 0.6
      if (volDecreasing) confidence += 0.15
      if (isSpring(candles, idx, rp)) { confidence += 0.2; event = 'spring' }
    } else if (isFlat && priorSlope > 0.02) {
      // Sideway after uptrend → distribution (smart money selling quietly)
      phase = 'distribution'
      confidence = 0.6
      if (volDecreasing) confidence += 0.15
      if (isUTAD(candles, idx, rp)) { confidence += 0.2; event = 'utad' }
    }
    // Not flat or no prior trend → phase stays null (no Wyckoff phase detected)
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
