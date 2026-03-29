/**
 * Minh (明) — entry point.
 *
 * Startup sequence:
 *   1. Fetch HL universe meta → cache tickSizes (unused in Sprint 1, reserved)
 *   2. For each coin × TF:
 *      a. WS subscribe FIRST (candles during backfill arrive via upsert)
 *      b. REST backfill (sequential, ~9s total)
 *   3. Print "Ready" + candle counts
 *   4. setInterval: STATUS line every 60s
 *   5. setInterval: staleness check every 30s
 *   6. SIGINT: close all WS → log → process.exit(0)
 */

import {
  COINS,
  TIMEFRAMES,
  STALENESS_CHECK_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  REGIME_MULTIPLIERS,
} from './config.js'
import { fetchCandles, backfillStartTime } from './feed/rest.js'
import { setCandles, candleCount } from './feed/store.js'
import { subscribeCandles, closeAll, checkStaleness } from './feed/ws.js'
import { startFundingPolling, stopFundingPolling } from './feed/funding.js'
import { subscribeTrades } from './feed/trades.js'
import { subscribeOrderBook, checkBookStaleness } from './feed/orderbook.js'
import { onCandleTick, getStatus } from './scanner/pipeline.js'
import type { CandleInterval } from './types.js'

// ── Banner ───────────────────────────────────────────────────────────────────

console.log(`[${ts()}] Minh (明) v1.0.0 — Layered Decision Framework`)
console.log(
  `[${ts()}] Config: ${COINS.join(',')} × ${TIMEFRAMES.join(',')} | ` +
  `min:${MIN_CONFIDENCE} | confluence:${CONFLUENCE_MIN}+ | ` +
  `regime:${REGIME_MULTIPLIERS.aligned}/${REGIME_MULTIPLIERS.neutral}/${REGIME_MULTIPLIERS.counter}`,
)

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // WS subscribe first (before backfill) to capture any candles during backfill
  for (const coin of COINS) {
    for (const tf of TIMEFRAMES) {
      await subscribeCandles(coin, tf as CandleInterval, onCandleTick)
    }
    // Phase B: trades + order book per coin
    await subscribeTrades(coin)
    await subscribeOrderBook(coin)
  }

  // REST backfill (sequential — ~9s)
  const tfReady = new Map<string, number>()  // coin → count of TFs loaded

  for (const coin of COINS) {
    tfReady.set(coin, 0)
    for (const tf of TIMEFRAMES) {
      const interval = tf as CandleInterval
      const startTime = backfillStartTime(interval)
      const candles = await fetchCandles(coin, interval, startTime)

      if (candles === null) {
        console.log(`[${ts()}] BACKFILL | ${coin} ${tf}: FAILED — skipping`)
      } else if (candles.length === 0) {
        console.log(`[${ts()}] BACKFILL | ${coin} ${tf}: empty`)
      } else {
        setCandles(coin, interval, candles)
        tfReady.set(coin, (tfReady.get(coin) ?? 0) + 1)
        console.log(`[${ts()}] BACKFILL | ${coin} ${tf}: ${candles.length} candles`)
      }
    }
  }

  // Phase B: funding rate polling (initial fetch + 60s interval)
  await startFundingPolling([...COINS])

  // ARMED readiness gate
  const armedParts = COINS.map(coin => {
    const ready = tfReady.get(coin) ?? 0
    return `${coin}: ${ready}/${TIMEFRAMES.length} TFs ready`
  })
  console.log(`[${ts()}] ARMED | ${armedParts.join(' | ')}`)

  // STATUS interval — per-coin compact aggregate
  setInterval(() => {
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
        // Keep highest-TF regime (last snapshot per coin = highest TF due to iteration order)
        prev.regime = s.regime
        if (s.confluenceGrade) {
          prev.grade = `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}`
        }
      }
    }

    const parts = COINS.map(coin => {
      const info = byCoin.get(coin)
      if (!info) return `${coin} — 0`
      return `${coin} ${info.regime} ${info.grade} ${info.setups}setup`
    })
    console.log(`[${ts()}] STATUS | ${parts.join(' | ')}`)
  }, STATUS_INTERVAL_MS)

  // Staleness watchdog (candles + order book)
  setInterval(() => {
    checkStaleness()
    checkBookStaleness()
  }, STALENESS_CHECK_INTERVAL_MS)

  // SIGINT handler
  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing WebSocket connections...')
    stopFundingPolling()
    await closeAll()
    console.log('[SHUTDOWN] Minh stopped gracefully.')
    process.exit(0)
  })
}

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

main().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
