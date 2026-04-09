/**
 * Layer 5: Trigger — PA candlestick patterns at confirmed zone.
 *
 * For each confirmed zone, look for a candlestick pattern matching the bias direction.
 * No pattern = null (zone waits for trigger on next bar).
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult, Signal, ZoneConfirmation, KeyZone } from '../../../../types.js'
import type { CandlePattern, PAPatternName } from '../../../../indicators/price-action.js'
import { detectPriceAction } from '../../../../indicators/price-action.js'
import { compileKeyZones, findPivots } from '../../../../indicators/smc.js'
import { atr } from '../../../../indicators/core.js'
import { MIN_TP1_RR, SL_WICK_ATR_MULT } from '../../../../config.js'

/** Bullish PA patterns for long bias. */
const BULLISH_PATTERNS: Set<PAPatternName> = new Set([
  'bullish_engulfing',
  'pin_bar',
  'hammer',
  'tweezer_bottom',
  'dragonfly_doji',
  'inside_bar',    // breakout potential — direction checked via CandlePattern.direction
  'outside_bar',   // momentum confirmation — direction checked via CandlePattern.direction
])

/** Bearish PA patterns for short bias. */
const BEARISH_PATTERNS: Set<PAPatternName> = new Set([
  'bearish_engulfing',
  'pin_bar',
  'shooting_star',
  'tweezer_top',
  'gravestone_doji',
  'inside_bar',    // breakout potential — direction checked via CandlePattern.direction
  'outside_bar',   // momentum confirmation — direction checked via CandlePattern.direction
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

  // Compute entry/SL — wick-based for tighter R:R geometry
  // SL placed just beyond candle extreme + ATR buffer, not at zone boundary.
  // Zone boundary remains the hard invalidation level (handled by invalidation layer).
  const entry = candle.c
  const atrVal = atr(candles, idx, 14)
  const slBuffer = !isNaN(atrVal) ? atrVal * SL_WICK_ATR_MULT : 0
  let sl: number

  if (side === 'long') {
    sl = candle.l - slBuffer
  } else {
    sl = candle.h + slBuffer
  }

  // Structure-based TP targets
  const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)
  const tp = tp1  // Primary TP for signal (TP1 = nearest zone)

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
      tp2Price: tp2,  // swing-based TP2 for simulator multi-exit
    },
    zoneOrigin: zone.origin,
  }
}

// ── Structure-based TP ──────────────────────────────────────────────────────

/**
 * Compute TP1 (nearest opposing zone) and TP2 (swing target) from market structure.
 * Pure function — no I/O. Calls compileKeyZones + findPivots internally.
 *
 * TP1: Nearest opposing zone edge. Fallback: 2R. Floor: MIN_TP1_RR.
 * TP2: Nearest pivot beyond TP1. Fallback: 3R. Must be > TP1.
 */
export function computeStructureTargets(
  candles: Candle[],
  idx: number,
  entry: number,
  sl: number,
  side: 'long' | 'short',
): { tp1: number; tp2: number } {
  const risk = Math.abs(entry - sl)
  if (risk === 0) return { tp1: entry, tp2: entry }

  const dir = side === 'long' ? 1 : -1
  const minTp1 = entry + dir * risk * MIN_TP1_RR  // floor: 1.5R

  // ── TP1: Nearest opposing zone ──────────────────────────────────────────
  const { demandZones, supplyZones } = compileKeyZones(candles, idx)
  const opposingZones = side === 'long' ? supplyZones : demandZones

  let tp1: number | null = null
  for (const z of opposingZones) {
    const edge = side === 'long' ? z.bottom : z.top
    const valid = side === 'long' ? edge > entry : edge < entry
    if (valid) {
      tp1 = edge
      break  // zones sorted by proximity — first valid is nearest
    }
  }

  // Apply floor + fallback — raised from 2R to 3R to improve avg win
  if (tp1 === null) {
    tp1 = entry + dir * risk * 3  // fallback 3R
  }
  // Ensure TP1 >= MIN_TP1_RR
  if (side === 'long' && tp1 < minTp1) tp1 = minTp1
  if (side === 'short' && tp1 > minTp1) tp1 = minTp1

  // Minimum TP distance: max of 2 ATR or MIN_TP1_RR × risk
  // Ensures TP always achieves the minimum R:R regardless of zone placement
  const curAtr = atr(candles, idx, 14)
  if (!isNaN(curAtr) && curAtr > 0) {
    const minTpDist = Math.max(curAtr * 2, risk * MIN_TP1_RR)
    const minTpPrice = entry + dir * minTpDist
    if (side === 'long' && tp1 < minTpPrice) tp1 = minTpPrice
    if (side === 'short' && tp1 > minTpPrice) tp1 = minTpPrice
  }

  // ── TP2: Swing structure target ─────────────────────────────────────────
  const pivots = findPivots(candles, idx, 5)

  let tp2: number | null = null
  if (side === 'long') {
    // Nearest swing high beyond TP1
    const candidates = pivots
      .filter(p => p.kind === 'high' && p.price > tp1!)
      .sort((a, b) => a.price - b.price)
    tp2 = candidates[0]?.price ?? null
  } else {
    // Nearest swing low beyond TP1
    const candidates = pivots
      .filter(p => p.kind === 'low' && p.price < tp1!)
      .sort((a, b) => b.price - a.price)
    tp2 = candidates[0]?.price ?? null
  }

  // Fallback + ensure TP2 > TP1 — raised from 3R to 5R
  if (tp2 === null) {
    tp2 = entry + dir * risk * 5  // fallback 5R
  }
  if (side === 'long' && tp2 <= tp1) tp2 = tp1 + risk
  if (side === 'short' && tp2 >= tp1) tp2 = tp1 - risk

  return { tp1, tp2 }
}

// ── Private helpers ──────────────────────────────────────────────────────────

function filterByBias(patterns: CandlePattern[], bias: 'long' | 'short' | 'neutral'): CandlePattern[] {
  const allowed = bias === 'long' ? BULLISH_PATTERNS : BEARISH_PATTERNS
  const wantDir = bias === 'long' ? 'bullish' : 'bearish'
  return patterns.filter(p => {
    if (!allowed.has(p.name)) return false
    // Directional patterns — must match bias direction
    if (p.name === 'pin_bar' || p.name === 'inside_bar' || p.name === 'outside_bar') {
      return p.direction === wantDir
    }
    return true
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
