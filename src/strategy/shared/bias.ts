/**
 * Bias determination — Wyckoff phase + SMC BOS/CHoCH + HTF cross-reference.
 *
 * Extracted from the former layered/layers/bias.ts.
 * Pure function. Zero I/O.
 */

import type { Candle, PivotPoint } from '../../types.js'
import type { WyckoffResult } from '../../indicators/wyckoff.js'
import { detectWyckoff } from '../../indicators/wyckoff.js'
import { detectStructureBreaks } from '../../indicators/smc.js'
import { atr } from '../../indicators/core.js'

export interface BiasResult {
  bias: 'long' | 'short' | 'neutral'
  confidence: number
  source: string
  htfBias?: 'long' | 'short' | 'neutral'
}

/** HTF confidence boost when HTF bias aligns with LTF bias. */
const HTF_ALIGN_BOOST = 0.15

export function determineBias(
  candles: Candle[],
  idx: number,
  htfCandles: Candle[],
  pivots: PivotPoint[],
): BiasResult | null {
  if (idx < 50) return null

  const wyckoff = detectWyckoff(candles, idx)
  const breaks = detectStructureBreaks(candles, idx)

  const latestCHoCH = breaks.findLast(b => b.kind === 'choch')
  const latestBOS = breaks.findLast(b => b.kind === 'bos')

  let bias: 'long' | 'short' | 'neutral' = 'neutral'
  let confidence = 0
  let source = 'none'

  if (wyckoff.phase === 'accumulation') {
    if (latestCHoCH && latestCHoCH.direction === 'bullish') {
      bias = 'long'
      confidence = wyckoff.confidence
      source = 'wyckoff+smc'
    } else if (latestBOS && latestBOS.direction === 'bearish' && !latestCHoCH) {
      bias = 'neutral'
      confidence = 0
      source = 'wyckoff+smc-conflict'
    } else {
      bias = 'long'
      confidence = wyckoff.confidence * 0.7
      source = 'wyckoff-only'
    }
  } else if (wyckoff.phase === 'distribution') {
    if (latestCHoCH && latestCHoCH.direction === 'bearish') {
      bias = 'short'
      confidence = wyckoff.confidence
      source = 'wyckoff+smc'
    } else if (latestBOS && latestBOS.direction === 'bullish' && !latestCHoCH) {
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
    if (latestCHoCH) {
      bias = latestCHoCH.direction === 'bullish' ? 'long' : 'short'
      confidence = 0.5
      source = 'smc-only'
    }
  }

  // Spring invalidation
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

  // HTF cross-reference
  const htfBias = computeHTFBias(htfCandles, wyckoff)

  if (htfBias && htfBias !== 'neutral') {
    if (htfBias !== bias) {
      return { bias: 'neutral', confidence: 0, source: 'htf-oppose', htfBias }
    }
    confidence = Math.min(confidence + HTF_ALIGN_BOOST, 1)
  }

  return { bias, confidence, source, htfBias: htfBias ?? undefined }
}

function computeHTFBias(
  htfCandles: Candle[],
  _currentWyckoff: WyckoffResult,
): 'long' | 'short' | 'neutral' | null {
  if (htfCandles.length < 50) return null

  const htfIdx = htfCandles.length - 1
  const htfWyckoff = detectWyckoff(htfCandles, htfIdx)
  const htfBreaks = detectStructureBreaks(htfCandles, htfIdx)
  const htfCHoCH = htfBreaks.findLast(b => b.kind === 'choch')

  if (htfWyckoff.phase === 'accumulation' || htfWyckoff.phase === 'markup') return 'long'
  if (htfWyckoff.phase === 'distribution' || htfWyckoff.phase === 'markdown') return 'short'

  if (htfCHoCH) return htfCHoCH.direction === 'bullish' ? 'long' : 'short'

  return 'neutral'
}

const SPRING_LOW_LOOKBACK = 50

function findSpringLow(
  candles: Candle[],
  idx: number,
  pivots: PivotPoint[],
): number | null {
  const minIdx = idx - SPRING_LOW_LOOKBACK
  const lows = pivots.filter(p => p.kind === 'low' && p.index <= idx && p.index >= minIdx)
  if (lows.length === 0) return null
  let minPrice = Infinity
  for (const p of lows) {
    if (p.price < minPrice) minPrice = p.price
  }
  return minPrice
}
