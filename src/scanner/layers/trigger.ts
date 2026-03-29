/**
 * Layer 5: Trigger — PA candlestick patterns at confirmed zone.
 *
 * For each confirmed zone, look for a candlestick pattern matching the bias direction.
 * No pattern = null (zone waits for trigger on next bar).
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult, Signal, ZoneConfirmation } from '../../types.js'
import type { CandlePattern, PAPatternName } from '../../indicators/price-action.js'
import { detectPriceAction } from '../../indicators/price-action.js'

/** Bullish PA patterns for long bias. */
const BULLISH_PATTERNS: Set<PAPatternName> = new Set([
  'bullish_engulfing',
  'pin_bar',
  'hammer',
  'tweezer_bottom',
  'dragonfly_doji',
])

/** Bearish PA patterns for short bias. */
const BEARISH_PATTERNS: Set<PAPatternName> = new Set([
  'bearish_engulfing',
  'pin_bar',
  'shooting_star',
  'tweezer_top',
  'gravestone_doji',
])

/**
 * Find a trigger pattern at a confirmed zone.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param confirmedZones  Zones from Layer 4 that passed isAtZone
 * @param bias     Layer 1 bias result
 * @returns Signal or null (null = zone waits for trigger)
 */
export function findTrigger(
  candles: Candle[],
  idx: number,
  confirmedZones: ZoneConfirmation[],
  bias: BiasResult,
): Signal | null {
  if (confirmedZones.length === 0) return null

  const patterns = detectPriceAction(candles, idx)
  if (patterns.length === 0) return null

  const validPatterns = filterByBias(patterns, bias.bias)
  if (validPatterns.length === 0) return null

  // Pick strongest pattern
  const best = validPatterns.reduce((a, b) => a.strength > b.strength ? a : b)

  // Pick best confirmed zone (throughZone > confirmed > first)
  const bestZone = pickBestZone(confirmedZones)

  const candle = candles[idx]!
  const zone = bestZone.zone
  const side = bias.bias as 'long' | 'short'

  // Compute entry/SL/TP
  const entry = candle.c
  let sl: number
  let tp: number

  if (side === 'long') {
    sl = Math.min(candle.l, zone.bottom)
    const risk = entry - sl
    tp = entry + risk * 2  // default 2R
  } else {
    sl = Math.max(candle.h, zone.top)
    const risk = sl - entry
    tp = entry - risk * 2  // default 2R
  }

  // Base confidence from trigger strength + zone boosts (including order flow)
  const triggerConf = best.strength
  const deltaBoost = bestZone.deltaBoost ?? 0
  const bookBoost = bestZone.bookBoost ?? 0
  const fundingBoost = bestZone.fundingBoost ?? 0
  const zoneConf = zone.strength + bestZone.vsaBoost + bestZone.vpBoost + deltaBoost + bookBoost + fundingBoost
  const throughBonus = bestZone.throughZone ? 0.10 : 0
  const confidence = Math.min((triggerConf + zoneConf + throughBonus) / 2, 1)

  return {
    type: mapPatternToSignalType(best.name),
    side,
    confidence,
    entryPrice: entry,
    slPrice: sl,
    tpPrice: tp,
    patternData: {
      pattern: best.name,
      patternStrength: best.strength,
      zoneOrigin: zone.origin,
      zoneTop: zone.top,
      zoneBottom: zone.bottom,
      vsaBoost: bestZone.vsaBoost,
      vpBoost: bestZone.vpBoost,
      deltaBoost,
      bookBoost,
      fundingBoost,
      throughZone: bestZone.throughZone,
    },
    zoneOrigin: zone.origin,
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

function filterByBias(patterns: CandlePattern[], bias: 'long' | 'short' | 'neutral'): CandlePattern[] {
  const allowed = bias === 'long' ? BULLISH_PATTERNS : BEARISH_PATTERNS
  return patterns.filter(p => {
    // pin_bar is directional — check direction field
    if (p.name === 'pin_bar') {
      return (bias === 'long' && p.direction === 'bullish') ||
             (bias === 'short' && p.direction === 'bearish')
    }
    return allowed.has(p.name)
  })
}

function pickBestZone(zones: ZoneConfirmation[]): ZoneConfirmation {
  // Priority: throughZone > confirmed > first
  const through = zones.find(z => z.throughZone)
  if (through) return through

  const confirmed = zones.find(z => z.confirmed)
  if (confirmed) return confirmed

  return zones[0]!
}

function mapPatternToSignalType(name: PAPatternName): Signal['type'] {
  // Price Action patterns → 'price-action' signal type
  // Could be more granular in future
  return 'price-action'
}
