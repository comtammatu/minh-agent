/**
 * Bybit WebSocket candle subscription.
 * Topic format: "kline.{interval}.{SYMBOL}"
 * Staleness watchdog: same pattern as ws.ts.
 *
 * Client: WebsocketClient from bybit-api (v5, linear category).
 * One global 'update' listener routes events via topicCallbacks map.
 */

import { WebsocketClient } from 'bybit-api'
import type { WSKlineEventV5 } from 'bybit-api'
import type { Candle, CandleInterval } from '../../types.js'
import { BYBIT_INTERVAL_MAP, STALENESS_THRESHOLD_MS, TIMEFRAME_MS } from '../../config.js'
import { log } from '../../lib/logger.js'

let wsClient: WebsocketClient | null = null

// lastCandleTime: key = "BB:BTC|4h", value = Date.now() at last received candle
const lastCandleTime = new Map<string, number>()

// topic → callback routing for the single global 'update' handler
const topicCallbacks = new Map<
  string,
  (coin: string, interval: CandleInterval, candle: Candle) => void
>()

// Per-coin topic tracking for selective unsubscribe
const coinTopics = new Map<string, string[]>()

function toSymbol(coin: string): string {
  return `${coin}USDT`
}

function stalenessKey(coin: string, interval: CandleInterval): string {
  return `BB:${coin}|${interval}`
}

function getClient(): WebsocketClient {
  if (!wsClient) {
    wsClient = new WebsocketClient({ market: 'v5', testnet: false })

    // Single global update handler — routes by topic string
    wsClient.on('update', (data: WSKlineEventV5) => {
      const topic: string = data.topic
      if (!topic.startsWith('kline.')) return

      const parts = topic.split('.')
      if (parts.length < 3) return
      const bybitInterval = parts[1]  // e.g. '60'
      const symbol = parts[2]         // e.g. 'BTCUSDT'
      if (!symbol) return
      const coin = symbol.replace('USDT', '')
      const interval = (
        Object.entries(BYBIT_INTERVAL_MAP) as [CandleInterval, string][]
      ).find(([, v]) => v === bybitInterval)?.[0]
      if (!interval) return

      const cb = topicCallbacks.get(topic)
      if (!cb) return

      for (const candleData of data.data) {
        // Only forward confirmed (closed) candles — same semantic as HL WS
        if (!candleData.confirm) continue
        try {
          const candle: Candle = {
            t: candleData.start,
            o: parseFloat(candleData.open),
            h: parseFloat(candleData.high),
            l: parseFloat(candleData.low),
            c: parseFloat(candleData.close),
            v: parseFloat(candleData.volume),
          }
          lastCandleTime.set(stalenessKey(coin, interval), Date.now())
          cb(coin, interval, candle)
        } catch (err) {
          log.error('bybit-ws', `parse error on ${topic}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })

    // Re-subscribe all active topics after a reconnection.
    // bybit-api auto-reconnects internally but does NOT replay subscriptions —
    // without this handler, all candle streams silently die after a WS drop.
    wsClient.on('open', () => {
      const topics = [...topicCallbacks.keys()]
      if (topics.length === 0) return
      log.info('bybit-ws', `WS reconnected — re-subscribing ${topics.length} topics`)
      wsClient!.subscribeV5(topics, 'linear')
    })

    // bybit-api v4: 'error' is deprecated; use 'exception' for error handling
    wsClient.on('exception', (err: unknown) => {
      log.error('bybit-ws', `WebSocket exception: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return wsClient
}

/**
 * Subscribe to Bybit kline stream for coin/interval.
 * Calls onCandle only on confirmed (closed) bars — same semantic as HL WS.
 * Topic format: kline.{bybitInterval}.{COIN}USDT
 */
export async function subscribeBybitCandles(
  coin: string,
  interval: CandleInterval,
  onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
): Promise<void> {
  const bybitInterval = BYBIT_INTERVAL_MAP[interval]
  const topic = `kline.${bybitInterval}.${toSymbol(coin)}`

  const client = getClient()

  // Register callback before subscribing so first event is captured
  topicCallbacks.set(topic, onCandle)

  client.subscribeV5([topic], 'linear')

  // Seed staleness timer so the first watchdog check doesn't immediately warn
  lastCandleTime.set(stalenessKey(coin, interval), Date.now())

  // Track per-coin for selective unsubscribe
  const existing = coinTopics.get(coin) ?? []
  if (!existing.includes(topic)) existing.push(topic)
  coinTopics.set(coin, existing)
}

/** Unsubscribe all Bybit kline streams for a specific coin. */
export async function unsubscribeBybitCandles(coin: string): Promise<void> {
  const topics = coinTopics.get(coin)
  if (!topics || topics.length === 0) return

  const client = wsClient
  if (client) {
    try {
      client.unsubscribeV5(topics, 'linear')
    } catch { /* ignore */ }
  }

  for (const topic of topics) {
    topicCallbacks.delete(topic)
  }
  coinTopics.delete(coin)

  // Clear staleness entries for this coin
  for (const k of lastCandleTime.keys()) {
    if (k.startsWith(`BB:${coin}|`)) lastCandleTime.delete(k)
  }
}

/** Close the Bybit WS client (call on SIGINT). */
export async function closeAllBybit(): Promise<void> {
  topicCallbacks.clear()
  coinTopics.clear()
  lastCandleTime.clear()
  if (wsClient) {
    try {
      // bybit-api WebsocketClient exposes closeAll() for graceful shutdown
      ;(wsClient as unknown as { closeAll?: () => void }).closeAll?.()
    } catch { /* ignore */ }
    wsClient = null
  }
}

/**
 * Check all Bybit subscriptions for staleness.
 * Logs WARNING for any coin/tf silent for > STALENESS_THRESHOLD_MS.
 * Called by setInterval in index.ts.
 */
export function checkBybitStaleness(): void {
  const now = Date.now()
  for (const [k, lastTime] of lastCandleTime) {
    const silent = now - lastTime
    // Per-TF threshold: one full candle duration + base buffer.
    // Prevents false positives — closed candles only arrive once per TF interval.
    const tf = k.split('|')[1] as CandleInterval
    const threshold = (TIMEFRAME_MS[tf] ?? 0) + STALENESS_THRESHOLD_MS
    if (silent > threshold) {
      log.warn('bybit-ws', `${k}: stale ${Math.round(silent / 1000)}s — no candle update`)
    }
  }
}
