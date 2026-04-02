/**
 * QuantAdapter — wraps the existing EMA+RSI quant pipeline as IStrategy.
 *
 * Design:
 *   - Delegates to runQuantPipeline() which handles emit internally (legacy pattern).
 *   - scan() returns null — signals are emitted via getPipelineEmitter() inside runQuantPipeline.
 *
 * This adapter exists so that the StrategyRegistry can fan-out to the quant
 * pipeline using the same IStrategy interface as future strategies.
 */

import type { Candle, CandleInterval, Signal, PatternType } from '../../types.js'
import type { IStrategy } from '../strategy.js'
import { runQuantPipeline, clearQuantState } from '../quant-pipeline.js'
import { QUANT_EMA_SLOW } from '../../config.js'

export class QuantStrategyAdapter implements IStrategy {
  readonly id = 'quant'
  readonly name = 'EMA Trend + RSI Pullback'
  readonly patternTypes: ReadonlyArray<PatternType> = ['ema-rsi']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number): Signal | null {
    // Legacy pattern: runQuantPipeline emits via getPipelineEmitter() internally.
    runQuantPipeline(coin, interval, candles, idx)
    return null
  }

  minCandles(): number {
    return QUANT_EMA_SLOW
  }

  clearState(): void {
    clearQuantState()
  }
}
