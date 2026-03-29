/**
 * Layer 3: Zones — SMC OB/FVG + S&D key zones filtered by bias direction.
 *
 * Returns demand zones for long bias, supply zones for short bias.
 * Empty = STOP pipeline (no actionable zone).
 * Sorted by proximity to current price.
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult, KeyZone } from '../../types.js'
import { compileKeyZones } from '../../indicators/structure.js'

/**
 * Find entry zones filtered by bias direction.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param bias     Layer 1 bias result
 * @returns KeyZone[] — empty means STOP
 */
export function findEntryZones(
  candles: Candle[],
  idx: number,
  bias: BiasResult,
): KeyZone[] {
  const { demandZones, supplyZones } = compileKeyZones(candles, idx)

  if (bias.bias === 'long') return demandZones
  if (bias.bias === 'short') return supplyZones

  // neutral should not reach here
  return []
}
