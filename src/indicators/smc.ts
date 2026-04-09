/**
 * SMC Indicators — Fair Value Gaps, Order Blocks, BOS/CHoCH, Liquidity Sweeps.
 * Pure functions. Zero I/O.
 */

import type { Candle, FVG, KeyZone, OrderBlock, PivotPoint, StructureBreak } from '../types.js'
import { atr } from './core.js'

// Re-export types for backward compatibility (canonical location: types.ts)
export type { PivotPoint, StructureBreak } from '../types.js'

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
export function detectFVG(candles: Candle[], idx: number, tolerance: number = 0): FVG | null {
  if (idx < 2) return null
  const left = candles[idx - 2]!
  const right = candles[idx]!

  if (right.l > left.h - tolerance) {
    const bottom = left.h, top = right.l
    return { top, bottom, midpoint: (top + bottom) / 2, bullish: true, index: idx }
  }
  if (right.h < left.l + tolerance) {
    const top = left.l, bottom = right.h
    return { top, bottom, midpoint: (top + bottom) / 2, bullish: false, index: idx }
  }
  return null
}

/**
 * Scan for all active (unfilled) FVGs up to upToIdx.
 * Filled = price retraces through midpoint (Consequent Encroachment).
 */
export function scanFVGs(candles: Candle[], upToIdx: number, tolerance: number = 0): FVG[] {
  const active: FVG[] = []

  for (let i = 2; i <= upToIdx; i++) {
    const fvg = detectFVG(candles, i, tolerance)
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
  tolerance: number = 0,
): PivotPoint[] {
  const pts: PivotPoint[] = []

  for (let i = lookback; i <= upToIdx - lookback; i++) {
    const c = candles[i]!
    let isHigh = true, isLow = true

    for (let j = 1; j <= lookback; j++) {
      if (c.h < candles[i - j]!.h - tolerance || c.h < candles[i + j]!.h - tolerance) isHigh = false
      if (c.l > candles[i - j]!.l + tolerance || c.l > candles[i + j]!.l + tolerance) isLow = false
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
  params: { swingLookback?: number; tolerance?: number; minPivotSpacing?: number } = {},
): StructureBreak[] {
  const tol = params.tolerance ?? 0
  const minSpacing = params.minPivotSpacing ?? 5
  const pivots = findPivots(candles, upToIdx, params.swingLookback ?? 3, tol)
  const breaks: StructureBreak[] = []

  // Filter out clustered pivots — require minimum bar spacing between pivots of same kind
  const filterClustered = (pts: PivotPoint[]): PivotPoint[] => {
    if (pts.length <= 1) return pts
    const result: PivotPoint[] = [pts[0]!]
    for (let i = 1; i < pts.length; i++) {
      const prev = result[result.length - 1]!
      const cur = pts[i]!
      if (cur.index - prev.index >= minSpacing) {
        result.push(cur)
      } else if ((cur.kind === 'high' && cur.price > prev.price) ||
                 (cur.kind === 'low' && cur.price < prev.price)) {
        // Keep the more extreme pivot in a cluster
        result[result.length - 1] = cur
      }
    }
    return result
  }

  const highs = filterClustered(pivots.filter(p => p.kind === 'high'))
  const lows = filterClustered(pivots.filter(p => p.kind === 'low'))
  if (highs.length < 2 || lows.length < 2) return breaks

  // Require minimum price distance between pivots (0.5 ATR) to avoid noise breaks
  const curAtr = atr(candles, upToIdx, 14)
  const minPriceDist = !isNaN(curAtr) ? curAtr * 0.5 : 0

  const c = candles[upToIdx]!
  const prevHigh = highs[highs.length - 2]!
  const prevLow = lows[lows.length - 2]!
  const lastHigh = highs[highs.length - 1]!
  const lastLow = lows[lows.length - 1]!

  // Bullish BOS: close > prev swing high (with tolerance)
  if (c.c > prevHigh.price - tol && Math.abs(c.c - prevHigh.price) >= minPriceDist * 0.3) {
    const isCHoCH = lastLow.price < lows[Math.max(0, lows.length - 3)]!.price
    breaks.push({ kind: isCHoCH ? 'choch' : 'bos', direction: 'bullish', level: prevHigh.price, index: upToIdx })
  }

  // Bearish BOS: close < prev swing low (with tolerance)
  if (c.c < prevLow.price + tol && Math.abs(c.c - prevLow.price) >= minPriceDist * 0.3) {
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

// ─── Key zone compilation ─────────────────────────────────────────────────────

interface RawZone {
  top: number
  bottom: number
  kind: 'demand' | 'supply'
  origin: string
  sourceIdx: number
}

function mergeAndRank(
  raw: RawZone[],
  kind: 'demand' | 'supply',
  candles: Candle[],
  upToIdx: number,
  mergeGap: number,
  max: number,
): KeyZone[] {
  if (raw.length === 0) return []
  raw.sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2)

  const merged: Array<{ top: number; bottom: number; origins: string[]; touches: number; lastTouch: number; broken: boolean; latestSourceIdx: number }> = []
  let cur = { top: raw[0]!.top, bottom: raw[0]!.bottom, origins: [raw[0]!.origin], touches: 0, lastTouch: -1, broken: false, latestSourceIdx: raw[0]!.sourceIdx }

  for (let i = 1; i < raw.length; i++) {
    const z = raw[i]!
    const curMid = (cur.top + cur.bottom) / 2
    const zMid = (z.top + z.bottom) / 2

    if (Math.abs(curMid - zMid) <= mergeGap) {
      cur.top = Math.max(cur.top, z.top)
      cur.bottom = Math.min(cur.bottom, z.bottom)
      cur.origins.push(z.origin)
      cur.latestSourceIdx = Math.max(cur.latestSourceIdx, z.sourceIdx)
    } else {
      merged.push(cur)
      cur = { top: z.top, bottom: z.bottom, origins: [z.origin], touches: 0, lastTouch: -1, broken: false, latestSourceIdx: z.sourceIdx }
    }
  }
  merged.push(cur)

  for (const zone of merged) {
    for (let i = zone.latestSourceIdx + 1; i <= upToIdx; i++) {
      const c = candles[i]!
      const touched = kind === 'demand'
        ? c.l <= zone.top && c.l >= zone.bottom
        : c.h >= zone.bottom && c.h <= zone.top
      if (touched) { zone.touches++; zone.lastTouch = i }
      const broken = kind === 'demand' ? c.c < zone.bottom : c.c > zone.top
      if (broken) zone.broken = true
    }
  }

  const zones: KeyZone[] = merged
    .filter(z => !z.broken)
    .map(z => {
      const sourceScore = Math.min(z.origins.length / 2, 1)  // easier to reach 1.0 (2 sources = max)
      const recency = Math.min((z.latestSourceIdx + 1) / (upToIdx + 1), 1)  // more recent creation = higher
      // Fresh untested zones are STRONGER (institutional zones — first touch is the reaction)
      // Multi-tested zones are weaker (diminishing returns each retest)
      const touchScore = z.touches === 0 ? 1.0 : z.touches === 1 ? 0.7 : 0.4
      const strength = Math.min(sourceScore * 0.35 + recency * 0.30 + touchScore * 0.35, 1)
      return {
        type: kind,
        top: z.top,
        bottom: z.bottom,
        strength,
        origin: z.origins[0]!,
        createdAtIdx: z.latestSourceIdx,
      }
    })

  zones.sort((a, b) => b.strength - a.strength)
  return zones.slice(0, max)
}

export function compileKeyZones(
  candles: Candle[],
  upToIdx: number,
  tolerance: number = 0,
): { demandZones: KeyZone[]; supplyZones: KeyZone[] } {
  if (upToIdx < 30) return { demandZones: [], supplyZones: [] }

  const curATR = atr(candles, upToIdx, 14)
  if (isNaN(curATR) || curATR === 0) return { demandZones: [], supplyZones: [] }

  const thick = curATR * 0.3
  const mergeGap = curATR * 0.5
  const MAX_ZONES = 8

  const raw: RawZone[] = []

  for (const ob of detectOrderBlocks(candles, upToIdx, { lookback: 50 })) {
    raw.push({ top: ob.top, bottom: ob.bottom, kind: ob.bullish ? 'demand' : 'supply', origin: 'order-block', sourceIdx: ob.index })
  }

  for (const p of findPivots(candles, upToIdx, 3, tolerance)) {
    if (p.kind === 'low') {
      raw.push({ top: p.price + thick, bottom: p.price, kind: 'demand', origin: 'swing', sourceIdx: p.index })
    } else {
      raw.push({ top: p.price, bottom: p.price - thick, kind: 'supply', origin: 'swing', sourceIdx: p.index })
    }
  }

  for (const fvg of scanFVGs(candles, upToIdx, tolerance)) {
    raw.push({ top: fvg.top, bottom: fvg.bottom, kind: fvg.bullish ? 'demand' : 'supply', origin: 'fvg', sourceIdx: fvg.index })
  }

  const demand = raw.filter(z => z.kind === 'demand')
  const supply = raw.filter(z => z.kind === 'supply')

  const demandZones = mergeAndRank(demand, 'demand', candles, upToIdx, mergeGap, MAX_ZONES)
  const supplyZones = mergeAndRank(supply, 'supply', candles, upToIdx, mergeGap, MAX_ZONES)

  const price = candles[upToIdx]!.c
  const midOf = (z: KeyZone) => (z.top + z.bottom) / 2
  demandZones.sort((a, b) => Math.abs(price - midOf(a)) - Math.abs(price - midOf(b)))
  supplyZones.sort((a, b) => Math.abs(price - midOf(a)) - Math.abs(price - midOf(b)))

  return { demandZones, supplyZones }
}

// ─── ICT HTF Structure Bias ──────────────────────────────────────────────────

/**
 * Determine Higher Timeframe structure bias from swing sequence.
 * ICT rule: HTF dictates direction — HH+HL = bullish, LH+LL = bearish.
 *
 * Returns 'bullish' | 'bearish' | 'neutral' with a confidence score.
 * Requires at least 4 pivots to determine swing sequence.
 */
export function htfStructureBias(
  candles: Candle[],
  upToIdx: number,
  params: { swingLookback?: number; tolerance?: number } = {},
): { bias: 'bullish' | 'bearish' | 'neutral'; confidence: number } {
  const tol = params.tolerance ?? 0
  const pivots = findPivots(candles, upToIdx, params.swingLookback ?? 5, tol)
  const highs = pivots.filter(p => p.kind === 'high')
  const lows = pivots.filter(p => p.kind === 'low')

  if (highs.length < 2 || lows.length < 2) return { bias: 'neutral', confidence: 0 }

  // Check last 3 swing highs and lows for pattern
  const recentHighs = highs.slice(-3)
  const recentLows = lows.slice(-3)

  let hhCount = 0, hlCount = 0, lhCount = 0, llCount = 0

  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i]!.price > recentHighs[i - 1]!.price) hhCount++
    else lhCount++
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i]!.price > recentLows[i - 1]!.price) hlCount++
    else llCount++
  }

  // Also check BOS/CHoCH for confirmation
  const breaks = detectStructureBreaks(candles, upToIdx, params)
  const recentBreak = breaks.at(-1)

  // Bullish: HH + HL sequence
  if (hhCount > 0 && hlCount > 0) {
    const conf = recentBreak?.direction === 'bullish' ? 0.9 : 0.7
    return { bias: 'bullish', confidence: conf }
  }

  // Bearish: LH + LL sequence
  if (lhCount > 0 && llCount > 0) {
    const conf = recentBreak?.direction === 'bearish' ? 0.9 : 0.7
    return { bias: 'bearish', confidence: conf }
  }

  // Mixed — use BOS direction as tiebreaker
  if (recentBreak) {
    return { bias: recentBreak.direction, confidence: 0.5 }
  }

  return { bias: 'neutral', confidence: 0 }
}

// ─── ICT Displacement Detection ─────────────────────────────────────────────

/**
 * Detect displacement candles — strong momentum candles that create BOS/CHoCH.
 * ICT: Displacement = large body candle (>1.5× ATR) that breaks structure.
 * These candles are the source of institutional order flow.
 */
export function isDisplacementCandle(
  candles: Candle[],
  idx: number,
  atrVal: number,
  minBodyAtrMult: number = 1.0,
): boolean {
  if (idx < 0 || idx >= candles.length) return false
  const c = candles[idx]!
  const bodySize = Math.abs(c.c - c.o)
  return bodySize > atrVal * minBodyAtrMult
}

// ─── ICT Equal Highs/Lows (Liquidity Pools) ────────────────────────────────

export interface LiquidityPool {
  level: number
  type: 'bsl' | 'ssl'  // Buy-side / Sell-side liquidity
  count: number         // how many equal levels cluster here
  index: number         // most recent contributing pivot index
}

/**
 * Detect equal highs and equal lows — ICT liquidity pools.
 * BSL (Buy-Side Liquidity): cluster of equal highs = stop losses above
 * SSL (Sell-Side Liquidity): cluster of equal lows = stop losses below
 *
 * Smart money targets these pools for stop hunts before the real move.
 */
export function findLiquidityPools(
  candles: Candle[],
  upToIdx: number,
  params: { tolerance?: number; minCluster?: number; lookback?: number } = {},
): LiquidityPool[] {
  const tol = params.tolerance ?? 0
  const minCluster = params.minCluster ?? 2
  const pivots = findPivots(candles, upToIdx, 3, tol)
  const pools: LiquidityPool[] = []

  // Group highs by price proximity
  const highs = pivots.filter(p => p.kind === 'high')
  const lows = pivots.filter(p => p.kind === 'low')

  const curATR = atr(candles, upToIdx, 14)
  if (isNaN(curATR) || curATR <= 0) return pools
  const clusterTol = curATR * 0.15  // 15% of ATR = "equal" level

  // Find BSL (equal highs)
  for (let i = 0; i < highs.length; i++) {
    let count = 1
    let maxIdx = highs[i]!.index
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[j]!.price - highs[i]!.price) <= clusterTol) {
        count++
        maxIdx = Math.max(maxIdx, highs[j]!.index)
      }
    }
    if (count >= minCluster) {
      pools.push({ level: highs[i]!.price, type: 'bsl', count, index: maxIdx })
    }
  }

  // Find SSL (equal lows)
  for (let i = 0; i < lows.length; i++) {
    let count = 1
    let maxIdx = lows[i]!.index
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[j]!.price - lows[i]!.price) <= clusterTol) {
        count++
        maxIdx = Math.max(maxIdx, lows[j]!.index)
      }
    }
    if (count >= minCluster) {
      pools.push({ level: lows[i]!.price, type: 'ssl', count, index: maxIdx })
    }
  }

  return pools
}

// ─── S&D re-exports (canonical location: supply-demand.ts) ────────────────────
export { premiumDiscount, oteZone } from './supply-demand.js'
