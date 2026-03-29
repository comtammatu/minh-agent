/**
 * Layer 4: Volume Confirm — VSA signals + VP levels at zone.
 *
 * For each zone, check if price is "at zone" (wickTouch / nearZone / throughZone),
 * then compute VSA and VP boosts.
 *
 * Pure functions. Zero I/O.
 */

import type { Candle, KeyZone, ZoneConfirmation, VolumeProfile, DeltaState, OrderBookSnapshot, FundingSnapshot, SignalSide } from '../../types.js'
import type { VSASignal } from '../../indicators/vsa.js'
import { detectVSA } from '../../indicators/vsa.js'
import { buildVolumeProfile } from '../../indicators/volume-profile.js'
import { atr } from '../../indicators/core.js'
import { deltaConfirm, bookConfirm, fundingConfirm } from '../../indicators/order-flow.js'

/** Optional order flow data passed from Phase B feeds. */
export interface OrderFlowContext {
  delta?: DeltaState | null
  book?: OrderBookSnapshot | null
  funding?: FundingSnapshot | null
  signalSide?: SignalSide
}

/** ATR multiplier for zone proximity buffer. */
const ZONE_BUFFER_ATR_MULT = 0.3

/** VP lookback window for building volume profile. */
const VP_LOOKBACK = 100

// ── isAtZone ─────────────────────────────────────────────────────────────────

export interface ZoneProximity {
  atZone: boolean
  wickTouch: boolean
  nearZone: boolean
  throughZone: boolean  // Spring/Sweep — strongest signal
}

/**
 * Check if current candle is "at" a zone using three conditions.
 */
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
    nearZone = candle.c >= (zone.bottom - buffer) && candle.c <= (zone.top + buffer)
    throughZone = candle.l < zone.bottom && candle.c > zone.bottom  // Spring/Sweep
  } else {
    // Supply zone — price pushes into / touches from below
    wickTouch = candle.h >= zone.bottom && candle.h <= zone.top
    nearZone = candle.c <= (zone.top + buffer) && candle.c >= (zone.bottom - buffer)
    throughZone = candle.h > zone.top && candle.c < zone.top  // False breakout
  }

  const atZone = wickTouch || nearZone || throughZone
  return { atZone, wickTouch, nearZone, throughZone }
}

// ── confirmZones ─────────────────────────────────────────────────────────────

/**
 * For each zone, check proximity and compute VSA/VP boosts.
 * Only returns zones where price is at the zone.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param zones    Zones from Layer 3 (already bias-filtered)
 * @returns ZoneConfirmation[] — only zones where isAtZone = true
 */
export function confirmZones(
  candles: Candle[],
  idx: number,
  zones: KeyZone[],
  orderFlow?: OrderFlowContext,
): ZoneConfirmation[] {
  if (idx < 20) return []

  const atrVal = atr(candles, idx, 14)
  if (isNaN(atrVal) || atrVal === 0) return []

  const candle = candles[idx]!
  const results: ZoneConfirmation[] = []

  // Pre-compute shared indicators
  const vsaSignals = detectVSA(candles, idx)
  const vpStart = Math.max(0, idx - VP_LOOKBACK)
  const vp = buildVolumeProfile(candles, vpStart, idx)

  for (const zone of zones) {
    const proximity = isAtZone(candle, zone, atrVal)
    if (!proximity.atZone) continue

    const vsaBoost = computeVSABoost(vsaSignals, zone)
    const vpBoost = computeVPBoost(vp, zone)
    const deltaBoost = orderFlow?.delta ? deltaConfirm(orderFlow.delta, zone) : 0
    const bookBoost = orderFlow?.book ? bookConfirm(orderFlow.book.imbalance, zone) : 0
    const fundingBoost = (orderFlow?.funding && orderFlow?.signalSide)
      ? fundingConfirm(orderFlow.funding.rate, orderFlow.signalSide)
      : 0

    results.push({
      zone,
      vsaBoost,
      vpBoost,
      deltaBoost,
      bookBoost,
      fundingBoost,
      throughZone: proximity.throughZone,
      confirmed: vsaBoost > 0 || vpBoost > 0 || deltaBoost > 0 || bookBoost > 0 || proximity.throughZone,
    })
  }

  return results
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Compute VSA boost for a zone. Bullish VSA at demand = boost, bearish VSA at supply = boost.
 * Range: 0 to 0.20
 */
function computeVSABoost(signals: VSASignal[], zone: KeyZone): number {
  let boost = 0
  const wantDirection = zone.type === 'demand' ? 'bullish' : 'bearish'

  for (const sig of signals) {
    if (sig.direction !== wantDirection) continue

    // Stopping volume / climax = strongest boost
    if (sig.type === 'stopping-volume' || sig.type === 'climax-buy' || sig.type === 'climax-sell') {
      boost = Math.max(boost, 0.20)
    }
    // Test / no-supply / no-demand = moderate boost
    else if (sig.type === 'test' || sig.type === 'no-supply' || sig.type === 'no-demand') {
      boost = Math.max(boost, 0.15)
    }
    // Other VSA signals = minor boost
    else {
      boost = Math.max(boost, 0.10)
    }
  }

  return boost
}

/**
 * Compute VP boost for a zone. Zone overlapping HVN/POC/VAL/VAH = boost.
 * Range: -0.10 to 0.15
 */
function computeVPBoost(vp: VolumeProfile | null, zone: KeyZone): number {
  if (!vp) return 0

  const mid = (zone.top + zone.bottom) / 2

  // POC overlap = strongest boost
  if (mid >= zone.bottom && mid <= zone.top && vp.poc >= zone.bottom && vp.poc <= zone.top) {
    return 0.15
  }

  // HVN overlap = moderate boost
  for (const hvn of vp.hvn) {
    if (hvn >= zone.bottom && hvn <= zone.top) return 0.10
  }

  // VAL/VAH boundary overlap
  if (vp.val >= zone.bottom && vp.val <= zone.top) return 0.10
  if (vp.vah >= zone.bottom && vp.vah <= zone.top) return 0.10

  // LVN overlap = penalty (thin volume = less likely to hold)
  for (const lvn of vp.lvn) {
    if (lvn >= zone.bottom && lvn <= zone.top) return -0.10
  }

  return 0
}
