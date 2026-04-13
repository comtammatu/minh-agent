import { describe, test, expect } from 'bun:test'
import {
  parseBenchmarkArgs,
  quantileSorted,
  summarizeLatency,
  trimOutliers,
  generateSyntheticCandles,
  buildReplayEvents,
} from '../../src/backtest/pipeline-benchmark.js'

describe('pipeline-benchmark helpers', () => {
  test('parseBenchmarkArgs returns defaults', () => {
    const opts = parseBenchmarkArgs([])

    expect(opts.coins.length).toBeGreaterThan(0)
    expect(opts.timeframes.length).toBeGreaterThan(0)
    expect(opts.barsPerSeries).toBeGreaterThan(0)
    expect(opts.warmupRuns).toBeGreaterThanOrEqual(0)
    expect(opts.measuredRuns).toBeGreaterThan(0)
    expect(opts.outlierTrimRatio).toBeGreaterThanOrEqual(0)
    expect(opts.outputPath).toBeNull()
    expect(opts.seed).toBe(42)
    expect(opts.saveResult).toBe(false)
  })

  test('parseBenchmarkArgs parses custom args and filters invalid timeframe', () => {
    const opts = parseBenchmarkArgs([
      '--coins', 'BTC,ETH',
      '--tfs', '5m,15m,bad',
      '--bars', '900',
      '--warmup', '1',
      '--runs', '3',
      '--trim', '0.02',
      '--out', 'results/custom.json',
      '--seed', '7',
      '--save',
    ])

    expect(opts.coins).toEqual(['BTC', 'ETH'])
    expect(opts.timeframes).toEqual(['5m', '15m'])
    expect(opts.barsPerSeries).toBe(900)
    expect(opts.warmupRuns).toBe(1)
    expect(opts.measuredRuns).toBe(3)
    expect(opts.outlierTrimRatio).toBe(0.02)
    expect(opts.outputPath).toBe('results/custom.json')
    expect(opts.seed).toBe(7)
    expect(opts.saveResult).toBe(true)
  })

  test('trimOutliers removes symmetric tails and keeps sorted values', () => {
    const samples = [100, 1, 2, 3, 4, 5, 6, 7, 8, 200]
    const trimmed = trimOutliers(samples, 0.1)
    expect(trimmed).toEqual([2, 3, 4, 5, 6, 7, 8, 100])
  })

  test('quantileSorted interpolates percentiles', () => {
    const sorted = [1, 2, 3, 4] as const

    expect(quantileSorted(sorted, 0)).toBe(1)
    expect(quantileSorted(sorted, 1)).toBe(4)
    expect(quantileSorted(sorted, 0.5)).toBe(2.5)
    expect(quantileSorted(sorted, 0.75)).toBe(3.25)
  })

  test('summarizeLatency returns basic distribution stats', () => {
    const stats = summarizeLatency([4, 1, 3, 2])

    expect(stats.count).toBe(4)
    expect(stats.minMs).toBe(1)
    expect(stats.maxMs).toBe(4)
    expect(stats.meanMs).toBe(2.5)
    expect(stats.p50Ms).toBe(2.5)
    expect(stats.p95Ms).toBeGreaterThanOrEqual(stats.p50Ms)
    expect(stats.p99Ms).toBeGreaterThanOrEqual(stats.p95Ms)
  })

  test('generateSyntheticCandles + buildReplayEvents are deterministic by seed', () => {
    const coins = ['BTC', 'ETH']
    const tfs = ['5m', '1h'] as const

    const a = generateSyntheticCandles(coins, tfs, 10, 123)
    const b = generateSyntheticCandles(coins, tfs, 10, 123)

    expect(a.get('BTC|5m')).toEqual(b.get('BTC|5m'))
    expect(a.get('ETH|1h')).toEqual(b.get('ETH|1h'))

    const events = buildReplayEvents(a, coins, tfs)
    expect(events.length).toBe(40)

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.candle.t).toBeGreaterThanOrEqual(events[i - 1]!.candle.t)
    }
  })
})
