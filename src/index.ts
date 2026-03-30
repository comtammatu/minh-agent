/**
 * Minh (明) — entry point.
 *
 * Startup sequence:
 *   0. Run DB migrations
 *   1. CoinSelector: fetch top coins from HL by OI
 *   2. Load candles from PG → memory, gap-fill missing via REST
 *   3. WS subscribe all coins (candles × 6 TFs + trades + order book)
 *   4. REST backfill remaining (coins not in PG get full backfill)
 *   5. Wire PG write-through for live WS candles
 *   6. Start funding + OI polling
 *   7. Print ARMED + coin counts
 *   8. Start coin refresh loop (1h interval)
 *   9. setInterval: STATUS line every 60s
 *  10. setInterval: staleness check every 30s
 *  SIGINT: stop refresh → close WS → close DB → exit
 */

import {
  TIMEFRAMES,
  TIMEFRAME_MS,
  STALENESS_CHECK_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  REGIME_MULTIPLIERS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_BACKOFF,
  BACKFILL_CANDLE_COUNTS,
  BACKFILL_CANDLE_COUNT,
} from './config.js'
import { backfillAllCoins, fetchCandles } from './feed/rest.js'
import { setCandles, clearCoinData, setOnPersist, appendCandle } from './feed/store.js'
import { subscribeCandles, unsubscribeCandles, closeAll, checkStaleness } from './feed/ws.js'
import { startFundingPolling, stopFundingPolling, addFundingCoin, removeFundingCoin } from './feed/funding.js'
import { startOiFeed, stopOiFeed, addOiCoin, removeOiCoin } from './feed/asset-ctx.js'
import { subscribeTrades, unsubscribeTrades } from './feed/trades.js'
import { subscribeOrderBook, unsubscribeOrderBook, checkBookStaleness } from './feed/orderbook.js'
import { createCoinSelector } from './feed/coin-selector.js'
import type { RefreshResult } from './feed/coin-selector.js'
import { onCandleTick, getStatus, getActiveSetupCoins, clearCoinState } from './scanner/pipeline.js'
import { sql, closeDb } from './db/connection.js'
import { runMigrations } from './db/migrate.js'
import {
  upsertCandle,
  bulkUpsertCandles,
  getAllLastTimestamps,
  loadCandles,
  computeGapStart,
  shouldGapFill,
} from './db/candle-repo.js'
import { log } from './lib/logger.js'
import { getHealthMonitor } from './agent/self-healing.js'
import type { CandleInterval } from './types.js'

// ── Banner ───────────────────────────────────────────────────────────────────

console.log(`[${ts()}] Minh (明) v1.1.0 — Dynamic Coin Selection`)
console.log(
  `[${ts()}] Config: dynamic top coins × ${TIMEFRAMES.join(',')} | ` +
  `min:${MIN_CONFIDENCE} | confluence:${CONFLUENCE_MIN}+ | ` +
  `regime:${REGIME_MULTIPLIERS.aligned}/${REGIME_MULTIPLIERS.neutral}/${REGIME_MULTIPLIERS.counter}`,
)

// ── Coin Lifecycle Helpers ──────────────────────────────────────────────────

/** Subscribe all WS feeds for a coin (candles × TFs + trades + orderbook). */
async function subscribeCoin(coin: string): Promise<void> {
  for (const tf of TIMEFRAMES) {
    await subscribeCandles(coin, tf as CandleInterval, onCandleTick)
  }
  await subscribeTrades(coin)
  await subscribeOrderBook(coin)
}

/** Backfill a single coin (used during mid-run coin additions). */
async function backfillCoin(coin: string): Promise<number> {
  const results = await backfillAllCoins([coin], (c, interval, candles) => {
    setCandles(c, interval, candles)
  })
  return results[0]?.readyTFs ?? 0
}

/** Unsubscribe all feeds + clear all state for a coin. */
async function unsubscribeCoin(coin: string): Promise<void> {
  await unsubscribeCandles(coin)
  await unsubscribeTrades(coin)
  await unsubscribeOrderBook(coin)
  removeFundingCoin(coin)
  removeOiCoin(coin)
  clearCoinData(coin)
  clearCoinState(coin)
}

// ── CoinSelector + onRefresh ────────────────────────────────────────────────

async function onCoinsRefreshed(result: RefreshResult): Promise<void> {
  // Subscribe + backfill new coins
  for (const coin of result.added) {
    console.log(`[${ts()}] COIN-ADD | ${coin} — subscribing + backfilling`)
    await subscribeCoin(coin)
    await backfillCoin(coin)
    await addFundingCoin(coin)
    addOiCoin(coin)
  }

  // Unsubscribe dropped coins (no active setup — already filtered by CoinSelector)
  for (const coin of result.dropped) {
    console.log(`[${ts()}] COIN-DROP | ${coin} — unsubscribing + clearing`)
    await unsubscribeCoin(coin)
  }
}

// Module-level selector — accessible from cleanup()
const selector = createCoinSelector(getActiveSetupCoins, onCoinsRefreshed)

// ── Main ─────────────────────────────────────────────────────────────────────

// Track intervals so we can clear them before reconnect
const activeIntervals: ReturnType<typeof setInterval>[] = []

async function main(): Promise<void> {
  // 0. Run DB migrations
  await runMigrations(sql)

  // 1. Fetch top coins from HL — fatal if empty at startup (spec requirement)
  //    skipCallback=true: main() handles initial subscribe+backfill in batch (efficient)
  //    onCoinsRefreshed is only for mid-run coin additions/removals
  const initialResult = await selector.refresh(true)
  const coins = selector.getTrackedCoins()

  if (coins.length === 0) {
    throw new Error('fetchTopCoins returned empty at startup — cannot proceed without coin list')
  }

  console.log(`[${ts()}] COINS | ${coins.length} coins selected (${initialResult.added.length} from HL)`)

  // 2. Load candles from PG → memory, then gap-fill missing candles via REST
  const pgTimestamps = await getAllLastTimestamps()
  const now = Date.now()
  let pgLoadedTotal = 0
  let gapFillTotal = 0

  for (const coin of coins) {
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval
      const storeKey = `${coin}:${interval}`
      const lastPgTs = pgTimestamps.get(storeKey) ?? null
      const intervalMs = TIMEFRAME_MS[interval]
      const fullCount = BACKFILL_CANDLE_COUNTS[interval] ?? BACKFILL_CANDLE_COUNT

      if (shouldGapFill(lastPgTs, now, intervalMs, fullCount)) {
        // Load existing candles from PG into memory
        const pgCandles = await loadCandles(coin, interval, fullCount)
        if (pgCandles.length > 0) {
          setCandles(coin, interval, pgCandles)
          pgLoadedTotal += pgCandles.length
        }

        // Gap-fill: fetch only missing candles from REST
        const gapStart = computeGapStart(lastPgTs, intervalMs)!
        const gapCandles = await fetchCandles(coin, interval, gapStart, now)
        if (gapCandles && gapCandles.length > 0) {
          // Persist gap-fill candles to PG
          await bulkUpsertCandles(coin, interval, gapCandles)
          // Merge into in-memory store (setCandles would overwrite, so append each)
          for (const c of gapCandles) {
            appendCandle(coin, interval, c)
          }
          gapFillTotal += gapCandles.length
        }
      }
      // else: no PG data → will do full REST backfill below
    }
  }

  if (pgLoadedTotal > 0 || gapFillTotal > 0) {
    log.info('startup', `PG load: ${pgLoadedTotal} candles | Gap-fill: ${gapFillTotal} candles`)
  }

  // 3. Subscribe all coins (WS first, before backfill — captures candles during backfill)
  for (const coin of coins) {
    await subscribeCoin(coin)
  }

  // 4. REST backfill all coins — skips coin/TFs already loaded from PG
  //    (setCandles replaces, so only coins with 0 candles will get full backfill)
  const backfillResults = await backfillAllCoins(coins, (coin, interval, candles) => {
    setCandles(coin, interval, candles)
    // Persist backfilled candles to PG
    bulkUpsertCandles(coin, interval, candles).catch(err => {
      log.error('persist', `bulk upsert failed ${coin}:${interval}: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
  const tfReady = new Map<string, number>()
  for (const r of backfillResults) tfReady.set(r.coin, r.readyTFs)

  // 5. Wire PG write-through for live WS candles (R14: sync write-through)
  //    Wired AFTER backfill so startup uses efficient bulk operations, not per-candle upserts
  //    S13: record health on success/error
  const health = getHealthMonitor()
  setOnPersist((coin, interval, candle) => {
    health.recordSuccess('feed')
    upsertCandle(coin, interval, candle)
      .then(() => health.recordSuccess('db'))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('persist', `upsert failed ${coin}:${interval} t=${candle.t}: ${msg}`)
        health.recordError('db', msg)
      })
  })

  // 6. Start funding + OI polling for all coins
  await startFundingPolling(coins)
  await startOiFeed(coins)

  // 7. ARMED readiness gate
  const fullyReady = coins.filter(c => (tfReady.get(c) ?? 0) === TIMEFRAMES.length).length
  const partialReady = coins.filter(c => {
    const r = tfReady.get(c) ?? 0
    return r > 0 && r < TIMEFRAMES.length
  }).length
  console.log(
    `[${ts()}] ARMED | ${coins.length} coins: ${fullyReady} fully ready, ${partialReady} partial | ${TIMEFRAMES.length} TFs`,
  )

  // 8. Start health monitor periodic check (S13: Self-Healing)
  health.startPeriodicCheck()

  // 9. Start coin refresh loop
  selector.startRefreshLoop()

  // 9. STATUS interval — per-coin compact aggregate
  activeIntervals.push(setInterval(() => {
    const trackedCoins = selector.getTrackedCoins()
    const snapshots = getStatus()
    if (snapshots.length === 0) return

    // Aggregate by coin: pick dominant regime + highest grade + sum setups
    const byCoin = new Map<string, { regime: string; grade: string; setups: number }>()
    for (const s of snapshots) {
      const prev = byCoin.get(s.coin)
      if (!prev) {
        const g = s.confluenceGrade ? `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}` : '—'
        byCoin.set(s.coin, { regime: s.regime, grade: g, setups: s.activeCount })
      } else {
        prev.setups += s.activeCount
        prev.regime = s.regime
        if (s.confluenceGrade) {
          prev.grade = `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}`
        }
      }
    }

    const parts = trackedCoins.map(coin => {
      const info = byCoin.get(coin)
      if (!info) return `${coin} — 0`
      return `${coin} ${info.regime} ${info.grade} ${info.setups} setup`
    })
    console.log(`[${ts()}] STATUS | ${trackedCoins.length} coins | ${parts.slice(0, 10).join(' | ')}${trackedCoins.length > 10 ? ` ... +${trackedCoins.length - 10} more` : ''}`)
  }, STATUS_INTERVAL_MS))

  // 10. Staleness watchdog (candles + order book)
  activeIntervals.push(setInterval(() => {
    checkStaleness()
    checkBookStaleness()
  }, STALENESS_CHECK_INTERVAL_MS))

  // Keep alive — resolve when WS dies (detected via staleness or thrown error)
  await new Promise(() => {
    // intentionally never resolves — process stays alive via setIntervals
  })
}

/** Clean up intervals, WS connections, refresh loop, polling, and DB before reconnect. */
async function cleanup(): Promise<void> {
  selector.stopRefreshLoop()
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals.length = 0
  stopFundingPolling()
  await stopOiFeed()
  await closeAll()
}

/** Run main() with exponential backoff reconnection on failure. */
async function runWithReconnect(): Promise<never> {
  let delay = WS_RECONNECT_INITIAL_MS

  // SIGINT handler — register once, outside retry loop
  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing WebSocket connections...')
    getHealthMonitor().stopPeriodicCheck()
    await cleanup()
    await closeDb()
    console.log('[SHUTDOWN] Minh stopped gracefully.')
    process.exit(0)
  })

  while (true) {
    try {
      await main()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${ts()}] CONNECTION LOST | ${msg}`)
      console.log(`[${ts()}] RECONNECT | retrying in ${Math.round(delay / 1000)}s...`)

      // Tear down everything before retry
      await cleanup()

      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * WS_RECONNECT_BACKOFF, WS_RECONNECT_MAX_MS)

      console.log(`[${ts()}] RECONNECT | restarting subscriptions + backfill...`)
    }
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

runWithReconnect()
