/**
 * Regime context — soft filter that modulates confidence.
 *
 * Does NOT block counter-trend signals. Reduces confidence:
 *   aligned (Long+BULL, Short+BEAR): × 1.0
 *   neutral (SIDEWAYS, VOLATILE):    × 0.8
 *   counter (Long+BEAR, Short+BULL): × 0.3
 *
 * Pure function. Zero I/O.
 */

import type { MarketRegime, SignalSide } from '../../types.js'
import type { StrategyParams } from '../../backtest/types.js'
import { REGIME_MULTIPLIERS } from '../../config.js'

/**
 * Apply regime modifier to confidence.
 * NaN input → 0. Result clamped to [0, 1].
 * Optional strategyParams override regime multipliers for optimizer trials.
 */
export function applyRegimeModifier(
  confidence: number,
  side: SignalSide,
  regime: MarketRegime,
  strategyParams?: StrategyParams,
): number {
  const raw = isNaN(confidence) ? 0 : confidence

  const isAligned =
    (side === 'long' && regime === 'BULL') ||
    (side === 'short' && regime === 'BEAR')

  const isCounter =
    (side === 'long' && regime === 'BEAR') ||
    (side === 'short' && regime === 'BULL')

  let multiplier: number
  if (isAligned) {
    multiplier = REGIME_MULTIPLIERS.aligned
  } else if (isCounter) {
    multiplier = strategyParams?.REGIME_MULT_COUNTER ?? REGIME_MULTIPLIERS.counter
  } else {
    multiplier = strategyParams?.REGIME_MULT_NEUTRAL ?? REGIME_MULTIPLIERS.neutral
  }

  return Math.min(Math.max(raw * multiplier, 0), 1)
}
