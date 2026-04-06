/**
 * Trades stream feed — WS trades aggregated into delta per bar.
 *
 * Subscribes to HL trades stream per coin.
 * Aggregates raw trades into DeltaState (buyVol, sellVol, delta).
 * Does NOT store raw trades — only running delta per coin.
 *
 * Side mapping (HL convention):
 *   "B" = buyer aggressor → buy volume
 *   "A" = seller aggressor → sell volume
 */

import type { ISubscription } from '@nktkas/hyperliquid'
import { getWsClient, registerSubscription, removeSubscription } from './ws.js'
import { computeDelta } from '../indicators/order-flow.js'
import type { DeltaState } from '../types.js'
import { log } from '../lib/logger.js'

// coin → current accumulated delta state
const deltaStore = new Map<string, DeltaState>()

// Per-coin subscription tracking for selective unsubscribe
const tradeSubs = new Map<string, ISubscription>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Get latest accumulated delta for a coin, or null if not yet subscribed. */
export function getLatestDelta(coin: string): DeltaState | null {
  return deltaStore.get(coin) ?? null
}

/** Reset delta accumulator for a coin (call after pipeline processes a bar). */
export function resetDelta(coin: string): void {
  const existing = deltaStore.get(coin)
  if (!existing) return
  deltaStore.set(coin, {
    delta: 0,
    cumDelta: existing.cumDelta,  // preserve cumulative
    buyVol: 0,
    sellVol: 0,
    barTs: Date.now(),
  })
}

/**
 * Subscribe to trades stream for a coin.
 * Aggregates each batch of trades into the running DeltaState.
 */
export async function subscribeTrades(coin: string): Promise<void> {
  const client = getWsClient()

  // Init delta state
  deltaStore.set(coin, {
    delta: 0,
    cumDelta: 0,
    buyVol: 0,
    sellVol: 0,
    barTs: Date.now(),
  })

  const sub = await client.trades({ coin }, (events) => {
    try {
      // events is an array of trade records
      const raw = events.map(e => ({
        side: e.side as 'A' | 'B',
        size: parseFloat(e.sz),
      })).filter(t => !isNaN(t.size) && t.size > 0)

      if (raw.length === 0) return

      const { delta, buyVol, sellVol } = computeDelta(raw)

      const prev = deltaStore.get(coin) ?? { delta: 0, cumDelta: 0, buyVol: 0, sellVol: 0, barTs: Date.now() }
      const newBuyVol = prev.buyVol + buyVol
      const newSellVol = prev.sellVol + sellVol
      const newDelta = newBuyVol - newSellVol

      deltaStore.set(coin, {
        delta: newDelta,
        cumDelta: prev.cumDelta + delta,
        buyVol: newBuyVol,
        sellVol: newSellVol,
        barTs: prev.barTs,
      })
    } catch (err) {
      log.error('trades', `${coin}: parse error — ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  tradeSubs.set(coin, sub)
  registerSubscription(sub)
}

/** Unsubscribe trades stream for a specific coin and clear its delta state. */
export async function unsubscribeTrades(coin: string): Promise<void> {
  const sub = tradeSubs.get(coin)
  if (sub) {
    try { await sub.unsubscribe() } catch { /* ignore */ }
    removeSubscription(sub)
    tradeSubs.delete(coin)
  }
  deltaStore.delete(coin)
}
