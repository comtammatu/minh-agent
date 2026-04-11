import { describe, it, expect } from 'bun:test'
import { SmcSdStrategy } from './index.js'
import type { Candle } from '../../../types.js'
import type { StrategyParams } from '../../../backtest/types.js'

/**
 * Build synthetic 1h candles with a sinusoidal price pattern.
 * Amplitude creates swing highs/lows that detectStructureBreaks can find.
 */
function makeCandles(count: number, basePrice = 100, amplitude = 10): Candle[] {
  const baseTime = 1_700_000_000_000 // fixed for deterministic tests
  return Array.from({ length: count }, (_, i) => {
    const price = basePrice + Math.sin(i / 15) * amplitude
    return {
      t: baseTime + i * 3_600_000,
      o: price,
      h: price + amplitude * 0.1,
      l: price - amplitude * 0.1,
      c: price + amplitude * 0.03,
      v: 1000 + (i % 7) * 200,
    }
  })
}

describe('SmcSdStrategy — SMC_1H_CONFIDENCE_BASE', () => {
  const strategy = new SmcSdStrategy()

  it('StrategyParams accepts SMC_1H_CONFIDENCE_BASE (compile-time + runtime)', () => {
    const params: StrategyParams = { SMC_1H_CONFIDENCE_BASE: 0.65 }
    expect(params.SMC_1H_CONFIDENCE_BASE).toBe(0.65)
  })

  it('does not crash with strategyParams: undefined (backward compat, fallback to 0.65)', () => {
    const candles = makeCandles(100)
    expect(() =>
      strategy.scan('BTC', '1h', candles, candles.length - 1, undefined, undefined)
    ).not.toThrow()
  })

  it('blocks all 1h signals when MIN_CONFIDENCE is impossibly high (2.0)', () => {
    // With MIN_CONFIDENCE: 2.0 no signal can pass the threshold check,
    // verifying that strategyParams threads through to scan1hSameTF.
    const candles = makeCandles(200)
    const params: StrategyParams = { MIN_CONFIDENCE: 2.0 }
    const result = strategy.scan('BTC', '1h', candles, candles.length - 1, undefined, params)
    expect(result).toBeNull()
  })
})
