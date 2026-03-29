/**
 * In-memory candle store.
 * Map<"BTC:1h", Candle[]> — upserts by timestamp, sorted ascending.
 * Single module-level instance (one process, one store).
 */

import type { Candle, CandleInterval } from '../types.js'

const store = new Map<string, Candle[]>()

function key(coin: string, interval: CandleInterval): string {
  return `${coin}:${interval}`
}

/** Upsert a candle by timestamp. Overwrites existing entry with same t. */
export function appendCandle(coin: string, interval: CandleInterval, candle: Candle): void {
  const k = key(coin, interval)
  const arr = store.get(k) ?? []

  // Fast path: WS candles almost always match or extend the last entry
  const last = arr.length > 0 ? arr[arr.length - 1]! : null
  if (last && candle.t === last.t) {
    arr[arr.length - 1] = candle
    store.set(k, arr)
    return
  }
  if (last && candle.t > last.t) {
    arr.push(candle)
    store.set(k, arr)
    return
  }

  // Slow path: out-of-order or mid-array duplicate — binary search
  let lo = 0, hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]!.t === candle.t) {
      arr[mid] = candle
      store.set(k, arr)
      return
    }
    if (arr[mid]!.t < candle.t) lo = mid + 1
    else hi = mid - 1
  }
  // Insert at position `lo` to maintain sort
  arr.splice(lo, 0, candle)
  store.set(k, arr)
}

/** Set entire candle array for a coin/interval (replaces on backfill). */
export function setCandles(coin: string, interval: CandleInterval, candles: Candle[]): void {
  const sorted = [...candles].sort((a, b) => a.t - b.t)
  store.set(key(coin, interval), sorted)
}

/** Get last N candles for a coin/interval. Returns empty array if not found. */
export function getCandles(coin: string, interval: CandleInterval, count: number): Candle[] {
  const arr = store.get(key(coin, interval))
  if (!arr) return []
  return arr.slice(-count)
}

/** Get total candle count for a coin/interval. */
export function candleCount(coin: string, interval: CandleInterval): number {
  return store.get(key(coin, interval))?.length ?? 0
}

/** Clear all stored candles (used in tests). */
export function clearStore(): void {
  store.clear()
}
