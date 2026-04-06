/**
 * Layer 3: Zones — SMC OB/FVG + S&D key zones filtered by bias direction.
 *
 * Returns demand zones for long bias, supply zones for short bias.
 * Applies freshness filter — zones older than ZONE_MAX_AGE candles are dropped.
 * Empty = STOP pipeline (no actionable zone).
 * Sorted by proximity to current price.
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult, KeyZone } from '../../types.js'
import { compileKeyZones } from '../../indicators/smc.js'
import { ZONE_MAX_AGE } from '../../config.js'

export interface EntryZonesResult {
  zones: KeyZone[]
  /** Total zones before freshness filter (for diagnostics). */
  totalBeforeFilter: number
}

/**
 * Find entry zones filtered by bias direction + freshness.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param bias     Layer 1 bias result
 * @returns EntryZonesResult with filtered zones + pre-filter count
 */
export function findEntryZones(
  candles: Candle[],
  idx: number,
  bias: BiasResult,
): EntryZonesResult {
  const { demandZones, supplyZones } = compileKeyZones(candles, idx)

  let raw: KeyZone[]
  if (bias.bias === 'long') raw = demandZones
  else if (bias.bias === 'short') raw = supplyZones
  else return { zones: [], totalBeforeFilter: 0 }

  // Freshness filter — drop zones older than ZONE_MAX_AGE candles
  const zones = raw.filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE)
  return { zones, totalBeforeFilter: raw.length }
}
