import { describe, expect, test } from 'bun:test'
import type { Candle, CandleInterval } from '../../src/types.js'
import { runReleaseGateValidationOnCandles } from '../../src/backtest/run-release-gate.js'

const COUNTS: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 500,
  '15m': 500,
  '1h': 500,
  '4h': 500,
  '1d': 500,
}

function makeCandles(intervalMs: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index
    return {
      t: Date.UTC(2025, 0, 1) + index * intervalMs,
      o: base,
      h: base + 2,
      l: base - 2,
      c: base + 1,
      v: 1000 + index,
    }
  })
}

describe('runReleaseGateValidationOnCandles', () => {
  test('preserves disabled scan modes in the artifact output', () => {
    const candles = new Map<string, Candle[]>([
      ['BTC|1h', makeCandles(60 * 60 * 1000, 24)],
      ['BTC|4h', makeCandles(4 * 60 * 60 * 1000, 24)],
      ['BTC|15m', makeCandles(15 * 60 * 1000, 24)],
      ['BTC|5m', makeCandles(5 * 60 * 1000, 24)],
    ])

    const output = runReleaseGateValidationOnCandles(candles, {
      coins: ['BTC'],
      strategyParams: {},
      counts: COUNTS,
      disabledScanModes: ['1h_same_tf', '4h_poi'],
    })

    expect(output.disabledScanModes).toEqual(['1h_same_tf', '4h_poi'])
    expect(output.coins).toEqual(['BTC'])
    expect(output.verdict).toBe('NO-GO')
  })
})
