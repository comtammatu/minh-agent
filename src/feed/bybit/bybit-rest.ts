/**
 * Bybit REST candle backfill.
 * Symbol format: BTCUSDT (coin + 'USDT').
 * Bybit returns newest-first — must reverse() after parse.
 * Max 1000 candles per request (BYBIT_BACKFILL_BATCH_SIZE).
 */

import { RestClientV5 } from 'bybit-api'
import type { KlineIntervalV3 } from 'bybit-api'
import type { Candle, CandleInterval, BackfillResult } from '../../types.js'
import {
  BYBIT_BACKFILL_BATCH_SIZE,
  BYBIT_BACKFILL_CANDLE_COUNTS,
  BYBIT_INTERVAL_MAP,
} from '../../config.js'
import { acquire as acquireRateLimit } from './bybit-rate-limiter.js'
import { log } from '../../lib/logger.js'

type BybitRestClient = Pick<RestClientV5, 'getKline' | 'getTickers'>
type AcquireFn = () => Promise<void>

function createDefaultClient(): BybitRestClient {
  return new RestClientV5({ testnet: false })
}

let client: BybitRestClient = createDefaultClient()
let acquireFn: AcquireFn = acquireRateLimit

/**
 * Test hook: override Bybit REST dependencies to keep tests deterministic.
 * Production path should never call this.
 */
export function __setBybitRestTestDeps(deps: { client?: BybitRestClient; acquire?: AcquireFn }): void {
  if (deps.client) client = deps.client
  if (deps.acquire) acquireFn = deps.acquire
}

/** Reset test overrides to production dependencies. */
export function __resetBybitRestTestDeps(): void {
  client = createDefaultClient()
  acquireFn = acquireRateLimit
}

// ─── Funding Rate Cache ───────────────────────────────────────────────────────

/** coin → current funding rate (from getTickers). Updated by loadBybitFundingRates(). */
const fundingRates: Map<string, number> = new Map()

/** Get the cached funding rate for a coin. Returns null if not yet loaded. */
export function getBybitFundingRate(coin: string): number | null {
  return fundingRates.get(coin) ?? null
}

/**
 * Fetch all linear USDT-perp funding rates from Bybit getTickers (public endpoint).
 * Single call — no auth required. Updates the module-level cache.
 * Call once at startup and refresh every ~4h (funding settles every 8h).
 */
export async function loadBybitFundingRates(): Promise<void> {
  try {
    const resp = await client.getTickers({ category: 'linear' })
    if (resp.retCode !== 0) {
      log.warn('bybit-funding', `getTickers failed: retCode=${resp.retCode} ${resp.retMsg}`)
      return
    }
    fundingRates.clear()
    let count = 0
    for (const ticker of resp.result?.list ?? []) {
      if (!ticker.symbol.endsWith('USDT')) continue
      const coin = ticker.symbol.slice(0, -'USDT'.length)
      const rate = parseFloat(ticker.fundingRate ?? '')
      if (Number.isFinite(rate)) {
        fundingRates.set(coin, rate)
        count++
      }
    }
    log.info('bybit-funding', `Loaded funding rates for ${count} coins`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('bybit-funding', `loadBybitFundingRates error: ${msg}`)
  }
}

/** Convert coin name to Bybit linear perp symbol (e.g. BTC → BTCUSDT). */
function toSymbol(coin: string): string {
  return `${coin}USDT`
}

/** Milliseconds per candle interval — used for batch window computation. */
const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
}

/**
 * Parse a raw Bybit OHLCV entry to a Candle.
 * Raw format: [startTimeMs, open, high, low, close, volume, turnover] (all strings).
 */
function parseBybitCandle(raw: string[]): Candle {
  return {
    t: parseInt(raw[0]!, 10),
    o: parseFloat(raw[1]!),
    h: parseFloat(raw[2]!),
    l: parseFloat(raw[3]!),
    c: parseFloat(raw[4]!),
    v: parseFloat(raw[5]!),
  }
}

/**
 * Fetch Bybit candles for one coin/interval window.
 * - Calls acquire() before each API request (rate limiter).
 * - retCode !== 0: treated as Bybit API error — retry up to maxRetries.
 * - Timeout / network error: retry with backoff.
 * - Empty result.list: return [].
 * - On exhausted retries: return null (caller should skip this coin/tf).
 * - Response is newest-first → reversed to ascending order before return.
 */
export async function fetchBybitCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime?: number,
  maxRetries = 3,
): Promise<Candle[] | null> {
  const symbol = toSymbol(coin)
  const bybitInterval = BYBIT_INTERVAL_MAP[interval] as KlineIntervalV3 | undefined
  if (!bybitInterval) {
    log.warn('bybit-backfill', `${coin} ${interval}: no interval mapping — skipping`)
    return null
  }

  let attempt = 0
  let rateLimitHits = 0
  const MAX_RATE_LIMIT_RETRIES = 10

  while (attempt <= maxRetries) {
    try {
      await acquireFn()
      const response = await client.getKline({
        category: 'linear',
        symbol,
        interval: bybitInterval,
        start: startTime,
        ...(endTime !== undefined ? { end: endTime } : {}),
        limit: BYBIT_BACKFILL_BATCH_SIZE,
      })

      // Bybit API error — retCode 0 = success
      if (response.retCode !== 0) {
        const msg = `retCode ${response.retCode}: ${response.retMsg}`
        const isRateLimit = response.retCode === 10006 || response.retMsg?.includes('rate limit')
        if (isRateLimit) {
          rateLimitHits++
          if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
            log.warn('bybit-backfill', `${coin} ${interval}: rate limited ${rateLimitHits}x — giving up`)
            return null
          }
          log.warn('bybit-backfill', `${coin} ${interval}: rate limited (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) — waiting 2s`)
          await new Promise(r => setTimeout(r, 2000))
          continue
        }

        attempt++
        if (attempt > maxRetries) {
          log.warn('bybit-backfill', `${coin} ${interval}: API error after ${maxRetries} retries — ${msg}`)
          return null
        }
        const delay = 500 * attempt
        log.warn('bybit-backfill', `${coin} ${interval}: API error (attempt ${attempt}/${maxRetries}): ${msg}`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      const list = response.result?.list
      if (!list || list.length === 0) return []

      // Bybit returns newest-first — reverse to ascending chronological order
      const candles = (list as string[][]).map(parseBybitCandle).reverse()
      return candles
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Too Many')

      if (is429) {
        rateLimitHits++
        if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
          log.warn('bybit-backfill', `${coin} ${interval}: rate limited ${rateLimitHits}x — giving up`)
          return null
        }
        log.warn('bybit-backfill', `${coin} ${interval}: rate limited (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) — waiting 2s`)
        await new Promise(r => setTimeout(r, 2000))
        continue
      }

      attempt++
      if (attempt > maxRetries) return null

      const delay = 500 * attempt
      log.warn('bybit-backfill', `${coin} ${interval}: error (attempt ${attempt}/${maxRetries}): ${msg}`)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  return null
}

/**
 * Fetch candles in batches of BYBIT_BACKFILL_BATCH_SIZE to handle large requests.
 * Walks forward from startTime, merging results. Stops early if a batch returns empty.
 * Returns null only if the first batch fails (coin/TF unavailable).
 */
export async function fetchBybitCandlesBatched(
  coin: string,
  interval: CandleInterval,
  totalCount: number,
): Promise<Candle[] | null> {
  if (totalCount <= BYBIT_BACKFILL_BATCH_SIZE) {
    const startTime = Date.now() - totalCount * INTERVAL_MS[interval]
    return fetchBybitCandles(coin, interval, startTime)
  }

  const all: Candle[] = []
  const now = Date.now()
  const fullStartTime = now - totalCount * INTERVAL_MS[interval]
  const batchDuration = BYBIT_BACKFILL_BATCH_SIZE * INTERVAL_MS[interval]
  const batches = Math.ceil(totalCount / BYBIT_BACKFILL_BATCH_SIZE)

  for (let i = 0; i < batches; i++) {
    const batchStart = fullStartTime + i * batchDuration
    const batchEnd = Math.min(batchStart + batchDuration, now)

    const candles = await fetchBybitCandles(coin, interval, batchStart, batchEnd)

    if (candles === null) {
      if (i === 0) return null // first batch failed → coin/TF unavailable
      log.warn('bybit-backfill', `${coin} ${interval}: batch ${i + 1}/${batches} failed — using ${all.length} candles`)
      break
    }

    if (candles.length === 0) {
      if (all.length > 0) break // reached start of available history
      continue                  // coin not yet listed at this historical window — skip ahead
    }

    all.push(...candles)
  }

  // Deduplicate by timestamp (batches may overlap at boundaries)
  const seen = new Set<number>()
  const deduped: Candle[] = []
  for (const c of all) {
    if (!seen.has(c.t)) {
      seen.add(c.t)
      deduped.push(c)
    }
  }

  deduped.sort((a, b) => a.t - b.t)
  return deduped
}

/** TF priority order: small TFs first so scanner starts producing signals earlier. */
const TF_PRIORITY: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/**
 * Backfill all coins × all TFs in parallel with a concurrency cap.
 * - Small TFs first (1m before 1d) so scanner can start early.
 * - Individual failures logged + skipped, never block others.
 * - Calls onCandles for each successful coin/interval.
 * - Returns per-coin ready count.
 */
export async function backfillBybitCoins(
  coins: string[],
  onCandles: (coin: string, interval: CandleInterval, candles: Candle[]) => void,
  concurrency = 3,
  /** Optional: skip coin/TF pairs already loaded (e.g. from PG gap-fill). */
  isLoaded?: (coin: string, interval: CandleInterval) => boolean,
): Promise<BackfillResult[]> {
  // Build task list: TF-priority order within each coin
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
    log.info('bybit-backfill', `skipping ${skipped} coin/TF pairs already loaded from PG`)
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
        const task = tasks[idx++]!
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
        const totalCount = BYBIT_BACKFILL_CANDLE_COUNTS[interval] ?? 5000
        const candles = await fetchBybitCandlesBatched(coin, interval, totalCount)

        if (candles === null) {
          log.warn('bybit-backfill', `${coin} ${interval}: FAILED — skipping`)
        } else if (candles.length === 0) {
          log.info('bybit-backfill', `${coin} ${interval}: empty`)
        } else {
          onCandles(coin, interval, candles)
          readyMap.set(coin, (readyMap.get(coin) ?? 0) + 1)
          log.info('bybit-backfill', `${coin} ${interval}: ${candles.length} candles`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('bybit-backfill', `${coin} ${interval}: unexpected error — ${msg}`)
      }
    }

    next()
  })

  return coins.map(coin => ({ coin, readyTFs: readyMap.get(coin) ?? 0 }))
}
