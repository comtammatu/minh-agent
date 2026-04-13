import { describe, it, expect, beforeEach } from 'bun:test'
import { appendCandle, setCandles, getCandles, getCandlesInto, candleCount, clearStore } from '../src/feed/store.js'
import { MAX_IN_MEMORY_CANDLES_BY_INTERVAL } from '../src/config.js'
import type { Candle } from '../src/types.js'

function makeCandle(t: number, price = 100): Candle {
  return { t, o: price, h: price + 1, l: price - 1, c: price, v: 1000 }
}

describe('store', () => {
  beforeEach(() => { clearStore() })

  describe('appendCandle', () => {
    it('appends new candle', () => {
      appendCandle('BTC', '1h', makeCandle(1000))
      expect(candleCount('BTC', '1h')).toBe(1)
    })

    it('upserts duplicate timestamp — overwrites', () => {
      appendCandle('BTC', '1h', makeCandle(1000, 100))
      appendCandle('BTC', '1h', makeCandle(1000, 200))  // same ts, different price
      expect(candleCount('BTC', '1h')).toBe(1)
      const candles = getCandles('BTC', '1h', 10)
      expect(candles[0]!.c).toBe(200)  // overwritten
    })

    it('maintains ascending sort after out-of-order insert', () => {
      appendCandle('BTC', '1h', makeCandle(3000))
      appendCandle('BTC', '1h', makeCandle(1000))
      appendCandle('BTC', '1h', makeCandle(2000))
      const candles = getCandles('BTC', '1h', 10)
      expect(candles[0]!.t).toBe(1000)
      expect(candles[1]!.t).toBe(2000)
      expect(candles[2]!.t).toBe(3000)
    })

    it('isolates different coin/tf keys', () => {
      appendCandle('BTC', '1h', makeCandle(1000))
      appendCandle('ETH', '1h', makeCandle(2000))
      expect(candleCount('BTC', '1h')).toBe(1)
      expect(candleCount('ETH', '1h')).toBe(1)
      expect(getCandles('BTC', '1h', 1)[0]!.t).toBe(1000)
      expect(getCandles('ETH', '1h', 1)[0]!.t).toBe(2000)
    })

    it('trims in-memory candles to max window per interval', () => {
      const cap = MAX_IN_MEMORY_CANDLES_BY_INTERVAL['1m']
      for (let i = 1; i <= cap + 50; i++) {
        appendCandle('BTC', '1m', makeCandle(i))
      }
      expect(candleCount('BTC', '1m')).toBe(cap)
      const candles = getCandles('BTC', '1m', cap + 100)
      expect(candles[0]!.t).toBe(51) // kept last `cap` candles
      expect(candles.at(-1)!.t).toBe(cap + 50)
    })
  })

  describe('setCandles', () => {
    it('replaces existing candles', () => {
      appendCandle('BTC', '4h', makeCandle(1000))
      setCandles('BTC', '4h', [makeCandle(2000), makeCandle(3000)])
      expect(candleCount('BTC', '4h')).toBe(2)
      expect(getCandles('BTC', '4h', 2)[0]!.t).toBe(2000)
    })

    it('sorts candles ascending', () => {
      setCandles('BTC', '4h', [makeCandle(3000), makeCandle(1000), makeCandle(2000)])
      const candles = getCandles('BTC', '4h', 10)
      expect(candles[0]!.t).toBe(1000)
      expect(candles[2]!.t).toBe(3000)
    })

    it('trims when setting large candle arrays', () => {
      const cap = MAX_IN_MEMORY_CANDLES_BY_INTERVAL['5m']
      const all = Array.from({ length: cap + 25 }, (_, i) => makeCandle(i + 1))
      setCandles('ETH', '5m', all)
      expect(candleCount('ETH', '5m')).toBe(cap)
      const candles = getCandles('ETH', '5m', cap + 100)
      expect(candles[0]!.t).toBe(26)
      expect(candles.at(-1)!.t).toBe(cap + 25)
    })
  })

  describe('getCandles', () => {
    it('returns empty array when key not found', () => {
      expect(getCandles('XRP', '1m', 10)).toEqual([])
    })

    it('returns last N candles', () => {
      setCandles('BTC', '1m', [1, 2, 3, 4, 5].map(t => makeCandle(t)))
      const candles = getCandles('BTC', '1m', 3)
      expect(candles.length).toBe(3)
      expect(candles[0]!.t).toBe(3)  // last 3: ts 3,4,5
      expect(candles[2]!.t).toBe(5)
    })

    it('returns all when count > stored', () => {
      setCandles('BTC', '1m', [makeCandle(1), makeCandle(2)])
      expect(getCandles('BTC', '1m', 100).length).toBe(2)
    })
  })

  describe('getCandlesInto', () => {
    it('reuses target array and copies last N candles', () => {
      setCandles('BTC', '1m', [1, 2, 3, 4, 5].map(t => makeCandle(t)))
      const target: Candle[] = [makeCandle(999)]  // should be replaced

      const out = getCandlesInto('BTC', '1m', 3, target)

      expect(out).toBe(target)
      expect(out.length).toBe(3)
      expect(out[0]!.t).toBe(3)
      expect(out[2]!.t).toBe(5)
    })

    it('clears target when key not found', () => {
      const target: Candle[] = [makeCandle(1)]
      const out = getCandlesInto('DOGE', '1h', 10, target)
      expect(out).toEqual([])
      expect(target).toEqual([])
    })

    it('copies all candles when count exceeds stored', () => {
      setCandles('ETH', '5m', [makeCandle(10), makeCandle(20)])
      const out = getCandlesInto('ETH', '5m', 100, [])
      expect(out.length).toBe(2)
      expect(out[0]!.t).toBe(10)
      expect(out[1]!.t).toBe(20)
    })
  })

  describe('candleCount', () => {
    it('returns 0 for unknown key', () => {
      expect(candleCount('DOGE', '1d')).toBe(0)
    })

    it('returns correct count', () => {
      setCandles('ETH', '15m', [makeCandle(1), makeCandle(2), makeCandle(3)])
      expect(candleCount('ETH', '15m')).toBe(3)
    })
  })
})
