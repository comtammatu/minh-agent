/**
 * Backtest Data Manager — bulk historical candle download, gap detection, gap-fill.
 *
 * Design:
 *   - Downloads historical candles from HL REST, paginating at 5000/request
 *   - Stores to PostgreSQL via candle-repo bulkUpsertCandles
 *   - Pure gap-detection functions (no I/O) for testability
 *   - Reuses feed/rest.ts fetchCandles + feed/rate-limiter.ts
 *
 * HL REST constraint: max 5000 candles per candleSnapshot request.
 * Rate limit: weight-based 1200/min — all calls go through acquire().
 */

import type { Candle, CandleInterval } from '../types.js'
import { fetchCandles } from '../feed/rest.js'
import { bulkUpsertCandles, loadCandles } from '../db/candle-repo.js'
import { TIMEFRAME_MS } from '../config.js'
import { log } from '../lib/logger.js'

/** Max candles per HL REST request. */
const HL_MAX_CANDLES_PER_REQUEST = 5000

// ─── Pure Functions (no I/O) ──────────────────────────────────────────────

export interface Gap {
  /** Start timestamp (ms) — first missing candle open time. */
  start: number
  /** End timestamp (ms) — last missing candle open time. */
  end: number
  /** Number of missing candles in this gap. */
  count: number
}

/**
 * Detect gaps in a sorted candle array for a given interval.
 *
 * Pure function — no I/O.
 *
 * @param candles - Sorted ascending by timestamp
 * @param intervalMs - Expected duration between consecutive candles (ms)
 * @returns Array of Gap objects describing missing ranges
 */
export function detectGaps(candles: Candle[], intervalMs: number): Gap[] {
  if (candles.length < 2) return []

  const gaps: Gap[] = []
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!
    const curr = candles[i]!
    const expected = prev.t + intervalMs
    if (curr.t > expected) {
      const missingCount = Math.round((curr.t - expected) / intervalMs)
      if (missingCount > 0) {
        gaps.push({
          start: expected,
          end: curr.t - intervalMs,
          count: missingCount,
        })
      }
    }
  }

  return gaps
}

/**
 * Compute pagination windows for downloading a date range.
 * Each window is at most HL_MAX_CANDLES_PER_REQUEST candles wide.
 *
 * Pure function — no I/O.
 *
 * @param startMs - Start timestamp (ms, inclusive)
 * @param endMs   - End timestamp (ms, inclusive)
 * @param intervalMs - Candle interval duration (ms)
 * @returns Array of { startTime, endTime } windows
 */
export function computeDownloadWindows(
  startMs: number,
  endMs: number,
  intervalMs: number,
): { startTime: number; endTime: number }[] {
  if (startMs > endMs) return []

  const windows: { startTime: number; endTime: number }[] = []
  let cursor = startMs

  while (cursor <= endMs) {
    const windowEnd = Math.min(
      cursor + (HL_MAX_CANDLES_PER_REQUEST - 1) * intervalMs,
      endMs,
    )
    windows.push({ startTime: cursor, endTime: windowEnd })
    cursor = windowEnd + intervalMs
  }

  return windows
}

// ─── BacktestDataManager (I/O boundary) ────────────────────────────────────

export class BacktestDataManager {
  /**
   * Download historical candles for a coin/interval range and persist to PG.
   * Paginates at 5000 candles per request. Sequential to respect rate limits.
   *
   * @returns Total candles persisted
   */
  async downloadHistory(
    coin: string,
    interval: CandleInterval,
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const intervalMs = TIMEFRAME_MS[interval]
    const startMs = startDate.getTime()
    const endMs = endDate.getTime()

    const windows = computeDownloadWindows(startMs, endMs, intervalMs)
    if (windows.length === 0) return 0

    let totalPersisted = 0

    log('INFO', 'backtest-data', `Downloading ${coin} ${interval}: ${windows.length} pages, ${startDate.toISOString()} → ${endDate.toISOString()}`)

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!
      const candles = await fetchCandles(coin, interval, w.startTime, w.endTime)

      if (candles === null) {
        log('WARN', 'backtest-data', `${coin} ${interval} page ${i + 1}/${windows.length}: fetch failed — skipping`)
        continue
      }

      if (candles.length === 0) {
        log('DEBUG', 'backtest-data', `${coin} ${interval} page ${i + 1}/${windows.length}: empty`)
        continue
      }

      const persisted = await bulkUpsertCandles(coin, interval, candles)
      totalPersisted += persisted

      log('DEBUG', 'backtest-data', `${coin} ${interval} page ${i + 1}/${windows.length}: ${persisted} candles`)
    }

    log('INFO', 'backtest-data', `${coin} ${interval}: ${totalPersisted} candles persisted`)
    return totalPersisted
  }

  /**
   * Check for gaps in stored candles for a coin/interval.
   * Loads all candles from PG and runs pure gap detection.
   */
  async checkGaps(
    coin: string,
    interval: CandleInterval,
  ): Promise<Gap[]> {
    const intervalMs = TIMEFRAME_MS[interval]
    // Load a large number of candles — 100K covers ~69 days of 1m data
    const candles = await loadCandles(coin, interval, 100_000)

    if (candles.length < 2) return []

    return detectGaps(candles, intervalMs)
  }

  /**
   * Fill detected gaps by downloading only the missing ranges.
   *
   * @returns Total candles persisted across all gaps
   */
  async fillGaps(
    coin: string,
    interval: CandleInterval,
  ): Promise<number> {
    const gaps = await this.checkGaps(coin, interval)

    if (gaps.length === 0) {
      log('DEBUG', 'backtest-data', `${coin} ${interval}: no gaps found`)
      return 0
    }

    log('INFO', 'backtest-data', `${coin} ${interval}: ${gaps.length} gaps found, ${gaps.reduce((s, g) => s + g.count, 0)} missing candles`)

    let totalPersisted = 0

    for (const gap of gaps) {
      const persisted = await this.downloadHistory(
        coin,
        interval,
        new Date(gap.start),
        new Date(gap.end),
      )
      totalPersisted += persisted
    }

    log('INFO', 'backtest-data', `${coin} ${interval}: ${totalPersisted} gap candles filled`)
    return totalPersisted
  }

  /**
   * Load candles from PG for backtest engine consumption.
   * Returns Map<"COIN:INTERVAL", Candle[]> sorted ascending.
   */
  async loadForBacktest(
    coins: string[],
    intervals: CandleInterval[],
    startDate: Date,
    endDate: Date,
  ): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>()
    const startMs = startDate.getTime()
    const endMs = endDate.getTime()

    for (const coin of coins) {
      for (const interval of intervals) {
        // Load all candles, then filter to date range
        const all = await loadCandles(coin, interval, 100_000)
        const filtered = all.filter(c => c.t >= startMs && c.t <= endMs)
        const key = `${coin}:${interval}`
        result.set(key, filtered)

        log('DEBUG', 'backtest-data', `Loaded ${key}: ${filtered.length} candles`)
      }
    }

    return result
  }
}
