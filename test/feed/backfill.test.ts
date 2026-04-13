/**
 * backfillAllCoins tests — concurrency cap, TF priority, failure isolation.
 *
 * Uses rest.ts test hooks to inject deterministic fetch behavior without module-loader races.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { Candle, CandleInterval } from '../../src/types.js'
import {
  __resetRestTestDeps,
  __setRestTestDeps,
  backfillAllCoins,
} from '../../src/feed/rest.js'

// ── Track concurrent calls ────────────────────────────────────────────────

let concurrentNow = 0
let maxConcurrent = 0
let callLog: { coin: string; interval: CandleInterval }[] = []
let fetchDelay = 10
let failCoins: Set<string> = new Set()

function resetTracking() {
  concurrentNow = 0
  maxConcurrent = 0
  callLog = []
  fetchDelay = 10
  failCoins = new Set()
}

function makeCandle(t: number): Candle {
  return { t, o: 100, h: 101, l: 99, c: 100.5, v: 1000 }
}

// ── Deterministic fetch stub via test deps ────────────────────────────────

const mockFetchBatched = async (coin: string, interval: CandleInterval, _totalCount: number) => {
  concurrentNow++
  if (concurrentNow > maxConcurrent) maxConcurrent = concurrentNow
  callLog.push({ coin, interval })

  await new Promise(r => setTimeout(r, fetchDelay))

  concurrentNow--

  if (failCoins.has(coin)) return null
  return [makeCandle(1000), makeCandle(2000)]
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('backfillAllCoins', () => {
  beforeEach(() => {
    resetTracking()
    __setRestTestDeps({ fetchCandlesBatched: mockFetchBatched })
  })

  afterEach(() => {
    __resetRestTestDeps()
  })

  it('respects concurrency cap', async () => {
    const coins = Array.from({ length: 10 }, (_, i) => `COIN${i}`)
    const concurrency = 3
    const received: { coin: string; interval: CandleInterval; candles: Candle[] }[] = []

    await backfillAllCoins(
      coins,
      (coin: string, interval: CandleInterval, candles: Candle[]) => {
        received.push({ coin, interval, candles })
      },
      concurrency,
    )

    // Max concurrent should never exceed the cap
    expect(maxConcurrent).toBeLessThanOrEqual(concurrency)
    // Should have processed all coins × 6 TFs
    expect(callLog.length).toBe(10 * 6)
    // Should have received candles for all
    expect(received.length).toBe(10 * 6)
  })

  it('processes small TFs before large TFs', async () => {
    const coins = ['BTC', 'ETH']

    await backfillAllCoins(
      coins,
      () => {},
      1, // concurrency=1 forces serial execution → deterministic order
    )

    // With concurrency=1, tasks execute in exact queue order
    // TF priority: 1m, 5m, 15m, 1h, 4h, 1d — all coins per TF before next TF
    const intervals = callLog.map(c => c.interval)

    // First 2 calls should be 1m (BTC + ETH)
    expect(intervals[0]).toBe('1m')
    expect(intervals[1]).toBe('1m')
    // Next 2 should be 5m
    expect(intervals[2]).toBe('5m')
    expect(intervals[3]).toBe('5m')
    // Last 2 should be 1d
    expect(intervals[10]).toBe('1d')
    expect(intervals[11]).toBe('1d')
  })

  it('single coin failure does not block others', async () => {
    failCoins = new Set(['FAIL_COIN'])
    const coins = ['BTC', 'FAIL_COIN', 'ETH']
    const received: string[] = []

    const results = await backfillAllCoins(
      coins,
      (coin: string) => { received.push(coin) },
      5,
    )

    // BTC and ETH should succeed (6 TFs each)
    expect(received.filter(c => c === 'BTC').length).toBe(6)
    expect(received.filter(c => c === 'ETH').length).toBe(6)
    // FAIL_COIN should have 0 ready TFs
    expect(received.filter(c => c === 'FAIL_COIN').length).toBe(0)

    // Results should reflect readiness
    const btcResult = results.find(r => r.coin === 'BTC')
    const failResult = results.find(r => r.coin === 'FAIL_COIN')
    const ethResult = results.find(r => r.coin === 'ETH')
    expect(btcResult?.readyTFs).toBe(6)
    expect(failResult?.readyTFs).toBe(0)
    expect(ethResult?.readyTFs).toBe(6)
  })

  it('returns empty results for empty coin list', async () => {
    const results = await backfillAllCoins([], () => {}, 5)
    expect(results).toEqual([])
    expect(callLog.length).toBe(0)
  })

  it('returns correct BackfillResult per coin', async () => {
    const coins = ['SOL', 'HYPE']
    const results = await backfillAllCoins(coins, () => {}, 10)

    expect(results.length).toBe(2)
    expect(results[0]).toEqual({ coin: 'SOL', readyTFs: 6 })
    expect(results[1]).toEqual({ coin: 'HYPE', readyTFs: 6 })
  })
})
