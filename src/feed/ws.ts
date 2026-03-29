/**
 * HL WebSocket candle subscription.
 * Uses SubscriptionClient for per-coin/TF candle streams.
 * Staleness watchdog: setInterval checks lastCandleTime map every 30s.
 */

import { WebSocketTransport, SubscriptionClient } from '@nktkas/hyperliquid'
import type { ISubscription } from '@nktkas/hyperliquid'
import type { Candle, CandleInterval } from '../types.js'
import { STALENESS_THRESHOLD_MS } from '../config.js'

// Module-level WS client (one process, one WS connection)
let wsClient: SubscriptionClient | null = null
const activeSubscriptions: ISubscription[] = []

// lastCandleTime: key = "BTC:4h", value = Date.now() at last received candle
const lastCandleTime = new Map<string, number>()

function getClient(): SubscriptionClient {
  if (!wsClient) {
    const transport = new WebSocketTransport()
    wsClient = new SubscriptionClient({ transport })
  }
  return wsClient
}

/** Get shared WS client — used by trades.ts and orderbook.ts feeds. */
export function getWsClient(): SubscriptionClient {
  return getClient()
}

/** Register a subscription for centralized cleanup on closeAll(). */
export function registerSubscription(sub: ISubscription): void {
  activeSubscriptions.push(sub)
}

function parseCandle(raw: {
  t: number; o: string; h: string; l: string; c: string; v: string
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
 * Subscribe to candle stream for coin/interval.
 * Calls onCandle on every tick. Stores subscription for shutdown cleanup.
 */
export async function subscribeCandles(
  coin: string,
  interval: CandleInterval,
  onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
): Promise<void> {
  const client = getClient()
  const k = `${coin}:${interval}`

  const sub = await client.candle({ coin, interval }, (event) => {
    try {
      const candle = parseCandle(event)
      lastCandleTime.set(k, Date.now())
      onCandle(coin, interval, candle)
    } catch (err) {
      console.log(`[WS] ${k}: parse error — ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  activeSubscriptions.push(sub)
  lastCandleTime.set(k, Date.now())
}

/** Close all active WS subscriptions (call on SIGINT). */
export async function closeAll(): Promise<void> {
  for (const sub of activeSubscriptions) {
    try { await sub.unsubscribe() } catch { /* ignore */ }
  }
  activeSubscriptions.length = 0
  if (wsClient) {
    try { (wsClient as unknown as { close?: () => void }).close?.() } catch { /* ignore */ }
    wsClient = null
  }
}

/**
 * Check all subscriptions for staleness.
 * Logs WARNING for any coin/tf silent for > STALENESS_THRESHOLD_MS.
 * Called by setInterval in index.ts.
 */
export function checkStaleness(): void {
  const now = Date.now()
  for (const [k, lastTime] of lastCandleTime) {
    const silent = now - lastTime
    if (silent > STALENESS_THRESHOLD_MS) {
      console.log(`[WARNING] ${k}: stale ${Math.round(silent / 1000)}s — no candle update`)
    }
  }
}
