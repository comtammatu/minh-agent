/**
 * In-memory candle store.
 * Map<"BTC|1h", Candle[]> — upserts by timestamp, sorted ascending.
 * Single module-level instance (one process, one store).
 *
 * Optional onPersist callback: injected by index.ts to write-through to PG.
 * Keeps this module pure (no direct DB import). Tests run without DB.
 */

import type { Candle, CandleInterval, ExchangeId } from '../types.js'
import { INDICATOR_WINDOW, MAX_IN_MEMORY_CANDLES_BY_INTERVAL, MIN_CANDLES_FOR_SCAN } from '../config.js'

const store = new Map<string, Candle[]>()

/** Callback invoked after each candle upsert. Set via setOnPersist(). */
let onPersist: ((coin: string, interval: CandleInterval, candle: Candle) => void) | null = null

/** Register a persistence callback (fire-and-forget from caller's perspective). */
export function setOnPersist(fn: (coin: string, interval: CandleInterval, candle: Candle) => void): void {
  onPersist = fn
}

/** Clear the persistence callback (used in tests). */
export function clearOnPersist(): void {
  onPersist = null
}

function key(coin: string, interval: CandleInterval, exchange: ExchangeId = 'HL'): string {
  return `${exchange}:${coin}|${interval}`
}

function maxInMemoryCandles(interval: CandleInterval): number {
  const configured = MAX_IN_MEMORY_CANDLES_BY_INTERVAL[interval]
  // Orchestrator may request maxMin + 2 (closed-candle index).
  const minSafe = Math.max(MIN_CANDLES_FOR_SCAN, INDICATOR_WINDOW) + 2
  return Math.max(configured, minSafe)
}

function trim(arr: Candle[], cap: number): Candle[] {
  if (arr.length <= cap) return arr
  // Keep newest candles (array is sorted ascending by t).
  return arr.slice(-cap)
}

/** Upsert a candle by timestamp. Overwrites existing entry with same t. */
export function appendCandle(coin: string, interval: CandleInterval, candle: Candle, exchange: ExchangeId = 'HL'): void {
  const k = key(coin, interval, exchange)
  const cap = maxInMemoryCandles(interval)
  const arr = store.get(k) ?? []

  // Fast path: WS candles almost always match or extend the last entry
  const last = arr.length > 0 ? arr[arr.length - 1]! : null
  if (last && candle.t === last.t) {
    arr[arr.length - 1] = candle
    store.set(k, trim(arr, cap))
    onPersist?.(coin, interval, candle)
    return
  }
  if (last && candle.t > last.t) {
    arr.push(candle)
    store.set(k, trim(arr, cap))
    onPersist?.(coin, interval, candle)
    return
  }

  // Slow path: out-of-order or mid-array duplicate — binary search
  let lo = 0, hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]!.t === candle.t) {
      arr[mid] = candle
      store.set(k, trim(arr, cap))
      onPersist?.(coin, interval, candle)
      return
    }
    if (arr[mid]!.t < candle.t) lo = mid + 1
    else hi = mid - 1
  }
  // Insert at position `lo` to maintain sort
  arr.splice(lo, 0, candle)
  store.set(k, trim(arr, cap))
  onPersist?.(coin, interval, candle)
}

/** Set entire candle array for a coin/interval (replaces on backfill). */
export function setCandles(coin: string, interval: CandleInterval, candles: Candle[], exchange: ExchangeId = 'HL'): void {
  const sorted = [...candles].sort((a, b) => a.t - b.t)
  const cap = maxInMemoryCandles(interval)
  store.set(key(coin, interval, exchange), trim(sorted, cap))
}

/** Get last N candles for a coin/interval. Returns empty array if not found. */
export function getCandles(coin: string, interval: CandleInterval, count: number, exchange: ExchangeId = 'HL'): Candle[] {
  const arr = store.get(key(coin, interval, exchange))
  if (!arr) return []
  return arr.slice(-count)
}

/** Get total candle count for a coin/interval. */
export function candleCount(coin: string, interval: CandleInterval, exchange: ExchangeId = 'HL'): number {
  return store.get(key(coin, interval, exchange))?.length ?? 0
}

/**
 * % change from the current daily candle open (00:00 UTC bar) to mark price.
 * Uses the latest 1d candle's `o` as the session open vs Hyperliquid's UTC day alignment.
 */
export function dayChangePctFromUtcDayOpen(coin: string, markPrice: number, exchange: ExchangeId = 'HL'): number | null {
  const candles = getCandles(coin, '1d', 1, exchange)
  if (candles.length === 0) return null
  const dayOpen = candles[candles.length - 1]!.o
  if (dayOpen <= 0 || !Number.isFinite(dayOpen) || !Number.isFinite(markPrice)) return null
  return ((markPrice - dayOpen) / dayOpen) * 100
}

/** Clear all candle data for a specific coin (all timeframes). */
export function clearCoinData(coin: string, exchange: ExchangeId = 'HL'): void {
  for (const k of store.keys()) {
    if (k.startsWith(`${exchange}:${coin}|`)) store.delete(k)
  }
}

/** Clear all stored candles (used in tests). */
export function clearStore(): void {
  store.clear()
}
