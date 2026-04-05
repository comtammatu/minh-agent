/**
 * Backtest E2E smoke test.
 *
 * Feeds 200 synthetic candles (trending market) through the full
 * backtest engine: pipeline → simulator → metrics → equity curve.
 *
 * Validates:
 *   1. runBacktest() runs without error on realistic-ish data
 *   2. Result structure is complete (metrics, equityCurve, pipelineStats)
 *   3. Pipeline actually processed candles (totalTicks > 0)
 *   4. Metrics are internally consistent (wins + losses = totalTrades)
 *   5. Equity curve starts at initial capital
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { runBacktest } from '../../src/backtest/engine.js'
import type { BacktestConfig } from '../../src/backtest/types.js'
import type { Candle, CandleInterval } from '../../src/types.js'
import { getStrategyRegistry, resetStrategyRegistry } from '../../src/scanner/strategy.js'
import { LayeredStrategyAdapter } from '../../src/scanner/strategies/layered-adapter.js'
import { QuantStrategyAdapter } from '../../src/scanner/strategies/quant-adapter.js'

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Generate N candles with a trending pattern + noise. */
function generateCandles(count: number, startPrice: number, startTime: number): Candle[] {
  const candles: Candle[] = []
  let price = startPrice
  const MS_PER_HOUR = 3600_000

  for (let i = 0; i < count; i++) {
    // Trending up with pullbacks: +0.5% avg, occasional -1% dips
    const trend = i % 7 === 0 ? -0.01 : 0.005
    const noise = (Math.sin(i * 0.7) * 0.003) + (Math.cos(i * 1.3) * 0.002)
    const change = trend + noise

    const open = price
    const close = price * (1 + change)
    const high = Math.max(open, close) * (1 + Math.abs(noise) * 0.5)
    const low = Math.min(open, close) * (1 - Math.abs(noise) * 0.5)
    const volume = 1000 + Math.random() * 500

    candles.push({
      t: startTime + i * MS_PER_HOUR,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
    })
    price = close
  }

  return candles
}

// ─── Smoke Test ────────────────────────────────────────────────────────────

// Register strategies before any test runs
beforeAll(() => {
  resetStrategyRegistry()
  const reg = getStrategyRegistry()
  reg.register(new LayeredStrategyAdapter())
  reg.register(new QuantStrategyAdapter())
})

describe('backtest E2E smoke', () => {
  const CANDLE_COUNT = 200
  const INITIAL_CAPITAL = 10_000
  const START_TIME = Date.UTC(2024, 0, 1) // 2024-01-01

  const config: BacktestConfig = {
    coins: ['BTC'],
    timeframes: ['1h' as CandleInterval],
    initialCapital: INITIAL_CAPITAL,
    slippagePct: 0.0005,
    commissionPct: 0.0003,
  }

  function buildCandleMap(): Map<string, Candle[]> {
    const map = new Map<string, Candle[]>()
    map.set('BTC|1h', generateCandles(CANDLE_COUNT, 40_000, START_TIME))
    return map
  }

  test('runs without error and returns complete result', () => {
    const candles = buildCandleMap()
    const result = runBacktest(candles, config)

    // Result structure
    expect(result.config).toBeDefined()
    expect(result.metrics).toBeDefined()
    expect(result.trades).toBeDefined()
    expect(result.equityCurve).toBeDefined()
    expect(Array.isArray(result.trades)).toBe(true)
    expect(Array.isArray(result.equityCurve)).toBe(true)
  })

  test('pipeline processes all candles (totalTicks > 0)', () => {
    const candles = buildCandleMap()
    const result = runBacktest(candles, config)

    expect(result.pipelineStats).toBeDefined()
    // Pipeline should have processed candles (minus first unclosed bar)
    expect(result.pipelineStats!.totalTicks).toBeGreaterThan(0)
    expect(result.pipelineStats!.totalTicks).toBeLessThanOrEqual(CANDLE_COUNT)
  })

  test('equity curve starts at initial capital', () => {
    const candles = buildCandleMap()
    const result = runBacktest(candles, config)

    expect(result.equityCurve.length).toBeGreaterThanOrEqual(1)
    expect(result.equityCurve[0]!.equity).toBe(INITIAL_CAPITAL)
  })

  test('metrics are internally consistent', () => {
    const candles = buildCandleMap()
    const result = runBacktest(candles, config)
    const m = result.metrics

    // wins + losses = totalTrades
    expect(m.wins + m.losses).toBe(m.totalTrades)

    // winRate in [0, 1]
    expect(m.winRate).toBeGreaterThanOrEqual(0)
    expect(m.winRate).toBeLessThanOrEqual(1)

    // maxDrawdown non-negative
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0)

    // netPnl = grossProfit + grossLoss
    expect(m.netPnl).toBeCloseTo(m.grossProfit + m.grossLoss, 2)

    // equity curve end = initial + sum of all trade PnLs
    if (result.trades.length > 0) {
      const totalPnl = result.trades.reduce((sum, t) => sum + t.pnl, 0)
      const lastEquity = result.equityCurve[result.equityCurve.length - 1]!.equity
      expect(lastEquity).toBeCloseTo(INITIAL_CAPITAL + totalPnl, 2)
    }
  })

  test('handles empty candle map gracefully', () => {
    const empty = new Map<string, Candle[]>()
    const result = runBacktest(empty, config)

    expect(result.trades.length).toBe(0)
    expect(result.metrics.totalTrades).toBe(0)
    expect(result.equityCurve.length).toBeGreaterThanOrEqual(1)
    expect(result.equityCurve[0]!.equity).toBe(INITIAL_CAPITAL)
  })

  test('handles insufficient candles (< INDICATOR_WINDOW)', () => {
    const map = new Map<string, Candle[]>()
    map.set('BTC|1h', generateCandles(10, 40_000, START_TIME))
    const result = runBacktest(map, config)

    // Should not crash — may produce 0 trades (not enough data for indicators)
    expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(0)
    expect(result.equityCurve[0]!.equity).toBe(INITIAL_CAPITAL)
  })

  test('multi-coin replay interleaves correctly', () => {
    const map = new Map<string, Candle[]>()
    map.set('BTC|1h', generateCandles(CANDLE_COUNT, 40_000, START_TIME))
    map.set('ETH|1h', generateCandles(CANDLE_COUNT, 2_500, START_TIME))

    const multiConfig: BacktestConfig = {
      ...config,
      coins: ['BTC', 'ETH'],
    }

    const result = runBacktest(map, multiConfig)

    // Pipeline should process candles from both coins
    expect(result.pipelineStats).toBeDefined()
    // 2 coins × ~200 ticks each (some may not count as closed)
    expect(result.pipelineStats!.totalTicks).toBeGreaterThan(CANDLE_COUNT)
  })
})
