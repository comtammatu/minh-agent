/**
 * HL REST candle backfill.
 * Sequential fetch — 18 calls for 3 coins × 6 TFs, ~9s total.
 */

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import type { Candle, CandleInterval } from '../types.js'
import { BACKFILL_CANDLE_COUNT } from '../config.js'

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
      const raw = await info.candleSnapshot({ coin, interval, startTime, endTime })
      if (!raw || raw.length === 0) return []
      return raw.map(parseCandle)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')

      if (is429) {
        rateLimitHits++
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          console.log(`[BACKFILL] ${coin} ${interval}: rate limited ${rateLimitHits}x — giving up`)
          return null
        }
        console.log(`[BACKFILL] ${coin} ${interval}: rate limited (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) — waiting 2s`)
        await new Promise(r => setTimeout(r, 2000))
        continue
      }

      attempt++
      if (attempt > maxRetries) return null

      console.log(`[BACKFILL] ${coin} ${interval}: error (attempt ${attempt}/${maxRetries}): ${msg}`)
      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }

  return null
}

/**
 * Compute the startTime for a full backfill of N candles.
 * Each interval has a known duration in ms.
 */
export function backfillStartTime(interval: CandleInterval, count = BACKFILL_CANDLE_COUNT): number {
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
