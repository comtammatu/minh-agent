/**
 * Zone utility functions — shared by SMC-SD strategy.
 *
 * Extracted from the former layered/layers/confirm.ts and layered/layers/trigger.ts.
 */

import type { Candle, KeyZone } from '../../types.js'
import { ZONE_BUFFER_ATR_MULT, MIN_TP1_RR } from '../../config.js'
import { compileKeyZones, findPivots } from '../../indicators/smc.js'
import { atr } from '../../indicators/core.js'

// ── isAtZone ─────────────────────────────────────────────────────────────────

export interface ZoneProximity {
  atZone: boolean
  wickTouch: boolean
  nearZone: boolean
  throughZone: boolean  // Spring/Sweep — strongest signal
}

export function isAtZone(
  candle: Candle,
  zone: KeyZone,
  atrValue: number,
): ZoneProximity {
  const buffer = atrValue * ZONE_BUFFER_ATR_MULT
  let wickTouch = false
  let nearZone = false
  let throughZone = false

  if (zone.type === 'demand') {
    // Demand zone — price dips into / touches from above
    wickTouch = candle.l <= zone.top && candle.l >= zone.bottom
    // nearZone tightened: require wick to at least touch zone top (not just close near)
    nearZone = candle.l <= (zone.top + buffer) && candle.c > zone.top
    throughZone = candle.l < zone.bottom && candle.c > zone.bottom  // Spring/Sweep
  } else {
    // Supply zone — price pushes into / touches from below
    wickTouch = candle.h >= zone.bottom && candle.h <= zone.top
    // nearZone tightened: require wick to at least touch zone bottom (not just close near)
    nearZone = candle.h >= (zone.bottom - buffer) && candle.c < zone.bottom
    throughZone = candle.h > zone.top && candle.c < zone.top  // False breakout
  }

  // Require actual wick interaction — nearZone alone now demands wick proximity
  const atZone = wickTouch || nearZone || throughZone
  return { atZone, wickTouch, nearZone, throughZone }
}

// ── computeStructureTargets ──────────────────────────────────────────────────

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
  const minTp1 = entry + dir * risk * MIN_TP1_RR

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
    tp1 = entry + dir * risk * 3
  }
  // Ensure TP1 >= MIN_TP1_RR
  if (side === 'long' && tp1 < minTp1) tp1 = minTp1
  if (side === 'short' && tp1 > minTp1) tp1 = minTp1

  // Minimum TP distance: max of 2 ATR or MIN_TP1_RR × risk
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
    const candidates = pivots
      .filter(p => p.kind === 'high' && p.price > tp1!)
      .sort((a, b) => a.price - b.price)
    tp2 = candidates[0]?.price ?? null
  } else {
    const candidates = pivots
      .filter(p => p.kind === 'low' && p.price < tp1!)
      .sort((a, b) => b.price - a.price)
    tp2 = candidates[0]?.price ?? null
  }

  // Fallback + ensure TP2 > TP1
  if (tp2 === null) {
    tp2 = entry + dir * risk * 5
  }
  if (side === 'long' && tp2 <= tp1) tp2 = tp1 + risk
  if (side === 'short' && tp2 >= tp1) tp2 = tp1 - risk

  return { tp1, tp2 }
}
