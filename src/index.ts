/**
 * Minh (明) — entry point.
 *
 * Startup sequence:
 *   1. CoinSelector: fetch top coins from HL by OI
 *   2. For each tracked coin:
 *      a. WS subscribe (candles × 6 TFs + trades + order book)
 *      b. REST backfill (sequential per coin)
 *   3. Start funding polling
 *   4. Print ARMED + coin counts
 *   5. Start coin refresh loop (1h interval)
 *   6. setInterval: STATUS line every 60s
 *   7. setInterval: staleness check every 30s
 *   8. SIGINT: stop refresh → close WS → log → exit
 */

import {
  TIMEFRAMES,
  STALENESS_CHECK_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  REGIME_MULTIPLIERS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_BACKOFF,
} from './config.js'
import { backfillAllCoins } from './feed/rest.js'
import { setCandles, clearCoinData } from './feed/store.js'
import { subscribeCandles, unsubscribeCandles, closeAll, checkStaleness } from './feed/ws.js'
import { startFundingPolling, stopFundingPolling, addFundingCoin, removeFundingCoin } from './feed/funding.js'
import { subscribeTrades, unsubscribeTrades } from './feed/trades.js'
import { subscribeOrderBook, unsubscribeOrderBook, checkBookStaleness } from './feed/orderbook.js'
import { createCoinSelector } from './feed/coin-selector.js'
import type { RefreshResult } from './feed/coin-selector.js'
import { onCandleTick, getStatus, getActiveSetupCoins, clearCoinState } from './scanner/pipeline.js'
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
  // 1. Fetch top coins from HL — fatal if empty at startup (spec requirement)
  const initialResult = await selector.refresh()
  const coins = selector.getTrackedCoins()

  if (coins.length === 0) {
    throw new Error('fetchTopCoins returned empty at startup — cannot proceed without coin list')
  }

  console.log(`[${ts()}] COINS | ${coins.length} coins selected (${initialResult.added.length} from HL)`)

  // 2. Subscribe all coins (WS first, before backfill — captures candles during backfill)
  for (const coin of coins) {
    await subscribeCoin(coin)
  }

  // 3. REST backfill all coins (parallel with concurrency cap)
  const backfillResults = await backfillAllCoins(coins, (coin, interval, candles) => {
    setCandles(coin, interval, candles)
  })
  const tfReady = new Map<string, number>()
  for (const r of backfillResults) tfReady.set(r.coin, r.readyTFs)

  // 4. Start funding polling for all coins
  await startFundingPolling(coins)

  // 5. ARMED readiness gate
  const fullyReady = coins.filter(c => (tfReady.get(c) ?? 0) === TIMEFRAMES.length).length
  const partialReady = coins.filter(c => {
    const r = tfReady.get(c) ?? 0
    return r > 0 && r < TIMEFRAMES.length
  }).length
  console.log(
    `[${ts()}] ARMED | ${coins.length} coins: ${fullyReady} fully ready, ${partialReady} partial | ${TIMEFRAMES.length} TFs`,
  )

  // 6. Start coin refresh loop
  selector.startRefreshLoop()

  // 7. STATUS interval — per-coin compact aggregate
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

  // 8. Staleness watchdog (candles + order book)
  activeIntervals.push(setInterval(() => {
    checkStaleness()
    checkBookStaleness()
  }, STALENESS_CHECK_INTERVAL_MS))

  // Keep alive — resolve when WS dies (detected via staleness or thrown error)
  await new Promise(() => {
    // intentionally never resolves — process stays alive via setIntervals
  })
}

/** Clean up intervals, WS connections, refresh loop, and polling before reconnect. */
async function cleanup(): Promise<void> {
  selector.stopRefreshLoop()
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals.length = 0
  stopFundingPolling()
  await closeAll()
}

/** Run main() with exponential backoff reconnection on failure. */
async function runWithReconnect(): Promise<never> {
  let delay = WS_RECONNECT_INITIAL_MS

  // SIGINT handler — register once, outside retry loop
  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing WebSocket connections...')
    await cleanup()
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
