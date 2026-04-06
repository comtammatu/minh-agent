/**
 * Layer 2: Structure — PA swing classification + structural bias.
 *
 * Confirms or denies the bias from Layer 1 using swing structure (HH/HL/LH/LL).
 * 3-state return: 'confirm' | 'neutral' | 'deny'. Deny = STOP pipeline.
 *
 * Pure function. Zero I/O.
 */

import type { Candle, BiasResult, StructureVerdict, SwingPoint } from '../../../../types.js'
import { classifySwings, detectStructuralBias } from '../../../../indicators/price-action.js'

/**
 * Confirm or deny the Layer 1 bias using swing structure.
 *
 * @param candles  Current TF candles
 * @param idx      Index of confirmed candle
 * @param bias     Layer 1 bias result
 * @param swings   Pre-computed swings (optional, computed if not provided)
 * @returns StructureVerdict: 'confirm' | 'neutral' | 'deny'
 */
export function confirmStructure(
  candles: Candle[],
  idx: number,
  bias: BiasResult,
  swings?: SwingPoint[],
): StructureVerdict {
  const sw = swings ?? classifySwings(candles, idx)

  // Need at least 4 swings to determine structure
  if (sw.length < 4) return 'neutral'

  const { bias: structBias } = detectStructuralBias(sw)

  if (bias.bias === 'long') {
    if (structBias === 'bullish') return 'confirm'
    if (structBias === 'neutral') return 'neutral'
    return 'deny'  // bearish structure vs long bias
  }

  if (bias.bias === 'short') {
    if (structBias === 'bearish') return 'confirm'
    if (structBias === 'neutral') return 'neutral'
    return 'deny'  // bullish structure vs short bias
  }

  // bias.bias === 'neutral' should not reach here (pipeline stops at Layer 1)
  return 'neutral'
}
