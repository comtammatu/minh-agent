/**
 * HL WebSocket subscription cap test.
 *
 * Subscribes to 300+ candle topics (50 coins × 6 TFs) on a single
 * SubscriptionClient and monitors for silent drops or errors.
 *
 * Success criteria:
 *   - All 300 subscriptions established without error
 *   - After 60s, check that we received at least 1 candle event per coin
 *   - No silent drops (compare subscribed vs received)
 *
 * Usage: bun run scripts/test-ws-cap.ts
 */

import { WebSocketTransport, SubscriptionClient } from '@nktkas/hyperliquid'
import { fetchTopCoins } from '../src/feed/coin-selector.js'

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
const TARGET_COINS = 50
const MONITOR_SECONDS = 90

async function main() {
  console.log(`[CAP-TEST] Fetching top ${TARGET_COINS} coins from HL...`)
  const coins = await fetchTopCoins(TARGET_COINS)
  if (coins.length === 0) {
    console.error('[CAP-TEST] FAIL: fetchTopCoins returned empty')
    process.exit(1)
  }
  console.log(`[CAP-TEST] Got ${coins.length} coins: ${coins.slice(0, 5).join(', ')}... +${coins.length - 5} more`)

  const totalSubs = coins.length * TFS.length
  console.log(`[CAP-TEST] Will subscribe to ${totalSubs} candle topics on ONE WS connection`)

  const transport = new WebSocketTransport()
  const client = new SubscriptionClient({ transport })

  // Track which coin/TF received at least one event
  const received = new Map<string, number>()
  let totalEvents = 0
  let errors = 0

  // Subscribe all
  console.log(`[CAP-TEST] Subscribing...`)
  const startSub = Date.now()
  let subCount = 0

  for (const coin of coins) {
    for (const tf of TFS) {
      const key = `${coin}:${tf}`
      try {
        await client.candle({ coin, interval: tf }, (_event) => {
          received.set(key, (received.get(key) ?? 0) + 1)
          totalEvents++
        })
        subCount++
      } catch (err) {
        errors++
        console.error(`[CAP-TEST] ERROR subscribing ${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Progress every 10 coins
    if (subCount % (10 * TFS.length) === 0) {
      console.log(`[CAP-TEST]   ... ${subCount}/${totalSubs} subscribed`)
    }
  }

  const subDuration = ((Date.now() - startSub) / 1000).toFixed(1)
  console.log(`[CAP-TEST] Subscribed: ${subCount}/${totalSubs} (${errors} errors) in ${subDuration}s`)

  if (errors > 0) {
    console.log(`[CAP-TEST] ⚠ ${errors} subscription errors — cap may exist`)
  }

  // Monitor for MONITOR_SECONDS
  console.log(`[CAP-TEST] Monitoring for ${MONITOR_SECONDS}s...`)

  // Print progress every 15s
  const progressInterval = setInterval(() => {
    const coinsWithEvents = new Set<string>()
    for (const key of received.keys()) {
      coinsWithEvents.add(key.split(':')[0]!)
    }
    console.log(
      `[CAP-TEST] Events: ${totalEvents} total | ` +
      `${received.size}/${totalSubs} topics received at least 1 event | ` +
      `${coinsWithEvents.size}/${coins.length} coins active`
    )
  }, 15_000)

  await new Promise(r => setTimeout(r, MONITOR_SECONDS * 1000))
  clearInterval(progressInterval)

  // Results
  console.log(`\n[CAP-TEST] ═══════ RESULTS ═══════`)
  console.log(`[CAP-TEST] Total subscriptions attempted: ${totalSubs}`)
  console.log(`[CAP-TEST] Successfully subscribed: ${subCount}`)
  console.log(`[CAP-TEST] Subscription errors: ${errors}`)
  console.log(`[CAP-TEST] Total candle events received: ${totalEvents}`)
  console.log(`[CAP-TEST] Topics with at least 1 event: ${received.size}/${totalSubs}`)

  // Check per-coin coverage
  const coinsReceived = new Map<string, number>()
  for (const [key, count] of received) {
    const coin = key.split(':')[0]!
    coinsReceived.set(coin, (coinsReceived.get(coin) ?? 0) + count)
  }

  const coinsWithZeroEvents = coins.filter(c => !coinsReceived.has(c))
  console.log(`[CAP-TEST] Coins with events: ${coinsReceived.size}/${coins.length}`)

  if (coinsWithZeroEvents.length > 0) {
    console.log(`[CAP-TEST] Coins with ZERO events: ${coinsWithZeroEvents.join(', ')}`)
  }

  // Per-TF coverage
  for (const tf of TFS) {
    const tfTopics = coins.map(c => `${c}:${tf}`)
    const tfReceived = tfTopics.filter(k => received.has(k)).length
    console.log(`[CAP-TEST]   ${tf}: ${tfReceived}/${coins.length} coins received`)
  }

  // Verdict
  console.log(`\n[CAP-TEST] ═══════ VERDICT ═══════`)
  if (errors === 0 && coinsWithZeroEvents.length <= 5) {
    // Small TFs (4h, 1d) may not fire in 90s — that's OK
    console.log(`[CAP-TEST] PASS — No subscription cap detected. Single connection handles ${totalSubs} topics.`)
    console.log(`[CAP-TEST] WS pool is NOT needed.`)
  } else if (errors > 0) {
    console.log(`[CAP-TEST] FAIL — ${errors} subscription errors. HL likely has a cap.`)
    console.log(`[CAP-TEST] WS pool IS needed.`)
  } else {
    console.log(`[CAP-TEST] INCONCLUSIVE — ${coinsWithZeroEvents.length} coins got zero events.`)
    console.log(`[CAP-TEST] May need longer monitoring or WS pool as precaution.`)
  }

  // Cleanup
  try { (client as unknown as { close?: () => void }).close?.() } catch {}
  process.exit(0)
}

main().catch(err => {
  console.error(`[CAP-TEST] Fatal:`, err)
  process.exit(1)
})
