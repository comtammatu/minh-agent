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

import type { Candle, ActiveSetup, InvalidationReason, CandleInterval } from '../types.js'
import { PATTERN_TTL_BARS } from '../config.js'

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
    case 'order-block': {
      const obTop = pd['obTop'] as number
      const obBottom = pd['obBottom'] as number
      // Long OB: close below zone bottom → zone broken
      if (setup.side === 'long' && c.c < obBottom) {
        return { invalidated: true, reason: 'zone-broken' }
      }
      // Short OB: close above zone top → zone broken
      if (setup.side === 'short' && c.c > obTop) {
        return { invalidated: true, reason: 'zone-broken' }
      }
      break
    }

    case 'fvg': {
      const fvgTop = pd['fvgTop'] as number
      const fvgBottom = pd['fvgBottom'] as number
      // Long FVG: close below fvg bottom → fully filled
      if (setup.side === 'long' && c.c < fvgBottom) {
        return { invalidated: true, reason: 'fvg-filled' }
      }
      // Short FVG: close above fvg top → fully filled
      if (setup.side === 'short' && c.c > fvgTop) {
        return { invalidated: true, reason: 'fvg-filled' }
      }
      break
    }

    case 'spring': {
      const event = pd['event'] as string
      if (event === 'spring') {
        // Spring failed: close below the spring entry price's SL
        if (setup.side === 'long' && c.c < setup.slPrice) {
          return { invalidated: true, reason: 'spring-failed' }
        }
      } else if (event === 'utad') {
        if (setup.side === 'short' && c.c > setup.slPrice) {
          return { invalidated: true, reason: 'spring-failed' }
        }
      }
      break
    }

    case 'demand-zone': {
      const zoneBottom = pd['zoneBottom'] as number
      const zoneTop = pd['zoneTop'] as number
      // Long demand: close below zone bottom → demand lost
      if (setup.side === 'long' && c.c < zoneBottom) {
        return { invalidated: true, reason: 'demand-lost' }
      }
      // Short supply: close above zone top → supply lost
      if (setup.side === 'short' && c.c > zoneTop) {
        return { invalidated: true, reason: 'demand-lost' }
      }
      break
    }

    case 'breakout': {
      const zoneTop = pd['zoneTop'] as number
      const zoneBottom = pd['zoneBottom'] as number
      // Bullish breakout: price retreats back below zone top → failed
      if (setup.side === 'long' && c.c < zoneTop) {
        return { invalidated: true, reason: 'breakout-failed' }
      }
      // Bearish breakdown: price rallies back above zone bottom → failed
      if (setup.side === 'short' && c.c > zoneBottom) {
        return { invalidated: true, reason: 'breakout-failed' }
      }
      break
    }

    case 'vsa-signal': {
      // SL hit → pattern failed
      if (setup.side === 'long' && c.c < setup.slPrice) {
        return { invalidated: true, reason: 'pattern-failed' }
      }
      if (setup.side === 'short' && c.c > setup.slPrice) {
        return { invalidated: true, reason: 'pattern-failed' }
      }
      break
    }

    case 'price-action': {
      // SL hit → pattern failed
      if (setup.side === 'long' && c.c < setup.slPrice) {
        return { invalidated: true, reason: 'pattern-failed' }
      }
      if (setup.side === 'short' && c.c > setup.slPrice) {
        return { invalidated: true, reason: 'pattern-failed' }
      }
      break
    }

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

    case 'volume-profile': {
      const level = pd['level'] as string
      const poc = pd['poc'] as number
      const vah = pd['vah'] as number
      const val = pd['val'] as number

      const refLevel = level === 'poc' ? poc : level === 'vah' ? vah : val
      const tolerance = refLevel * 0.004  // 0.4% tolerance

      // Long VP: close decisively below the level → broken
      if (setup.side === 'long' && c.c < refLevel - tolerance) {
        return { invalidated: true, reason: 'va-broken' }
      }
      // Short VP: close decisively above the level → broken
      if (setup.side === 'short' && c.c > refLevel + tolerance) {
        return { invalidated: true, reason: 'va-broken' }
      }
      break
    }
  }

  return { invalidated: false }
}

/** Compute expiresAtBar from detection bar + TTL. */
export function computeExpiresAtBar(type: ActiveSetup['type'], detectedAtBar: number): number {
  return detectedAtBar + PATTERN_TTL_BARS[type]
}

/** Build a unique setup ID. At most one active setup per strategy/coin/tf/type. */
export function setupId(
  coin: string,
  interval: CandleInterval,
  type: ActiveSetup['type'],
  strategyId: string = 'layered',
): string {
  return `${strategyId}:${coin}|${interval}|${type}`
}
