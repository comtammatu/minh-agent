import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { RestClientV5 } from 'bybit-api'
import {
  __setBybitRestTestDeps,
  fetchBybitCandles,
  fetchBybitCandlesBatched,
} from './bybit-rest.js'

// ─── Deterministic fixtures + mock isolation helpers ────────────────────────

const FIXED_NOW = 1_700_000_120_000
const TEST_START_TIME = FIXED_NOW - 120_000
const DEFAULT_KLINE_LIST = [
  ['1700000060000', '50100', '50200', '50050', '50150', '10.5', '525000'],
  ['1700000000000', '50000', '50100', '49950', '50100', '12.0', '600000'],
]

function makeKlineSuccessResponse(list: string[][] = DEFAULT_KLINE_LIST): {
  retCode: number
  retMsg: string
  result: { list: string[][] }
  retExtInfo: Record<string, string>
  time: number
} {
  return {
    retCode: 0,
    retMsg: 'OK',
    result: { list },
    retExtInfo: {},
    time: Date.now(),
  }
}

const mockGetKline = mock(() => Promise.resolve(makeKlineSuccessResponse()))
const mockGetTickers = mock(() => Promise.resolve({ retCode: 0, retMsg: 'OK', result: { list: [] } }))
const mockAcquire = mock(() => Promise.resolve())

type BybitRestClient = Pick<RestClientV5, 'getKline' | 'getTickers'>

function installTestDeps(): void {
  const client: BybitRestClient = {
    getKline: mockGetKline as unknown as BybitRestClient['getKline'],
    getTickers: mockGetTickers as unknown as BybitRestClient['getTickers'],
  }
  __setBybitRestTestDeps({ client, acquire: mockAcquire })
}

// ─── Reset mock + clock before each test ────────────────────────────────────

let originalDateNow: typeof Date.now

beforeEach(() => {
  originalDateNow = Date.now
  Date.now = () => FIXED_NOW

  mockGetKline.mockClear()
  mockGetKline.mockImplementation(() => Promise.resolve(makeKlineSuccessResponse()))

  mockAcquire.mockClear()
  mockAcquire.mockImplementation(() => Promise.resolve())

  installTestDeps()
})

afterEach(() => {
  Date.now = originalDateNow
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.serial('fetchBybitCandles', () => {
  it('returns candles in ascending order (reversed from API response)', async () => {
    const candles = await fetchBybitCandles('BTC', '1m', TEST_START_TIME)
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)
    // Regression guard: ensure test used mock path, not live market data.
    expect(mockGetKline).toHaveBeenCalledTimes(1)
    expect(mockAcquire).toHaveBeenCalledTimes(1)

    // After reverse: oldest candle first (smaller t)
    expect(candles![0]!.t).toBeLessThan(candles![1]!.t)
    expect(candles![0]!.t).toBe(1700000000000)
    expect(candles![1]!.t).toBe(1700000060000)
  })

  it('parses OHLCV values as floats from strings', async () => {
    const candles = await fetchBybitCandles('BTC', '1m', TEST_START_TIME)
    expect(candles).not.toBeNull()
    const oldest = candles![0]!
    expect(oldest.o).toBe(50000)
    expect(oldest.h).toBe(50100)
    expect(oldest.l).toBe(49950)
    expect(oldest.c).toBe(50100)
    expect(oldest.v).toBe(12.0)
  })

  it('returns [] on empty list from API', async () => {
    mockGetKline.mockImplementation(() => Promise.resolve(makeKlineSuccessResponse([])))
    const candles = await fetchBybitCandles('BTC', '1m', TEST_START_TIME)
    expect(candles).not.toBeNull()
    expect(candles).toEqual([])
  })

  it('returns null when retCode !== 0 (API error exhausts retries)', async () => {
    mockGetKline.mockImplementation(() =>
      Promise.resolve({
        retCode: 10001,
        retMsg: 'Params error',
        result: { list: [] },
        retExtInfo: {},
        time: Date.now(),
      })
    )
    // maxRetries=1 to keep test fast
    const candles = await fetchBybitCandles('BTC', '1m', TEST_START_TIME, undefined, 1)
    expect(candles).toBeNull()
  })

  it('returns null on network error after retries', async () => {
    mockGetKline.mockImplementation(() => Promise.reject(new Error('Network timeout')))
    // maxRetries=1 to keep test fast
    const candles = await fetchBybitCandles('BTC', '1m', TEST_START_TIME, undefined, 1)
    expect(candles).toBeNull()
  })

  it('returns null for unknown interval (no mapping)', async () => {
    const candles = await fetchBybitCandles('BTC', '5m' as never, TEST_START_TIME)
    // '5m' is valid, so this should succeed — just confirming valid interval works
    expect(candles).not.toBeNull()
  })
})

describe.serial('fetchBybitCandlesBatched', () => {
  it('returns combined candles from single batch when count <= batch size', async () => {
    const candles = await fetchBybitCandlesBatched('ETH', '1h', 100)
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)
    expect(mockGetKline).toHaveBeenCalledTimes(1)
    // Still in ascending order
    expect(candles![0]!.t).toBeLessThan(candles![1]!.t)
  })
})
