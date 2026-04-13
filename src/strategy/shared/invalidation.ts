/**
 * Setup invalidation logic.
 * Pure functions — no side effects, no I/O.
 *
 * Invalidation rules per pattern type:
 *   order-block   — price closes beyond OB zone (zone broken)
 *   fvg           — price closes through FVG midpoint (gap filled)
 *   spring        — price closes below spring low (spring failed)
 *   demand-zone   — price closes below demand zone bottom (zone lost)
 *   breakout      — price reverses back into broken zone (failed breakout)
 *   vsa-signal    — price closes through the bar's opposite extreme (pattern failed)
 *   price-action  — price closes through the pattern bar's opposite extreme
 *   volume-profile — price closes through the profile level (level broken)
 *
 * TTL: max bar lifetime per type (PATTERN_TTL_BARS in config.ts)
 */

import type { Candle, ActiveSetup, InvalidationReason, CandleInterval } from '../../types.js'
import { PATTERN_TTL_BARS } from '../../config.js'

export interface InvalidationResult {
  invalidated: boolean
  reason?: InvalidationReason
}

/** Check if a setup is invalidated by current price action or TTL. */
export function isInvalidated(
  setup: ActiveSetup,
  candles: Candle[],
  currentBarIdx: number,
): InvalidationResult {
  // TTL expiry — check before candle bounds (setup may outlive the candle slice)
  if (currentBarIdx >= setup.expiresAtBar) {
    return { invalidated: true, reason: 'ttl-expired' }
  }

  // Skip invalidation on the bar where setup was created.
  // The entry bar's wick may have triggered the signal (e.g., spring/sweep),
  // so checking SL on that same bar causes false invalidation.
  // Trade needs at least 1 bar to "work out."
  if (setup.detectedAtBar !== undefined && currentBarIdx <= setup.detectedAtBar) {
    return { invalidated: false }
  }

  const c = candles[currentBarIdx]
  if (!c) return { invalidated: false }

  const pd = setup.patternData

  switch (setup.type) {
    case 'smc-sd': {
      // Zone-based invalidation: close beyond zone boundary + ATR buffer
      const smcZoneBottom = pd['zoneBottom'] as number
      const smcZoneTop = pd['zoneTop'] as number
      const smcAtr = (pd['atrAtEntry'] as number) ?? 0
      const invBuffer = smcAtr * 0.5  // ATR buffer before invalidating
      if (setup.side === 'long' && c.c < ((smcZoneBottom ?? setup.slPrice) - invBuffer)) {
        return { invalidated: true, reason: 'zone-broken' }
      }
      if (setup.side === 'short' && c.c > ((smcZoneTop ?? setup.slPrice) + invBuffer)) {
        return { invalidated: true, reason: 'zone-broken' }
      }
      break
    }
  }

  return { invalidated: false }
}

/** Compute expiresAtBar from detection bar + TTL. */
export function computeExpiresAtBar(type: ActiveSetup['type'], detectedAtBar: number): number {
  return detectedAtBar + (PATTERN_TTL_BARS[type] ?? 0)
}

/** Build a unique setup ID. At most one active setup per strategy/coin/tf/type. */
export function setupId(
  coin: string,
  interval: CandleInterval,
  type: ActiveSetup['type'],
  strategyId: string = 'smc-sd',
): string {
  return `${strategyId}:${coin}|${interval}|${type}`
}
