/**
 * Async backtest engine tests — runBacktestAsync with progress callback.
 *
 * Tests cover:
 *   1. Returns same result as sync runBacktest for identical input
 *   2. Progress callback fires with correct phases
 *   3. Empty candles return empty result + done phase
 *   4. Yielding does not corrupt results
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { runBacktest, runBacktestAsync, type BacktestProgress } from '../../src/backtest/engine.js'
import type { BacktestConfig } from '../../src/backtest/types.js'
import type { Candle, CandleInterval } from '../../src/types.js'
import { getStrategyRegistry, resetStrategyRegistry } from '../../src/scanner/strategy.js'
import { LayeredStrategyAdapter } from '../../src/scanner/strategies/layered/index.js'
import { QuantStrategyAdapter } from '../../src/scanner/strategies/quant/index.js'

// Register strategies before any test runs
beforeAll(() => {
  resetStrategyRegistry()
  const reg = getStrategyRegistry()
  reg.register(new LayeredStrategyAdapter())
  reg.register(new QuantStrategyAdapter())
})

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { t, o, h, l, c, v }
}

/** Generate N candles with a simple upward drift. */
function generateCandles(n: number, startTs: number, intervalMs: number): Candle[] {
  const candles: Candle[] = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const t = startTs + i * intervalMs
    const o = price
    const h = price + 2
    const l = price - 1
    const c = price + 1
    candles.push(makeCandle(t, o, h, l, c, 500 + Math.random() * 1000))
    price = c
  }
  return candles
}

const BASE_CONFIG: BacktestConfig = {
  coins: ['BTC'],
  timeframes: ['1h'] as CandleInterval[],
  initialCapital: 10_000,
  slippagePct: 0.0005,
  commissionPct: 0.0003,
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runBacktestAsync', () => {
  test('empty candles → empty result + done callback', async () => {
    const candles = new Map<string, Candle[]>()
    const progress: BacktestProgress[] = []

    const result = await runBacktestAsync(candles, BASE_CONFIG, (p) => progress.push({ ...p }))

    expect(result.trades).toHaveLength(0)
    expect(result.metrics.totalTrades).toBe(0)
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[progress.length - 1]!.phase).toBe('done')
  })

  test('produces same metrics as sync runBacktest', async () => {
    const hourMs = 3_600_000
    const startTs = Date.now() - 300 * hourMs
    const candles = new Map<string, Candle[]>()
    candles.set('BTC|1h', generateCandles(300, startTs, hourMs))

    const syncResult = runBacktest(candles, BASE_CONFIG)
    const asyncResult = await runBacktestAsync(candles, BASE_CONFIG)

    expect(asyncResult.trades.length).toBe(syncResult.trades.length)
    expect(asyncResult.metrics.totalTrades).toBe(syncResult.metrics.totalTrades)
    expect(asyncResult.metrics.netPnl).toBeCloseTo(syncResult.metrics.netPnl, 4)
    expect(asyncResult.metrics.winRate).toBeCloseTo(syncResult.metrics.winRate, 4)
  })

  test('progress callback fires with replaying + computing + done phases', async () => {
    const hourMs = 3_600_000
    const startTs = Date.now() - 200 * hourMs
    const candles = new Map<string, Candle[]>()
    candles.set('BTC|1h', generateCandles(200, startTs, hourMs))

    const phases = new Set<string>()
    const progress: BacktestProgress[] = []

    await runBacktestAsync(candles, BASE_CONFIG, (p) => {
      phases.add(p.phase)
      progress.push({ ...p })
    })

    expect(phases.has('replaying')).toBe(true)
    expect(phases.has('computing')).toBe(true)
    expect(phases.has('done')).toBe(true)

    // pct should be monotonically non-decreasing
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.pct).toBeGreaterThanOrEqual(progress[i - 1]!.pct)
    }

    // Last event should be 100%
    expect(progress[progress.length - 1]!.pct).toBe(100)
  })

  test('bar count in progress matches total replay events', async () => {
    const hourMs = 3_600_000
    const startTs = Date.now() - 250 * hourMs
    const candles = new Map<string, Candle[]>()
    candles.set('BTC|1h', generateCandles(250, startTs, hourMs))

    let lastTotal = 0
    await runBacktestAsync(candles, BASE_CONFIG, (p) => {
      if (p.total > 0) lastTotal = p.total
    })

    // Total should match candle count (1 coin × 1 TF × 250 candles)
    expect(lastTotal).toBe(250)
  })

  test('without progress callback still works', async () => {
    const hourMs = 3_600_000
    const startTs = Date.now() - 100 * hourMs
    const candles = new Map<string, Candle[]>()
    candles.set('BTC|1h', generateCandles(100, startTs, hourMs))

    // No callback — should not throw
    const result = await runBacktestAsync(candles, BASE_CONFIG)
    expect(result.config).toEqual(BASE_CONFIG)
  })
})
