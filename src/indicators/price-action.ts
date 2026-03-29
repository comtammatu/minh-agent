/**
 * Price Action Indicators — candlestick pattern detection.
 * Single-candle: Doji (standard, dragonfly, gravestone), Pin Bar, Hammer, Shooting Star.
 * Multi-candle: Engulfing, Tweezer Top/Bottom, Inside Bar, Outside Bar.
 * Pure functions. Zero I/O.
 */

import type { Candle } from '../types.js'
import { atr } from './core.js'

export type PAPatternName =
  | 'doji' | 'dragonfly_doji' | 'gravestone_doji'
  | 'pin_bar' | 'hammer' | 'shooting_star'
  | 'bullish_engulfing' | 'bearish_engulfing'
  | 'tweezer_bottom' | 'tweezer_top'
  | 'inside_bar' | 'outside_bar'

export interface CandlePattern {
  name: PAPatternName
  direction: 'bullish' | 'bearish' | 'neutral'
  strength: number  // 0–1
  index: number
}

// ─── Candle helpers ────────────────────────────────────────────────────────────

const spread = (c: Candle) => c.h - c.l
const body = (c: Candle) => Math.abs(c.c - c.o)
const lowerWick = (c: Candle) => Math.min(c.o, c.c) - c.l
const upperWick = (c: Candle) => c.h - Math.max(c.o, c.c)
const bodyTop = (c: Candle) => Math.max(c.o, c.c)
const bodyBot = (c: Candle) => Math.min(c.o, c.c)
const isBullish = (c: Candle) => c.c > c.o
const isBearish = (c: Candle) => c.c < c.o

function trendAt(candles: Candle[], idx: number, lookback: number): 'up' | 'down' | 'flat' {
  if (idx < lookback) return 'flat'
  const change = candles[idx]!.c - candles[idx - lookback]!.c
  const a = atr(candles, idx, lookback)
  if (isNaN(a) || a === 0) return 'flat'
  if (change > a * 0.5) return 'up'
  if (change < -a * 0.5) return 'down'
  return 'flat'
}

// ─── Single-candle patterns ───────────────────────────────────────────────────

function doji(c: Candle, idx: number, atrVal: number): CandlePattern | null {
  const s = spread(c)
  if (s === 0) return null
  if (body(c) / s > 0.1) return null  // body > 10% of spread → not doji

  const lw = lowerWick(c), uw = upperWick(c)

  if (lw > s * 0.6 && uw < s * 0.1) {
    return { name: 'dragonfly_doji', direction: 'bullish', strength: Math.min(lw / atrVal, 1), index: idx }
  }
  if (uw > s * 0.6 && lw < s * 0.1) {
    return { name: 'gravestone_doji', direction: 'bearish', strength: Math.min(uw / atrVal, 1), index: idx }
  }
  return { name: 'doji', direction: 'neutral', strength: 0.4, index: idx }
}

function pinBar(c: Candle, idx: number, atrVal: number, trend: 'up' | 'down' | 'flat'): CandlePattern | null {
  const s = spread(c), b = body(c)
  if (s === 0 || b === 0) return null
  const lw = lowerWick(c), uw = upperWick(c)

  if (lw > s * 0.6 && b < s * 0.3 && uw < s * 0.2 && trend !== 'up') {
    return { name: 'pin_bar', direction: 'bullish', strength: Math.min(lw / atrVal, 1), index: idx }
  }
  if (uw > s * 0.6 && b < s * 0.3 && lw < s * 0.2 && trend !== 'down') {
    return { name: 'pin_bar', direction: 'bearish', strength: Math.min(uw / atrVal, 1), index: idx }
  }
  return null
}

function hammerShootingStar(c: Candle, idx: number, atrVal: number, trend: 'up' | 'down' | 'flat'): CandlePattern | null {
  const b = body(c)
  if (b === 0) return null
  const lw = lowerWick(c), uw = upperWick(c)

  if (isBullish(c) && lw >= b * 2 && uw < b * 0.5 && trend === 'down') {
    return { name: 'hammer', direction: 'bullish', strength: Math.min(lw / atrVal, 1), index: idx }
  }
  if (isBearish(c) && uw >= b * 2 && lw < b * 0.5 && trend === 'up') {
    return { name: 'shooting_star', direction: 'bearish', strength: Math.min(uw / atrVal, 1), index: idx }
  }
  return null
}

// ─── Multi-candle patterns ────────────────────────────────────────────────────

function engulfing(candles: Candle[], idx: number): CandlePattern | null {
  if (idx < 1) return null
  const p = candles[idx - 1]!, c = candles[idx]!

  if (isBearish(p) && isBullish(c) && bodyBot(c) < bodyBot(p) && bodyTop(c) > bodyTop(p)) {
    const ratio = body(c) / Math.max(body(p), 0.0001)
    return { name: 'bullish_engulfing', direction: 'bullish', strength: Math.min(ratio / 3, 1), index: idx }
  }
  if (isBullish(p) && isBearish(c) && bodyBot(c) < bodyBot(p) && bodyTop(c) > bodyTop(p)) {
    const ratio = body(c) / Math.max(body(p), 0.0001)
    return { name: 'bearish_engulfing', direction: 'bearish', strength: Math.min(ratio / 3, 1), index: idx }
  }
  return null
}

function tweezer(candles: Candle[], idx: number, atrVal: number): CandlePattern | null {
  if (idx < 1) return null
  const p = candles[idx - 1]!, c = candles[idx]!
  const tol = atrVal * 0.05

  if (Math.abs(p.h - c.h) < tol && isBullish(p) && isBearish(c)) {
    return { name: 'tweezer_top', direction: 'bearish', strength: 0.6, index: idx }
  }
  if (Math.abs(p.l - c.l) < tol && isBearish(p) && isBullish(c)) {
    return { name: 'tweezer_bottom', direction: 'bullish', strength: 0.6, index: idx }
  }
  return null
}

function insideOutside(candles: Candle[], idx: number): CandlePattern | null {
  if (idx < 1) return null
  const p = candles[idx - 1]!, c = candles[idx]!

  if (c.h <= p.h && c.l >= p.l) {
    const dir = isBullish(c) ? 'bullish' : isBearish(c) ? 'bearish' : 'neutral'
    return { name: 'inside_bar', direction: dir, strength: 0.5, index: idx }
  }
  if (c.h > p.h && c.l < p.l) {
    return { name: 'outside_bar', direction: isBullish(c) ? 'bullish' : 'bearish', strength: 0.7, index: idx }
  }
  return null
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect all candlestick patterns at idx.
 * Returns multiple patterns if more than one fires.
 */
export function detectPriceAction(
  candles: Candle[],
  idx: number,
  params: { lookback?: number } = {},
): CandlePattern[] {
  const lb = params.lookback ?? 14
  if (idx < lb) return []

  const a = atr(candles, idx, lb)
  if (isNaN(a) || a === 0) return []

  const c = candles[idx]!
  const trend = trendAt(candles, idx, lb)
  const patterns: CandlePattern[] = []

  // Single-candle: doji is mutually exclusive with pin bar / hammer
  const d = doji(c, idx, a)
  if (d) {
    patterns.push(d)
  } else {
    const pb = pinBar(c, idx, a, trend)
    if (pb) patterns.push(pb)
    const hs = hammerShootingStar(c, idx, a, trend)
    if (hs) patterns.push(hs)
  }

  // Multi-candle (can stack with single-candle)
  const eng = engulfing(candles, idx)
  if (eng) patterns.push(eng)

  const tw = tweezer(candles, idx, a)
  if (tw) patterns.push(tw)

  const io = insideOutside(candles, idx)
  if (io) patterns.push(io)

  return patterns
}
