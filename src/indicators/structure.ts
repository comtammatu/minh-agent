/**
 * Market Structure Analyzer — swing classification, structural bias, key zone compilation.
 *
 * Flow: candles → findPivots → classifySwings (HH/HL/LH/LL)
 *               → detectStructuralBias (bullish/bearish/neutral + confidence)
 *               → compileKeyZones (OBs + FVGs + swings → merged, ranked)
 *               → analyzeStructure (top-level: combines all three)
 * Pure functions. Zero I/O.
 */

import type { Candle, KeyZone, MarketStructure, SwingPoint, SwingType } from '../types.js'
import { findPivots, detectOrderBlocks, scanFVGs } from './smc.js'
import { atr } from './core.js'

// ─── Swing classification ──────────────────────────────────────────────────────

/**
 * Classify pivot highs/lows as HH/HL/LH/LL by comparing each pivot to
 * the previous pivot of the same type. EH/EL (equal) are omitted.
 */
export function classifySwings(candles: Candle[], upToIdx: number): SwingPoint[] {
  const pivots = findPivots(candles, upToIdx, 3)
  const out: SwingPoint[] = []
  let lastHigh: number | null = null
  let lastLow: number | null = null

  for (const p of pivots) {
    if (p.kind === 'high') {
      if (lastHigh !== null && p.price !== lastHigh) {
        const t: SwingType = p.price > lastHigh ? 'HH' : 'LH'
        out.push({ type: t, price: p.price, index: p.index })
      }
      lastHigh = p.price
    } else {
      if (lastLow !== null && p.price !== lastLow) {
        const t: SwingType = p.price > lastLow ? 'HL' : 'LL'
        out.push({ type: t, price: p.price, index: p.index })
      }
      lastLow = p.price
    }
  }

  return out.sort((a, b) => a.index - b.index)
}

// ─── Structural bias ───────────────────────────────────────────────────────────

export function detectStructuralBias(swings: SwingPoint[]): { bias: 'bullish' | 'bearish' | 'neutral'; confidence: number } {
  if (swings.length < 4) return { bias: 'neutral', confidence: 0 }

  const window = swings.slice(-Math.min(swings.length, 10))
  let bullish = 0, bearish = 0

  for (const s of window) {
    if (s.type === 'HH' || s.type === 'HL') bullish++
    else if (s.type === 'LH' || s.type === 'LL') bearish++
  }

  const total = bullish + bearish
  if (total === 0) return { bias: 'neutral', confidence: 0 }

  const br = bullish / total
  const be = bearish / total
  if (br >= 0.6) return { bias: 'bullish', confidence: br }
  if (be >= 0.6) return { bias: 'bearish', confidence: be }
  return { bias: 'neutral', confidence: Math.max(br, be) }
}

// ─── Key zone compilation ─────────────────────────────────────────────────────

interface RawZone {
  top: number
  bottom: number
  kind: 'demand' | 'supply'
  origin: string
  sourceIdx: number  // candle index where source pattern was detected
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

  // Merge overlapping / near zones
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

  // Count touches + detect broken zones (start from zone creation index, not bar 0)
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

  // Build KeyZone with strength score
  const zones: KeyZone[] = merged
    .filter(z => !z.broken)
    .map(z => {
      const sourceScore = Math.min(z.origins.length / 3, 1)
      const recency = z.lastTouch >= 0 ? Math.min(z.lastTouch / upToIdx, 1) : 0.5
      const touchScore = z.touches >= 2 ? 0.8 : z.touches === 1 ? 0.5 : 0.3
      const fresh = z.touches <= 1 ? 0.2 : 0
      const strength = Math.min(sourceScore * 0.4 + recency * 0.25 + touchScore * 0.25 + fresh, 1)
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
): { demandZones: KeyZone[]; supplyZones: KeyZone[] } {
  if (upToIdx < 30) return { demandZones: [], supplyZones: [] }

  const curATR = atr(candles, upToIdx, 14)
  if (isNaN(curATR) || curATR === 0) return { demandZones: [], supplyZones: [] }

  const thick = curATR * 0.3
  const mergeGap = curATR * 0.5
  const MAX_ZONES = 8

  const raw: RawZone[] = []

  // Order blocks
  for (const ob of detectOrderBlocks(candles, upToIdx, { lookback: 50 })) {
    raw.push({ top: ob.top, bottom: ob.bottom, kind: ob.bullish ? 'demand' : 'supply', origin: 'order-block', sourceIdx: ob.index })
  }

  // Swing levels from classified swings (raw pivots → thin zones)
  for (const p of findPivots(candles, upToIdx, 3)) {
    if (p.kind === 'low') {
      raw.push({ top: p.price + thick, bottom: p.price, kind: 'demand', origin: 'swing', sourceIdx: p.index })
    } else {
      raw.push({ top: p.price, bottom: p.price - thick, kind: 'supply', origin: 'swing', sourceIdx: p.index })
    }
  }

  // Active FVGs
  for (const fvg of scanFVGs(candles, upToIdx)) {
    raw.push({ top: fvg.top, bottom: fvg.bottom, kind: fvg.bullish ? 'demand' : 'supply', origin: 'fvg', sourceIdx: fvg.index })
  }

  const demand = raw.filter(z => z.kind === 'demand')
  const supply = raw.filter(z => z.kind === 'supply')

  const demandZones = mergeAndRank(demand, 'demand', candles, upToIdx, mergeGap, MAX_ZONES)
  const supplyZones = mergeAndRank(supply, 'supply', candles, upToIdx, mergeGap, MAX_ZONES)

  // Sort by proximity to current price
  const price = candles[upToIdx]!.c
  const midOf = (z: KeyZone) => (z.top + z.bottom) / 2
  demandZones.sort((a, b) => Math.abs(price - midOf(a)) - Math.abs(price - midOf(b)))
  supplyZones.sort((a, b) => Math.abs(price - midOf(a)) - Math.abs(price - midOf(b)))

  return { demandZones, supplyZones }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full market structure analysis.
 * Returns neutral/empty structure if fewer than 50 candles.
 */
export function analyzeStructure(candles: Candle[]): MarketStructure {
  const upToIdx = candles.length - 1

  if (upToIdx < 49) {
    return { bias: 'neutral', biasConfidence: 0, swings: [], demandZones: [], supplyZones: [] }
  }

  const swings = classifySwings(candles, upToIdx)
  const { bias, confidence } = detectStructuralBias(swings)
  const { demandZones, supplyZones } = compileKeyZones(candles, upToIdx)

  return { bias, biasConfidence: confidence, swings, demandZones, supplyZones }
}
