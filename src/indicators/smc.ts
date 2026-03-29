/**
 * SMC Indicators — Fair Value Gaps, Order Blocks, BOS/CHoCH, Liquidity Sweeps.
 * Pure functions. Zero I/O.
 */

import type { Candle, FVG, OrderBlock } from '../types.js'

// ─── Internal types ────────────────────────────────────────────────────────────

/** Raw pivot high/low point (used internally + by structure.ts). */
export interface PivotPoint {
  kind: 'high' | 'low'
  price: number
  index: number
}

export interface StructureBreak {
  kind: 'bos' | 'choch'
  direction: 'bullish' | 'bearish'
  level: number
  index: number
}

export interface LiquiditySweep {
  direction: 'bullish' | 'bearish'
  level: number
}

// ─── Fair Value Gap ────────────────────────────────────────────────────────────

/**
 * Detect FVG at idx.
 * Bullish: candles[idx-2].high < candles[idx].low
 * Bearish: candles[idx-2].low  > candles[idx].high
 */
export function detectFVG(candles: Candle[], idx: number): FVG | null {
  if (idx < 2) return null
  const left = candles[idx - 2]!
  const right = candles[idx]!

  if (right.l > left.h) {
    const bottom = left.h, top = right.l
    return { top, bottom, midpoint: (top + bottom) / 2, bullish: true, index: idx }
  }
  if (right.h < left.l) {
    const top = left.l, bottom = right.h
    return { top, bottom, midpoint: (top + bottom) / 2, bullish: false, index: idx }
  }
  return null
}

/**
 * Scan for all active (unfilled) FVGs up to upToIdx.
 * Filled = price retraces through midpoint (Consequent Encroachment).
 */
export function scanFVGs(candles: Candle[], upToIdx: number): FVG[] {
  const active: FVG[] = []

  for (let i = 2; i <= upToIdx; i++) {
    const fvg = detectFVG(candles, i)
    if (!fvg) continue

    // Check if filled by any subsequent candle
    let filled = false
    for (let j = i + 1; j <= upToIdx; j++) {
      const c = candles[j]!
      if (fvg.bullish && c.l <= fvg.midpoint) { filled = true; break }
      if (!fvg.bullish && c.h >= fvg.midpoint) { filled = true; break }
    }
    if (!filled) active.push(fvg)
  }

  return active
}

// ─── Order Blocks ──────────────────────────────────────────────────────────────

/**
 * Detect OBs up to upToIdx.
 * Bullish OB: bearish candle before 1.5× bullish impulse.
 * Bearish OB: bullish candle before 1.5× bearish impulse.
 */
export function detectOrderBlocks(
  candles: Candle[],
  upToIdx: number,
  params: { impulseMultiplier?: number; lookback?: number } = {},
): OrderBlock[] {
  const mult = params.impulseMultiplier ?? 1.5
  const lb = params.lookback ?? 50
  const start = Math.max(1, upToIdx - lb)
  const blocks: OrderBlock[] = []

  for (let i = start; i < upToIdx; i++) {
    const cur = candles[i]!
    const nxt = candles[i + 1]
    if (!nxt) continue

    const curBody = Math.abs(cur.c - cur.o)
    const nxtBody = Math.abs(nxt.c - nxt.o)
    if (nxtBody < curBody * mult) continue

    if (cur.c < cur.o && nxt.c > nxt.o) {
      // Bullish OB: bearish candle before bullish impulse
      blocks.push({ top: cur.o, bottom: cur.l, bullish: true, index: i, tested: false })
    } else if (cur.c > cur.o && nxt.c < nxt.o) {
      // Bearish OB: bullish candle before bearish impulse
      blocks.push({ top: cur.h, bottom: cur.o, bullish: false, index: i, tested: false })
    }
  }

  // Mark tested (price revisited zone)
  for (const ob of blocks) {
    for (let i = ob.index + 2; i <= upToIdx; i++) {
      const c = candles[i]!
      if (ob.bullish && c.l <= ob.top && c.l >= ob.bottom) { ob.tested = true; break }
      if (!ob.bullish && c.h >= ob.bottom && c.h <= ob.top) { ob.tested = true; break }
    }
  }

  return blocks
}

// ─── Pivot swing points ────────────────────────────────────────────────────────

/**
 * Find raw pivot highs/lows. A pivot high at i requires i to have the highest high
 * among [i-lookback .. i+lookback].
 */
export function findPivots(
  candles: Candle[],
  upToIdx: number,
  lookback: number = 3,
): PivotPoint[] {
  const pts: PivotPoint[] = []

  for (let i = lookback; i <= upToIdx - lookback; i++) {
    const c = candles[i]!
    let isHigh = true, isLow = true

    for (let j = 1; j <= lookback; j++) {
      if (c.h <= candles[i - j]!.h || c.h <= candles[i + j]!.h) isHigh = false
      if (c.l >= candles[i - j]!.l || c.l >= candles[i + j]!.l) isLow = false
    }

    if (isHigh) pts.push({ kind: 'high', price: c.h, index: i })
    if (isLow) pts.push({ kind: 'low', price: c.l, index: i })
  }

  return pts.sort((a, b) => a.index - b.index)
}

// ─── BOS / CHoCH ──────────────────────────────────────────────────────────────

/**
 * Detect Break of Structure (BOS) or Change of Character (CHoCH) at upToIdx.
 * BOS = continuation; CHoCH = reversal signal.
 */
export function detectStructureBreaks(
  candles: Candle[],
  upToIdx: number,
  params: { swingLookback?: number } = {},
): StructureBreak[] {
  const pivots = findPivots(candles, upToIdx, params.swingLookback ?? 3)
  const breaks: StructureBreak[] = []

  const highs = pivots.filter(p => p.kind === 'high')
  const lows = pivots.filter(p => p.kind === 'low')
  if (highs.length < 2 || lows.length < 2) return breaks

  const c = candles[upToIdx]!
  const prevHigh = highs[highs.length - 2]!
  const prevLow = lows[lows.length - 2]!
  const lastHigh = highs[highs.length - 1]!
  const lastLow = lows[lows.length - 1]!

  // Bullish BOS: close > prev swing high
  if (c.c > prevHigh.price) {
    const isCHoCH = lastLow.price < lows[Math.max(0, lows.length - 3)]!.price
    breaks.push({ kind: isCHoCH ? 'choch' : 'bos', direction: 'bullish', level: prevHigh.price, index: upToIdx })
  }

  // Bearish BOS: close < prev swing low
  if (c.c < prevLow.price) {
    const isCHoCH = lastHigh.price > highs[Math.max(0, highs.length - 3)]!.price
    breaks.push({ kind: isCHoCH ? 'choch' : 'bos', direction: 'bearish', level: prevLow.price, index: upToIdx })
  }

  return breaks
}

// ─── Liquidity sweep ──────────────────────────────────────────────────────────

/**
 * Detect liquidity sweep at idx: wick pierces recent high/low then closes back inside.
 * wickRatio = wick must be > ratio of total candle range.
 */
export function detectLiquiditySweep(
  candles: Candle[],
  idx: number,
  params: { lookback?: number; wickRatio?: number } = {},
): LiquiditySweep | null {
  const lb = params.lookback ?? 20
  const wr = params.wickRatio ?? 0.6
  if (idx < lb) return null

  const c = candles[idx]!
  const range = c.h - c.l
  if (range === 0) return null

  let recentLow = Infinity, recentHigh = -Infinity
  for (let i = idx - lb; i < idx; i++) {
    const x = candles[i]!
    if (x.l < recentLow) recentLow = x.l
    if (x.h > recentHigh) recentHigh = x.h
  }

  const lowerWick = Math.min(c.o, c.c) - c.l
  if (c.l < recentLow && c.c > recentLow && lowerWick / range > wr) {
    return { direction: 'bullish', level: recentLow }
  }

  const upperWick = c.h - Math.max(c.o, c.c)
  if (c.h > recentHigh && c.c < recentHigh && upperWick / range > wr) {
    return { direction: 'bearish', level: recentHigh }
  }

  return null
}

// ─── Premium/Discount Zone ────────────────────────────────────────────────────

/**
 * Determine if price is in premium, discount, or equilibrium relative to a swing range.
 * Premium = above midpoint (sell zone), Discount = below midpoint (buy zone).
 * 0.5% buffer around equilibrium to avoid noise.
 */
export function premiumDiscount(
  swingHigh: number,
  swingLow: number,
  price: number,
): 'premium' | 'discount' | 'equilibrium' {
  if (swingHigh <= swingLow) return 'equilibrium'
  const eq = (swingHigh + swingLow) / 2
  if (price > eq * 1.005) return 'premium'
  if (price < eq * 0.995) return 'discount'
  return 'equilibrium'
}

// ─── Optimal Trade Entry (OTE) ────────────────────────────────────────────────

/**
 * OTE = Fib 62%–79% retracement zone of an impulse move (swingA → swingB).
 * Bullish impulse (B > A): retracement zone is below B.
 * Bearish impulse (B < A): retracement zone is above B.
 * Returns null if swingA === swingB (no range).
 */
export function oteZone(
  swingA: number,
  swingB: number,
): { top: number; bottom: number } | null {
  const range = Math.abs(swingB - swingA)
  if (range === 0) return null
  if (swingB > swingA) {
    // Bullish impulse — OTE is a pullback zone below swingB
    return { top: swingB - range * 0.62, bottom: swingB - range * 0.79 }
  } else {
    // Bearish impulse — OTE is a pullback zone above swingB
    return { top: swingB + range * 0.79, bottom: swingB + range * 0.62 }
  }
}
