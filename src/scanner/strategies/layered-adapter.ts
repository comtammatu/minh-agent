/**
 * LayeredAdapter — wraps the existing 5-layer Wyckoff/SMC pipeline as IStrategy.
 *
 * Design:
 *   - Delegates to runPipeline() which handles emit internally (legacy pattern).
 *   - scan() returns null — signals are emitted via getPipelineEmitter() inside runPipeline.
 *   - S2 will refactor runPipeline to return Signal instead of void + emit.
 *
 * This adapter exists so that the StrategyRegistry can fan-out to the layered
 * pipeline using the same IStrategy interface as future strategies.
 */

import type { Candle, CandleInterval, Signal, PatternType } from '../../types.js'
import type { IStrategy } from '../strategy.js'
import { runLayeredPipeline, clearLayeredState } from '../pipeline.js'
import { MIN_CANDLES_FOR_SCAN } from '../../config.js'

export class LayeredStrategyAdapter implements IStrategy {
  readonly id = 'layered'
  readonly name = '5-Layer Wyckoff/SMC Pipeline'
  readonly patternTypes: ReadonlyArray<PatternType> = [
    'order-block', 'fvg', 'spring', 'demand-zone',
    'breakout', 'vsa-signal', 'price-action', 'volume-profile',
  ]

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number): Signal | null {
    // Legacy pattern: runLayeredPipeline emits via getPipelineEmitter() internally.
    // Returns null here — registry skips this in results array.
    runLayeredPipeline(coin, interval, candles, idx)
    return null
  }

  minCandles(): number {
    // Layered pipeline works with MIN_CANDLES_FOR_SCAN (50+) candles.
    // INDICATOR_WINDOW (200) is the ideal window, but not a hard minimum.
    return MIN_CANDLES_FOR_SCAN
  }

  clearState(): void {
    clearLayeredState()
  }
}
