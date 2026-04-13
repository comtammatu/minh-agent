/**
 * L2 Order Book feed — WS subscription with staleness watchdog.
 *
 * Subscribes to HL l2Book stream per coin.
 * Caps depth at BOOK_DEPTH_LEVELS (top 20 each side).
 * Computes bid/ask imbalance on every update.
 * Logs WARNING if no update received within BOOK_STALENESS_MS.
 */

import type { ISubscription } from '@nktkas/hyperliquid'
import { getWsClient, registerSubscription, removeSubscription } from './ws.js'
import { bidAskImbalance } from '../indicators/order-flow.js'
import { BOOK_DEPTH_LEVELS, BOOK_STALENESS_MS } from '../config.js'
import type { OrderBookSnapshot } from '../types.js'
import { log } from '../lib/logger.js'

// coin → latest snapshot
const bookStore = new Map<string, OrderBookSnapshot>()

// coin → last update timestamp (for staleness watchdog)
const lastBookTime = new Map<string, number>()

// Per-coin subscription tracking for selective unsubscribe
const bookSubs = new Map<string, ISubscription>()

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
      const bids: [number, number][] = []
      for (const level of rawBids.slice(0, BOOK_DEPTH_LEVELS)) {
        const px = parseFloat(level.px)
        const sz = parseFloat(level.sz)
        if (!isNaN(px) && !isNaN(sz)) bids.push([px, sz])
      }

      const asks: [number, number][] = []
      for (const level of rawAsks.slice(0, BOOK_DEPTH_LEVELS)) {
        const px = parseFloat(level.px)
        const sz = parseFloat(level.sz)
        if (!isNaN(px) && !isNaN(sz)) asks.push([px, sz])
      }

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
      log.error('orderbook', `${coin}: parse error — ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  bookSubs.set(coin, sub)
  registerSubscription(sub)
}

/** Unsubscribe order book stream for a specific coin and clear its state. */
export async function unsubscribeOrderBook(coin: string): Promise<void> {
  const sub = bookSubs.get(coin)
  if (sub) {
    try { await sub.unsubscribe() } catch { /* ignore */ }
    removeSubscription(sub)
    bookSubs.delete(coin)
  }
  bookStore.delete(coin)
  lastBookTime.delete(coin)
}

// ── Exchange-agnostic write API (used by Bybit feed) ─────────────────────────

/** Write a book snapshot from an external feed (e.g. Bybit ticker bid1/ask1). */
export function writeBook(coin: string, snapshot: OrderBookSnapshot): void {
  bookStore.set(coin, snapshot)
  lastBookTime.set(coin, Date.now())
}

/** Remove book state for a coin (used by Bybit unsubscribe). */
export function removeBook(coin: string): void {
  bookStore.delete(coin)
  lastBookTime.delete(coin)
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
      log.warn('orderbook', `${coin} book: stale ${Math.round(silent / 1000)}s — no L2 update`)
    }
  }
}
