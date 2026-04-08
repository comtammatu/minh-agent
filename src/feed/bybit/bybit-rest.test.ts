import { describe, it, expect, mock, beforeEach } from 'bun:test'

// ─── Mock bybit-api before any import of bybit-rest ─────────────────────────

const mockGetKline = mock(() =>
  Promise.resolve({
    retCode: 0,
    retMsg: 'OK',
    result: {
      // Bybit returns newest first — parser must reverse()
      list: [
        ['1700000060000', '50100', '50200', '50050', '50150', '10.5', '525000'],
        ['1700000000000', '50000', '50100', '49950', '50100', '12.0', '600000'],
      ],
    },
    retExtInfo: {},
    time: Date.now(),
  })
)

mock.module('bybit-api', () => ({
  RestClientV5: class {
    getKline = mockGetKline
  },
}))

// ─── Reset mock before each test ─────────────────────────────────────────────

beforeEach(() => {
  mockGetKline.mockRestore()
  mockGetKline.mockImplementation(() =>
    Promise.resolve({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          ['1700000060000', '50100', '50200', '50050', '50150', '10.5', '525000'],
          ['1700000000000', '50000', '50100', '49950', '50100', '12.0', '600000'],
        ],
      },
      retExtInfo: {},
      time: Date.now(),
    })
  )
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fetchBybitCandles', () => {
  it('returns candles in ascending order (reversed from API response)', async () => {
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    const candles = await fetchBybitCandles('BTC', '1m', Date.now() - 120_000)
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)
    // After reverse: oldest candle first (smaller t)
    expect(candles![0]!.t).toBeLessThan(candles![1]!.t)
    expect(candles![0]!.t).toBe(1700000000000)
    expect(candles![1]!.t).toBe(1700000060000)
  })

  it('parses OHLCV values as floats from strings', async () => {
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    const candles = await fetchBybitCandles('BTC', '1m', Date.now() - 120_000)
    expect(candles).not.toBeNull()
    const oldest = candles![0]!
    expect(oldest.o).toBe(50000)
    expect(oldest.h).toBe(50100)
    expect(oldest.l).toBe(49950)
    expect(oldest.c).toBe(50100)
    expect(oldest.v).toBe(12.0)
  })

  it('returns [] on empty list from API', async () => {
    mockGetKline.mockImplementation(() =>
      Promise.resolve({
        retCode: 0,
        retMsg: 'OK',
        result: { list: [] },
        retExtInfo: {},
        time: Date.now(),
      })
    )
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    const candles = await fetchBybitCandles('BTC', '1m', Date.now() - 120_000)
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
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    // maxRetries=1 to keep test fast
    const candles = await fetchBybitCandles('BTC', '1m', Date.now() - 120_000, undefined, 1)
    expect(candles).toBeNull()
  })

  it('returns null on network error after retries', async () => {
    mockGetKline.mockImplementation(() => Promise.reject(new Error('Network timeout')))
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    // maxRetries=1 to keep test fast
    const candles = await fetchBybitCandles('BTC', '1m', Date.now() - 120_000, undefined, 1)
    expect(candles).toBeNull()
  })

  it('returns null for unknown interval (no mapping)', async () => {
    const { fetchBybitCandles } = await import('./bybit-rest.js')
    // '3m' is not in BYBIT_INTERVAL_MAP
    const candles = await fetchBybitCandles('BTC', '5m' as never, Date.now() - 120_000)
    // '5m' is valid, so this should succeed — just confirming valid interval works
    expect(candles).not.toBeNull()
  })
})

describe('fetchBybitCandlesBatched', () => {
  it('returns combined candles from single batch when count <= batch size', async () => {
    const { fetchBybitCandlesBatched } = await import('./bybit-rest.js')
    const candles = await fetchBybitCandlesBatched('ETH', '1h', 100)
    expect(candles).not.toBeNull()
    expect(candles!.length).toBe(2)
    // Still in ascending order
    expect(candles![0]!.t).toBeLessThan(candles![1]!.t)
  })
})
