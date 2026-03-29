/**
 * Layer 1: Bias — Wyckoff phase + SMC BOS/CHoCH + HTF cross-reference.
 *
 * Determines directional bias (long/short/neutral). Neutral = STOP pipeline.
 *
 * Conflict resolution (Section 11 rules):
 *   Accumulation + bearish BOS, no CHoCH yet → neutral (wait for SOS)
 *   Accumulation + bullish CHoCH → long (Spring confirmed)
 *   Distribution + bullish BOS, no CHoCH yet → neutral
 *   Distribution + bearish CHoCH → short (UTAD confirmed)
 *   Invalidation: close < Spring low - ATR×1.5 → flip short (Re-distribution)
 *
 * HTF check: opposing HTF → neutral. Aligned → +0.15 boost.
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult } from '../../types.js'
import type { PivotPoint, StructureBreak } from '../../indicators/smc.js'
import type { WyckoffResult } from '../../indicators/wyckoff.js'
import { detectWyckoff } from '../../indicators/wyckoff.js'
import { detectStructureBreaks } from '../../indicators/smc.js'
import { atr } from '../../indicators/core.js'

/** HTF confidence boost when HTF bias aligns with LTF bias. */
const HTF_ALIGN_BOOST = 0.15

/**
 * Determine directional bias from Wyckoff + SMC + HTF.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param htfCandles  Higher timeframe candles (may be empty during startup)
 * @param pivots   Pre-computed pivots (shared context)
 * @returns BiasResult or null if insufficient data
 */
export function determineBias(
  candles: Candle[],
  idx: number,
  htfCandles: Candle[],
  pivots: PivotPoint[],
): BiasResult | null {
  if (idx < 50) return null

  const wyckoff = detectWyckoff(candles, idx)
  const breaks = detectStructureBreaks(candles, idx)

  const latestCHoCH = findLast(breaks, b => b.kind === 'choch')
  const latestBOS = findLast(breaks, b => b.kind === 'bos')

  // ── Wyckoff + SMC conflict resolution ──────────────────────────────────────

  let bias: 'long' | 'short' | 'neutral' = 'neutral'
  let confidence = 0
  let source = 'none'

  if (wyckoff.phase === 'accumulation') {
    if (latestCHoCH && latestCHoCH.direction === 'bullish') {
      // Accumulation + bullish CHoCH → long (Spring confirmed / SOS)
      bias = 'long'
      confidence = wyckoff.confidence
      source = 'wyckoff+smc'
    } else if (latestBOS && latestBOS.direction === 'bearish' && !latestCHoCH) {
      // Accumulation + bearish BOS, no CHoCH → neutral (wait for SOS)
      bias = 'neutral'
      confidence = 0
      source = 'wyckoff+smc-conflict'
    } else {
      // Accumulation, no clear BOS/CHoCH → lean long with lower confidence
      bias = 'long'
      confidence = wyckoff.confidence * 0.7
      source = 'wyckoff-only'
    }
  } else if (wyckoff.phase === 'distribution') {
    if (latestCHoCH && latestCHoCH.direction === 'bearish') {
      // Distribution + bearish CHoCH → short (UTAD confirmed)
      bias = 'short'
      confidence = wyckoff.confidence
      source = 'wyckoff+smc'
    } else if (latestBOS && latestBOS.direction === 'bullish' && !latestCHoCH) {
      // Distribution + bullish BOS, no CHoCH → neutral
      bias = 'neutral'
      confidence = 0
      source = 'wyckoff+smc-conflict'
    } else {
      bias = 'short'
      confidence = wyckoff.confidence * 0.7
      source = 'wyckoff-only'
    }
  } else if (wyckoff.phase === 'markup') {
    bias = 'long'
    confidence = wyckoff.confidence
    source = latestBOS?.direction === 'bullish' ? 'wyckoff+smc' : 'wyckoff-only'
  } else if (wyckoff.phase === 'markdown') {
    bias = 'short'
    confidence = wyckoff.confidence
    source = latestBOS?.direction === 'bearish' ? 'wyckoff+smc' : 'wyckoff-only'
  } else {
    // Wyckoff returned null phase — fallback to SMC only
    if (latestCHoCH) {
      bias = latestCHoCH.direction === 'bullish' ? 'long' : 'short'
      confidence = 0.5
      source = 'smc-only'
    } else if (latestBOS) {
      bias = latestBOS.direction === 'bullish' ? 'long' : 'short'
      confidence = 0.4
      source = 'smc-only'
    }
    // else stays neutral
  }

  // ── Spring invalidation ────────────────────────────────────────────────────
  // If bias=long from accumulation, but price closed below Spring low - ATR×1.5
  // → Re-distribution, flip short
  if (bias === 'long' && wyckoff.phase === 'accumulation' && wyckoff.event === 'spring') {
    const atrVal = atr(candles, idx, 14)
    const springLow = findSpringLow(candles, idx, pivots)
    if (springLow !== null && !isNaN(atrVal) && candles[idx]!.c < springLow - atrVal * 1.5) {
      bias = 'short'
      confidence = 0.6
      source = 'spring-invalidation'
    }
  }

  if (bias === 'neutral') return { bias: 'neutral', confidence: 0, source }

  // ── HTF cross-reference ────────────────────────────────────────────────────
  const htfBias = computeHTFBias(htfCandles, wyckoff)

  if (htfBias && htfBias !== 'neutral') {
    if (htfBias !== bias) {
      // HTF opposes → neutral (STOP)
      return { bias: 'neutral', confidence: 0, source: 'htf-oppose', htfBias }
    }
    // HTF aligns → boost
    confidence = Math.min(confidence + HTF_ALIGN_BOOST, 1)
  }
  // HTF empty (startup) → no boost, no block — proceed with current TF only

  return { bias, confidence, source, htfBias: htfBias ?? undefined }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeHTFBias(
  htfCandles: Candle[],
  currentWyckoff: WyckoffResult,
): 'long' | 'short' | 'neutral' | null {
  if (htfCandles.length < 50) return null // not enough data

  const htfIdx = htfCandles.length - 1
  const htfWyckoff = detectWyckoff(htfCandles, htfIdx)
  const htfBreaks = detectStructureBreaks(htfCandles, htfIdx)
  const htfCHoCH = findLast(htfBreaks, b => b.kind === 'choch')

  if (htfWyckoff.phase === 'accumulation' || htfWyckoff.phase === 'markup') return 'long'
  if (htfWyckoff.phase === 'distribution' || htfWyckoff.phase === 'markdown') return 'short'

  // Fallback to HTF CHoCH
  if (htfCHoCH) return htfCHoCH.direction === 'bullish' ? 'long' : 'short'

  return 'neutral'
}

function findSpringLow(
  candles: Candle[],
  idx: number,
  pivots: PivotPoint[],
): number | null {
  // Find the lowest pivot low in recent history as spring reference
  const lows = pivots.filter(p => p.kind === 'low' && p.index <= idx)
  if (lows.length === 0) return null
  let minPrice = Infinity
  for (const p of lows) {
    if (p.price < minPrice) minPrice = p.price
  }
  return minPrice
}

/** Array.findLast polyfill (pure). */
function findLast<T>(arr: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return arr[i]!
  }
  return undefined
}
