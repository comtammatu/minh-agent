/**
 * Core indicators: SMA, EMA, ATR, RSI, ADX, volumeRatio, volumeTrend, detectRegime.
 * Pure functions. Zero I/O. Return NaN for insufficient data (caller must check).
 */

import type { Candle, MarketRegime } from '../types.js'

// ─── Moving averages ───────────────────────────────────────────────────────────

export function sma(candles: Candle[], idx: number, period: number): number {
  if (idx < period - 1) return NaN
  let sum = 0
  for (let i = idx - period + 1; i <= idx; i++) sum += candles[i]!.c
  return sum / period
}

export function ema(candles: Candle[], idx: number, period: number): number {
  if (idx < period - 1) return NaN
  const k = 2 / (period + 1)
  let value = sma(candles, period - 1, period)
  for (let i = period; i <= idx; i++) {
    value = (candles[i]!.c - value) * k + value
  }
  return value
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

function trueRange(candles: Candle[], idx: number): number {
  if (idx === 0) return candles[0]!.h - candles[0]!.l
  const c = candles[idx]!
  const p = candles[idx - 1]!
  return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c))
}

export function atr(candles: Candle[], idx: number, period: number): number {
  if (idx < period) return NaN
  // Seed: average of first `period` true ranges
  let val = 0
  for (let i = 1; i <= period; i++) val += trueRange(candles, i)
  val /= period
  // Wilder's smoothing
  for (let i = period + 1; i <= idx; i++) {
    val = (val * (period - 1) + trueRange(candles, i)) / period
  }
  return val
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

export function rsi(candles: Candle[], idx: number, period: number): number {
  if (idx < period) return NaN
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c
    if (d > 0) gain += d
    else loss += -d
  }
  gain /= period
  loss /= period
  for (let i = period + 1; i <= idx; i++) {
    const d = candles[i]!.c - candles[i - 1]!.c
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period
  }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}

// ─── Volume ───────────────────────────────────────────────────────────────────

export function volumeRatio(candles: Candle[], idx: number, lookback: number): number {
  if (idx < lookback) return NaN
  let sum = 0
  for (let i = idx - lookback; i < idx; i++) sum += candles[i]!.v
  const avg = sum / lookback
  return avg === 0 ? 0 : candles[idx]!.v / avg
}

export function volumeTrend(candles: Candle[], idx: number, lookback: number = 10): number {
  if (idx < lookback) return 0
  const half = Math.floor(lookback / 2)
  let first = 0, second = 0
  for (let i = idx - lookback + 1; i <= idx - half; i++) first += candles[i]!.v
  for (let i = idx - half + 1; i <= idx; i++) second += candles[i]!.v
  if (first === 0) return second > 0 ? 1 : 0
  return (second - first) / first
}

// ─── ADX ──────────────────────────────────────────────────────────────────────

export function adx(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period * 2) return NaN

  // Build DX series from bar 1 → idx
  let pDM = 0, mDM = 0, tr14 = 0

  // Seed first `period` bars
  for (let i = 1; i <= period; i++) {
    const c = candles[i]!, p = candles[i - 1]!
    const up = c.h - p.h, dn = p.l - c.l
    pDM += (up > dn && up > 0) ? up : 0
    mDM += (dn > up && dn > 0) ? dn : 0
    tr14 += trueRange(candles, i)
  }

  const dxArr: number[] = []

  for (let i = period + 1; i <= idx; i++) {
    const c = candles[i]!, p = candles[i - 1]!
    const up = c.h - p.h, dn = p.l - c.l
    pDM = pDM - pDM / period + ((up > dn && up > 0) ? up : 0)
    mDM = mDM - mDM / period + ((dn > up && dn > 0) ? dn : 0)
    tr14 = tr14 - tr14 / period + trueRange(candles, i)

    if (tr14 === 0) { dxArr.push(0); continue }
    const pdi = pDM / tr14 * 100
    const mdi = mDM / tr14 * 100
    const sum = pdi + mdi
    dxArr.push(sum === 0 ? 0 : Math.abs(pdi - mdi) / sum * 100)
  }

  if (dxArr.length < period) return NaN

  // ADX: Wilder's smoothing of DX
  let adxVal = 0
  for (let i = 0; i < period; i++) adxVal += dxArr[i]!
  adxVal /= period
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]!) / period
  }
  return adxVal
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
  if (idx < 49) return 'SIDEWAYS'

  const s7 = sma(candles, idx, 7)
  const s30 = sma(candles, idx, 30)
  if (isNaN(s7) || isNaN(s30) || s30 === 0) return 'SIDEWAYS'
  const smaRatio = s7 / s30

  const atr7 = atr(candles, idx, 7)
  const atr30 = atr(candles, idx, 30)
  if (isNaN(atr7) || isNaN(atr30)) return 'SIDEWAYS'
  const atrRatio = atr30 > 0 ? atr7 / atr30 : 1

  if (atrRatio > 1.8) return 'VOLATILE'

  const adxVal = adx(candles, idx, 14)
  if (!isNaN(adxVal) && adxVal < 20) return 'SIDEWAYS'

  const volTrend = volumeTrend(candles, idx, 10)
  const strongTrend = !isNaN(adxVal) && adxVal > 30

  if (smaRatio > 1.01) {
    if (strongTrend || smaRatio > 1.02 || volTrend > 0.1) return 'BULL'
    return 'SIDEWAYS'
  }
  if (smaRatio < 0.99) {
    if (strongTrend || smaRatio < 0.98 || volTrend > 0.1) return 'BEAR'
    return 'SIDEWAYS'
  }
  return 'SIDEWAYS'
}
