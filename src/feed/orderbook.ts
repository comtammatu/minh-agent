/**
 * L2 Order Book feed — WS subscription with staleness watchdog.
 *
 * Subscribes to HL l2Book stream per coin.
 * Caps depth at BOOK_DEPTH_LEVELS (top 20 each side).
 * Computes bid/ask imbalance on every update.
 * Logs WARNING if no update received within BOOK_STALENESS_MS.
 */

import { getWsClient, registerSubscription } from './ws.js'
import { bidAskImbalance } from '../indicators/order-flow.js'
import { BOOK_DEPTH_LEVELS, BOOK_STALENESS_MS } from '../config.js'
import type { OrderBookSnapshot } from '../types.js'

// coin → latest snapshot
const bookStore = new Map<string, OrderBookSnapshot>()

// coin → last update timestamp (for staleness watchdog)
const lastBookTime = new Map<string, number>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Get latest order book snapshot for a coin, or null if not yet received. */
export function getLatestBook(coin: string): OrderBookSnapshot | null {
  return bookStore.get(coin) ?? null
}

/**
 * Subscribe to L2 book stream for a coin.
 * Caps depth, computes imbalance, and stores snapshot on each update.
 */
export async function subscribeOrderBook(coin: string): Promise<void> {
  const client = getWsClient()
  lastBookTime.set(coin, Date.now())

  const sub = await client.l2Book({ coin }, (event) => {
    try {
      const [rawBids, rawAsks] = event.levels

      // Cap to top BOOK_DEPTH_LEVELS
      const bids: [number, number][] = rawBids
        .slice(0, BOOK_DEPTH_LEVELS)
        .map(level => [parseFloat(level.px), parseFloat(level.sz)])
        .filter(([px, sz]) => !isNaN(px) && !isNaN(sz))

      const asks: [number, number][] = rawAsks
        .slice(0, BOOK_DEPTH_LEVELS)
        .map(level => [parseFloat(level.px), parseFloat(level.sz)])
        .filter(([px, sz]) => !isNaN(px) && !isNaN(sz))

      const imbalance = bidAskImbalance(bids, asks)

      bookStore.set(coin, {
        coin,
        bids,
        asks,
        imbalance,
        timestamp: event.time,
      })

      lastBookTime.set(coin, Date.now())
    } catch (err) {
      console.log(
        `[BOOK] ${coin}: parse error — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  registerSubscription(sub)
}

/**
 * Check all book subscriptions for staleness.
 * Logs WARNING for any coin silent for > BOOK_STALENESS_MS.
 * Call from setInterval in index.ts alongside candle staleness check.
 */
export function checkBookStaleness(): void {
  const now = Date.now()
  for (const [coin, lastTime] of lastBookTime) {
    const silent = now - lastTime
    if (silent > BOOK_STALENESS_MS) {
      console.log(`[WARNING] ${coin} book: stale ${Math.round(silent / 1000)}s — no L2 update`)
    }
  }
}
