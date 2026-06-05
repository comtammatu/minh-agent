/**
 * Wyckoff Indicators — phase detection + spring/UTAD events.
 * 4 phases: accumulation, markup, distribution, markdown.
 * 2 events: spring (false breakdown), utad (false breakout above distribution).
 * Pure functions. Zero I/O.
 */

import type { Candle, WyckoffEvent, WyckoffPhase } from "../types.js";

export interface WyckoffResult {
  phase: WyckoffPhase | null;
  confidence: number;
  event: WyckoffEvent | null;
}

function trueRange(candles: Candle[], idx: number): number {
  if (idx === 0) return candles[0]!.h - candles[0]!.l; // non-null: idx 0 guard
  const c = candles[idx]!;
  const p = candles[idx - 1]!;
  return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
}

function atrPair(
  candles: Candle[],
  idx: number,
  shortPeriod: number,
  longPeriod: number,
): [number, number] {
  if (idx < Math.max(shortPeriod, longPeriod)) return [NaN, NaN];

  let shortSeed = 0;
  let longSeed = 0;
  let shortVal = NaN;
  let longVal = NaN;

  for (let i = 1; i <= idx; i++) {
    const tr = trueRange(candles, i);

    if (i <= shortPeriod) {
      shortSeed += tr;
      if (i === shortPeriod) shortVal = shortSeed / shortPeriod;
    } else {
      shortVal = (shortVal * (shortPeriod - 1) + tr) / shortPeriod;
    }

    if (i <= longPeriod) {
      longSeed += tr;
      if (i === longPeriod) longVal = longSeed / longPeriod;
    } else {
      longVal = (longVal * (longPeriod - 1) + tr) / longPeriod;
    }
  }

  return [shortVal, longVal];
}

function computeWindowStats(
  candles: Candle[],
  idx: number,
  rangePeriod: number,
  trendPeriod: number,
): {
  smaLong: number;
  smaPrev: number;
  smaPriorStart: number;
  volRatio: number;
} {
  const hasSmaPrev = idx - rangePeriod >= trendPeriod - 1;
  const hasSmaPriorStart = idx - rangePeriod * 2 >= trendPeriod - 1;
  const hasVolRatio = idx >= rangePeriod;
  const window0Start = idx - trendPeriod + 1;
  const window1Start = idx - rangePeriod - trendPeriod + 1;
  const window1End = idx - rangePeriod;
  const window2Start = idx - rangePeriod * 2 - trendPeriod + 1;
  const window2End = idx - rangePeriod * 2;
  const volStart = idx - rangePeriod;

  let sum0 = 0;
  let sum1 = 0;
  let sum2 = 0;
  let volSum = 0;

  let loopStart = window0Start;
  if (hasVolRatio && volStart < loopStart) loopStart = volStart;
  if (hasSmaPrev && window1Start < loopStart) loopStart = window1Start;
  if (hasSmaPriorStart && window2Start < loopStart) loopStart = window2Start;
  if (loopStart < 0) loopStart = 0;

  for (let i = loopStart; i <= idx; i++) {
    const candle = candles[i]!;
    const close = candle.c;
    if (i >= window0Start) sum0 += close;
    if (hasSmaPrev && i >= window1Start && i <= window1End) sum1 += close;
    if (hasSmaPriorStart && i >= window2Start && i <= window2End) sum2 += close;
    if (hasVolRatio && i >= volStart && i < idx) volSum += candle.v;
  }

  return {
    smaLong: sum0 / trendPeriod,
    smaPrev: hasSmaPrev ? sum1 / trendPeriod : NaN,
    smaPriorStart: hasSmaPriorStart ? sum2 / trendPeriod : NaN,
    volRatio: hasVolRatio
      ? volSum / rangePeriod === 0
        ? 0
        : (candles[idx]?.v ?? 0) / (volSum / rangePeriod)
      : NaN,
  };
}

// ─── Spring / UTAD event helpers ──────────────────────────────────────────────

export function isSpring(
  candles: Candle[],
  idx: number,
  lookback: number = 20,
): boolean {
  if (idx < lookback + 1) return false;
  let rangeLow = Infinity;
  for (let i = idx - lookback; i < idx; i++) {
    const l = candles[i]?.l ?? Infinity;
    if (l < rangeLow) rangeLow = l;
  }
  const c = candles[idx]!;
  return c.l < rangeLow && c.c > rangeLow;
}

export function isUTAD(
  candles: Candle[],
  idx: number,
  lookback: number = 20,
): boolean {
  if (idx < lookback + 1) return false;
  let rangeHigh = -Infinity;
  for (let i = idx - lookback; i < idx; i++) {
    const h = candles[i]?.h ?? -Infinity;
    if (h > rangeHigh) rangeHigh = h;
  }
  const c = candles[idx]!;
  return c.h > rangeHigh && c.c < rangeHigh;
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
  const rp = params.rangePeriod ?? 20;
  const tp = params.trendPeriod ?? 50;

  // Need 2× trendPeriod: current window + prior window for trend history
  if (idx < tp * 2) return { phase: null, confidence: 0, event: null };

  const [atrShort, atrLong] = atrPair(candles, idx, rp, tp);
  if (Number.isNaN(atrShort) || Number.isNaN(atrLong) || atrLong === 0)
    return { phase: null, confidence: 0, event: null };

  const atrRatio = atrShort / atrLong;

  // Current slope: SMA change over recent rangePeriod bars
  const {
    smaLong,
    smaPrev,
    smaPriorStart,
    volRatio: volR,
  } = computeWindowStats(candles, idx, rp, tp);
  if (Number.isNaN(smaLong) || Number.isNaN(smaPrev) || smaPrev === 0)
    return { phase: null, confidence: 0, event: null };
  const trendSlope = (smaLong - smaPrev) / smaPrev;

  // Prior slope: SMA change over the window BEFORE the current consolidation
  // This tells us what trend preceded the current tight range
  const priorSlope =
    !Number.isNaN(smaPriorStart) && smaPriorStart !== 0
      ? (smaPrev - smaPriorStart) / smaPriorStart
      : 0;
  const volDecreasing = !Number.isNaN(volR) && volR < 0.8;
  const volSpike = !Number.isNaN(volR) && volR > 2.0;

  let phase: WyckoffPhase | null = null;
  let confidence = 0;
  let event: WyckoffEvent | null = null;

  if (atrRatio < 0.7) {
    // Tight range (consolidation). Need FLAT current slope + directional PRIOR slope.
    const isFlat = Math.abs(trendSlope) < 0.02;
    if (isFlat && priorSlope < -0.02) {
      // Sideway after downtrend → accumulation (smart money buying quietly)
      phase = "accumulation";
      confidence = 0.6;
      if (volDecreasing) confidence += 0.15;
      if (isSpring(candles, idx, rp)) {
        confidence += 0.2;
        event = "spring";
      }
    } else if (isFlat && priorSlope > 0.02) {
      // Sideway after uptrend → distribution (smart money selling quietly)
      phase = "distribution";
      confidence = 0.6;
      if (volDecreasing) confidence += 0.15;
      if (isUTAD(candles, idx, rp)) {
        confidence += 0.2;
        event = "utad";
      }
    }
    // Not flat or no prior trend → phase stays null (no Wyckoff phase detected)
  } else if (atrRatio > 1.2) {
    if (trendSlope > 0.02) {
      phase = "markup";
      confidence = 0.7;
      if (volSpike) confidence += 0.15;
    } else if (trendSlope < -0.02) {
      phase = "markdown";
      confidence = 0.7;
      if (volSpike) confidence += 0.15;
    }
  }

  return { phase, confidence: Math.min(confidence, 1), event };
}
