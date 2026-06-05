/**
 * Core indicators: SMA, EMA, ATR, RSI, ADX, volumeRatio, volumeTrend, detectRegime.
 * Pure functions. Zero I/O. Return NaN for insufficient data (caller must check).
 */

import type { Candle, MarketRegime } from "../types.js";

// ─── Moving averages ───────────────────────────────────────────────────────────

export function sma(candles: Candle[], idx: number, period: number): number {
  if (idx < period - 1) return NaN;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += candles[i]!.c; // non-null: bounds checked, dense candle window
  return sum / period;
}

export function ema(candles: Candle[], idx: number, period: number): number {
  if (idx < period - 1) return NaN;
  const k = 2 / (period + 1);
  let value = sma(candles, period - 1, period);
  for (let i = period; i <= idx; i++) {
    value = (candles[i]!.c - value) * k + value; // non-null: loop after pre-warm sma
  }
  return value;
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

function trueRange(candles: Candle[], idx: number): number {
  if (idx === 0) return candles[0]!.h - candles[0]!.l; // non-null: idx==0 guard
  const c = candles[idx]!;
  const p = candles[idx - 1]!;
  return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
}

function trueRangeFromPair(current: Candle, previous: Candle): number {
  const highLow = current.h - current.l;
  const highPrevClose = Math.abs(current.h - previous.c);
  const lowPrevClose = Math.abs(current.l - previous.c);
  return Math.max(highLow, highPrevClose, lowPrevClose);
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
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    const tr = trueRangeFromPair(current, previous);

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

export function atr(candles: Candle[], idx: number, period: number): number {
  if (idx < period) return NaN;

  let seed = 0;
  let val = NaN;

  for (let i = 1; i <= idx; i++) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    const tr = trueRangeFromPair(current, previous);

    if (i <= period) {
      seed += tr;
      if (i === period) val = seed / period;
      continue;
    }

    val = (val * (period - 1) + tr) / period;
  }

  return val;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

export function rsi(candles: Candle[], idx: number, period: number): number {
  if (idx < period) return NaN;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c; // non-null: idx >= period guard, dense window
    if (d > 0) gain += d;
    else loss += -d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i <= idx; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c; // non-null: bounds in rsi
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// ─── Volume ───────────────────────────────────────────────────────────────────

export function volumeRatio(
  candles: Candle[],
  idx: number,
  lookback: number,
): number {
  if (idx < lookback) return NaN;
  let sum = 0;
  for (let i = idx - lookback; i < idx; i++) sum += candles[i]!.v; // non-null: idx >= lookback guard
  const avg = sum / lookback;
  return avg === 0 ? 0 : candles[idx]!.v / avg; // non-null: idx in range
}

export function volumeTrend(
  candles: Candle[],
  idx: number,
  lookback: number = 10,
): number {
  if (idx < lookback) return 0;
  const half = Math.floor(lookback / 2);
  let first = 0,
    second = 0;
  for (let i = idx - lookback + 1; i <= idx - half; i++) first += candles[i]!.v; // non-null: volume trend window guard
  for (let i = idx - half + 1; i <= idx; i++) second += candles[i]!.v; // non-null: volume trend window guard
  if (first === 0) return second > 0 ? 1 : 0;
  return (second - first) / first;
}

function computeRegimeInputs(
  candles: Candle[],
  idx: number,
): {
  sma7: number;
  sma30: number;
  atr7: number;
  atr30: number;
  volTrend10: number;
} {
  const sma7Start = idx - 6;
  const sma30Start = idx - 29;
  const volStart = idx - 9;
  const volMid = idx - 5;

  let sumSma7 = 0;
  let sumSma30 = 0;
  let firstVol = 0;
  let secondVol = 0;

  for (let i = sma30Start; i <= idx; i++) {
    const candle = candles[i]!;
    const close = candle.c;
    if (i >= sma7Start) sumSma7 += close;
    sumSma30 += close;

    if (i >= volStart && i <= volMid) firstVol += candle.v;
    else if (i > volMid) secondVol += candle.v;
  }

  const [atr7, atr30] = atrPair(candles, idx, 7, 30);
  return {
    sma7: sumSma7 / 7,
    sma30: sumSma30 / 30,
    atr7,
    atr30,
    volTrend10:
      firstVol === 0
        ? secondVol > 0
          ? 1
          : 0
        : (secondVol - firstVol) / firstVol,
  };
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

export function adx(
  candles: Candle[],
  idx: number,
  period: number = 14,
): number {
  if (idx < period * 2) return NaN;

  let pDM = 0,
    mDM = 0,
    tr14 = 0;

  // Seed first `period` bars
  for (let i = 1; i <= period; i++) {
    const c = candles[i]!,
      p = candles[i - 1]!;
    const up = c.h - p.h,
      dn = p.l - c.l;
    pDM += up > dn && up > 0 ? up : 0;
    mDM += dn > up && dn > 0 ? dn : 0;
    tr14 += trueRange(candles, i);
  }

  let dxSeedSum = 0;
  let dxCount = 0;
  let adxVal = NaN;

  for (let i = period + 1; i <= idx; i++) {
    const c = candles[i]!,
      p = candles[i - 1]!;
    const up = c.h - p.h,
      dn = p.l - c.l;
    pDM = pDM - pDM / period + (up > dn && up > 0 ? up : 0);
    mDM = mDM - mDM / period + (dn > up && dn > 0 ? dn : 0);
    tr14 = tr14 - tr14 / period + trueRange(candles, i);

    let dx = 0;
    if (tr14 !== 0) {
      const pdi = (pDM / tr14) * 100;
      const mdi = (mDM / tr14) * 100;
      const sum = pdi + mdi;
      dx = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
    }

    if (dxCount < period) {
      dxSeedSum += dx;
      dxCount++;
      if (dxCount === period) adxVal = dxSeedSum / period;
      continue;
    }

    adxVal = (adxVal * (period - 1) + dx) / period;
  }

  return dxCount < period ? NaN : adxVal;
}

// ─── Regime detection ─────────────────────────────────────────────────────────

/**
 * Regime detection decision tree:
 *   len < 50                    → SIDEWAYS
 *   ATR(7)/ATR(30) > 1.8       → VOLATILE
 *   ADX(14) < 20               → SIDEWAYS
 *   SMA(7)/SMA(30) > 1.01:
 *     strong trend OR smaRatio>1.02 OR volTrend>0.1  → BULL
 *   SMA(7)/SMA(30) < 0.99:
 *     strong trend OR smaRatio<0.98 OR volTrend>0.1  → BEAR
 *   otherwise                  → SIDEWAYS
 */
export function detectRegime(candles: Candle[], idx: number): MarketRegime {
  if (idx < 49) return "SIDEWAYS";

  const {
    sma7: s7,
    sma30: s30,
    atr7,
    atr30,
    volTrend10,
  } = computeRegimeInputs(candles, idx);
  if (Number.isNaN(s7) || Number.isNaN(s30) || s30 === 0) return "SIDEWAYS";
  const smaRatio = s7 / s30;

  if (Number.isNaN(atr7) || Number.isNaN(atr30)) return "SIDEWAYS";
  const atrRatio = atr30 > 0 ? atr7 / atr30 : 1;

  // Volatile threshold relaxed from 1.8 to 2.0 — crypto is naturally volatile
  if (atrRatio > 2.0) return "VOLATILE";

  const adxVal = adx(candles, idx, 14);
  // ADX threshold lowered from 20 to 15: was classifying too many mild trends as SIDEWAYS
  if (!Number.isNaN(adxVal) && adxVal < 15) return "SIDEWAYS";

  // Relaxed SMA ratio thresholds: 1.005/0.995 instead of 1.01/0.99
  // Crypto trends often show mild SMA divergence but still trend strongly
  if (smaRatio > 1.005) {
    if (
      (!Number.isNaN(adxVal) && adxVal > 20) ||
      smaRatio > 1.015 ||
      volTrend10 > 0.1
    )
      return "BULL";
    return "SIDEWAYS";
  }
  if (smaRatio < 0.995) {
    if (
      (!Number.isNaN(adxVal) && adxVal > 20) ||
      smaRatio < 0.985 ||
      volTrend10 > 0.1
    )
      return "BEAR";
    return "SIDEWAYS";
  }
  return "SIDEWAYS";
}
