/**
 * HL REST candle backfill.
 * Sequential fetch — 18 calls for 3 coins × 6 TFs, ~9s total.
 */

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import type { Candle, CandleInterval, BackfillResult } from '../types.js'
import { BACKFILL_CANDLE_COUNT, BACKFILL_CANDLE_COUNTS, BACKFILL_CONCURRENCY } from '../config.js'
import { acquire } from './rate-limiter.js'
import { log } from '../lib/logger.js'

const transport = new HttpTransport()
export const info = new InfoClient({ transport })

/** Parse HL numeric strings to floats. */
function parseCandle(raw: {
  t: number; T: number; o: string; h: string; l: string; c: string; v: string
}): Candle {
  return {
    t: raw.t,
    o: parseFloat(raw.o),
    h: parseFloat(raw.h),
    l: parseFloat(raw.l),
    c: parseFloat(raw.c),
    v: parseFloat(raw.v),
  }
}

/**
 * Fetch candles from HL REST with retry.
 * - Timeout / network error: retry up to maxRetries times (default 2)
 * - 429 rate limit: wait 2s then retry
 * - Empty response: return []
 * - On exhausted retries: return null (caller should skip this coin/tf)
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime?: number,
  maxRetries = 2,
): Promise<Candle[] | null> {
  let attempt = 0
  let rateLimitHits = 0
  const MAX_RATE_LIMIT_RETRIES = 10

  while (attempt <= maxRetries) {
    try {
      await acquire()
      const raw = await info.candleSnapshot({ coin, interval, startTime, endTime })
      if (!raw || raw.length === 0) return []
      return raw.map(parseCandle)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')

      if (is429) {
        rateLimitHits++
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          log.warn('backfill', `${coin} ${interval}: rate limited ${rateLimitHits}x — giving up`)
          return null
        }
        log.warn('backfill', `${coin} ${interval}: rate limited (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) — waiting 2s`)
        await new Promise(r => setTimeout(r, 2000))
        continue
      }

      attempt++
      if (attempt > maxRetries) return null

      log.warn('backfill', `${coin} ${interval}: error (attempt ${attempt}/${maxRetries}): ${msg}`)
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }

  return null
}

/**
 * Compute the startTime for a full backfill of N candles.
 * Each interval has a known duration in ms.
 */
export function backfillStartTime(interval: CandleInterval, count?: number): number {
  if (count === undefined) count = BACKFILL_CANDLE_COUNTS[interval] ?? BACKFILL_CANDLE_COUNT
  const intervalMs: Record<CandleInterval, number> = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  }
  return Date.now() - count * intervalMs[interval]
}

/**
 * Probe coins with a single 1m candle fetch to detect 500/unavailable coins early.
 * Returns list of coins that responded OK (non-null, non-error).
 * Failed coins are logged and excluded — saves full backfill retry time.
 */
export async function probeCoins(
  coins: string[],
  concurrency = BACKFILL_CONCURRENCY,
): Promise<{ valid: string[]; failed: string[] }> {
  const valid: string[] = []
  const failed: string[] = []

  let running = 0
  let idx = 0

  await new Promise<void>((resolve) => {
    if (coins.length === 0) { resolve(); return }
    let settled = 0

    function next(): void {
      while (running < concurrency && idx < coins.length) {
        const coin = coins[idx++]!
        running++
        probe(coin).then(() => {
          running--
          settled++
          if (settled === coins.length) resolve()
          else next()
        })
      }
    }

    async function probe(coin: string): Promise<void> {
      try {
        // Fetch just 1 candle from last 5 minutes — lightweight probe
        const result = await fetchCandles(coin, '1m', Date.now() - 300_000, undefined, 1)
        if (result === null) {
          failed.push(coin)
        } else {
          valid.push(coin)
        }
      } catch {
        failed.push(coin)
      }
    }

    next()
  })

  if (failed.length > 0) {
    log.info('probe', `${failed.length} coins unavailable: ${failed.join(', ')}`)
  }

  return { valid, failed }
}

/** TF priority order: small TFs first so scanner starts producing signals earlier. */
const TF_PRIORITY: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/**
 * Backfill all coins × all TFs in parallel with a concurrency cap.
 * - Small TFs first (1m before 1d) so scanner can start early
 * - Individual failures logged + skipped, never block others
 * - Returns per-coin ready count
 */
export async function backfillAllCoins(
  coins: string[],
  onCandles: (coin: string, interval: CandleInterval, candles: Candle[]) => void,
  concurrency = BACKFILL_CONCURRENCY,
  /** Optional: skip coin/TF pairs already loaded (e.g. from PG gap-fill). */
  isLoaded?: (coin: string, interval: CandleInterval) => boolean,
): Promise<BackfillResult[]> {
  // Build task list: coins × TFs, TF-priority order within each coin
  // Skip coin/TFs already loaded from PG gap-fill (avoids redundant REST calls)
  const tasks: { coin: string; interval: CandleInterval }[] = []
  let skipped = 0
  for (const interval of TF_PRIORITY) {
    for (const coin of coins) {
      if (isLoaded?.(coin, interval)) {
        skipped++
      } else {
        tasks.push({ coin, interval })
      }
    }
  }
  if (skipped > 0) {
    log.info('backfill', `skipping ${skipped} coin/TF pairs already loaded from PG`)
  }

  // Track per-coin ready count (pre-count skipped as ready)
  const readyMap = new Map<string, number>()
  for (const coin of coins) readyMap.set(coin, 0)
  // Count skipped (already loaded) coin/TFs as ready
  for (const interval of TF_PRIORITY) {
    for (const coin of coins) {
      if (isLoaded?.(coin, interval)) {
        readyMap.set(coin, (readyMap.get(coin) ?? 0) + 1)
      }
    }
  }

  // Semaphore: run at most `concurrency` tasks at once
  let running = 0
  let idx = 0
  const total = tasks.length

  await new Promise<void>((resolve, reject) => {
    if (total === 0) { resolve(); return }

    let settled = 0

    function next(): void {
      while (running < concurrency && idx < total) {
        const task = tasks[idx++]
        running++
        runTask(task.coin, task.interval)
          .then(() => {
            running--
            settled++
            if (settled === total) resolve()
            else next()
          })
          .catch(reject)
      }
    }

    async function runTask(coin: string, interval: CandleInterval): Promise<void> {
      try {
        const startTime = backfillStartTime(interval)
        const candles = await fetchCandles(coin, interval, startTime)

        if (candles === null) {
          log.warn('backfill', `${coin} ${interval}: FAILED — skipping`)
        } else if (candles.length === 0) {
          log.info('backfill', `${coin} ${interval}: empty`)
        } else {
          onCandles(coin, interval, candles)
          readyMap.set(coin, (readyMap.get(coin) ?? 0) + 1)
          log.info('backfill', `${coin} ${interval}: ${candles.length} candles`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('backfill', `${coin} ${interval}: unexpected error — ${msg}`)
      }
    }

    next()
  })

  return coins.map(coin => ({ coin, readyTFs: readyMap.get(coin) ?? 0 }))
}
