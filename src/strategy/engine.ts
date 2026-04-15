import type { Candle, CandleInterval, Signal, StrategyContext } from '../types.js'
import type { StrategyParams } from '../backtest/types.js'
import { SmcSdStrategy } from './strategies/smc-sd/index.js'

export interface SetupGenerator {
  scan(
    coin: string,
    interval: CandleInterval,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
    strategyParams?: StrategyParams,
  ): Signal | null
  minCandles(): number
  clearState(): void
}

let setupGenerator: SetupGenerator = new SmcSdStrategy()

export function getSetupGenerator(): SetupGenerator {
  return setupGenerator
}

export function getSetupGeneratorMinCandles(): number {
  return setupGenerator.minCandles()
}

export function runSetupGenerator(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  context?: StrategyContext,
  strategyParams?: StrategyParams,
): Signal | null {
  return setupGenerator.scan(coin, interval, candles, idx, context, strategyParams)
}

export function clearSetupGeneratorState(): void {
  setupGenerator.clearState()
}

export function resetSetupGenerator(): void {
  setupGenerator = new SmcSdStrategy()
}

export function setSetupGeneratorForTests(generator: SetupGenerator | null): void {
  setupGenerator = generator ?? new SmcSdStrategy()
}
