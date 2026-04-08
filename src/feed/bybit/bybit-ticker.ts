/**
 * Bybit ticker feed — WS `tickers.{symbol}` (linear/inverse).
 *
 * Single subscription per coin delivers real-time:
 *   - markPrice     → AssetCtxSnapshot.markPrice
 *   - indexPrice    → AssetCtxSnapshot.oraclePrice (equivalent to HL oraclePx)
 *   - openInterest  → AssetCtxSnapshot.openInterest
 *   - fundingRate   → AssetCtxSnapshot.funding + FundingSnapshot
 *   - bid1Price/bid1Size/ask1Price/ask1Size → simplified OrderBookSnapshot (1-level imbalance)
 *
 * Protocol: Bybit sends a full snapshot first, then delta messages with only changed fields.
 * We maintain per-coin state and merge deltas into it.
 *
 * Writes into the shared stores (asset-ctx, funding, orderbook) so pipeline.ts
 * getOiDelta / hasDivergence / getLatestFunding / getLatestBook work for BB coins.
 */

import { WebsocketClient } from 'bybit-api'
import { writeAssetCtx, removeAssetCtx } from '../asset-ctx.js'
import { writeFunding, removeFunding } from '../funding.js'
import { writeBook, removeBook } from '../orderbook.js'
import type { AssetCtxSnapshot, FundingSnapshot, OrderBookSnapshot } from '../../types.js'
import { log } from '../../lib/logger.js'

// ─── Internal ticker state (snapshot+delta merge) ────────────────────────────

interface TickerState {
  markPrice: number
  indexPrice: number
  openInterest: number    // in base coin (contracts)
  openInterestValue: number  // in USDT
  fundingRate: number
  bid1Price: number
  bid1Size: number
  ask1Price: number
  ask1Size: number
}

// coin → merged ticker state
const tickerStore = new Map<string, TickerState>()

// coin → symbol for unsubscribe
const activeSubs = new Map<string, string>()

let wsClient: WebsocketClient | null = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSymbol(coin: string): string {
  return `${coin}USDT`
}

/** Merge a partial ticker delta into the existing state. Ignores empty string fields. */
function mergeDelta(state: TickerState, delta: Partial<Record<string, string>>): TickerState {
  const n = (key: string, fallback: number): number => {
    const v = delta[key]
    if (v === undefined || v === '') return fallback
    const parsed = parseFloat(v)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    markPrice:          n('markPrice', state.markPrice),
    indexPrice:         n('indexPrice', state.indexPrice),
    openInterest:       n('openInterest', state.openInterest),
    openInterestValue:  n('openInterestValue', state.openInterestValue),
    fundingRate:        n('fundingRate', state.fundingRate),
    bid1Price:          n('bid1Price', state.bid1Price),
    bid1Size:           n('bid1Size', state.bid1Size),
    ask1Price:          n('ask1Price', state.ask1Price),
    ask1Size:           n('ask1Size', state.ask1Size),
  }
}

/** Push merged ticker state into the shared stores. */
function flushToStores(coin: string, state: TickerState): void {
  const now = Date.now()

  // Asset context (mark/oracle/OI/funding)
  const assetCtx: AssetCtxSnapshot = {
    coin,
    markPrice:    state.markPrice,
    oraclePrice:  state.indexPrice,   // Bybit indexPrice ≈ HL oraclePx
    openInterest: state.openInterestValue > 0 ? state.openInterestValue : state.openInterest,
    funding:      state.fundingRate,
    premium:      state.markPrice > 0 && state.indexPrice > 0
      ? (state.markPrice - state.indexPrice) / state.indexPrice
      : 0,
    timestamp: now,
  }
  // Only write if we have meaningful data
  if (assetCtx.markPrice > 0) {
    writeAssetCtx(coin, assetCtx)
  }

  // Funding snapshot
  if (Number.isFinite(state.fundingRate)) {
    const funding: FundingSnapshot = {
      coin,
      rate:      state.fundingRate,
      premium:   assetCtx.premium,
      timestamp: now,
    }
    writeFunding(coin, funding)
  }

  // Simplified orderbook (1-level bid/ask imbalance)
  if (state.bid1Price > 0 && state.ask1Price > 0) {
    const totalSize = state.bid1Size + state.ask1Size
    const imbalance = totalSize > 0 ? (state.bid1Size - state.ask1Size) / totalSize : 0
    const book: OrderBookSnapshot = {
      coin,
      bids:      [[state.bid1Price, state.bid1Size]],
      asks:      [[state.ask1Price, state.ask1Size]],
      imbalance,
      timestamp: now,
    }
    writeBook(coin, book)
  }
}

// ─── WS client ───────────────────────────────────────────────────────────────

function getClient(): WebsocketClient {
  if (!wsClient) {
    wsClient = new WebsocketClient({ market: 'v5', testnet: false })

    wsClient.on('update', (data: { topic?: string; type?: string; data?: Record<string, string> }) => {
      const topic = data.topic
      if (!topic?.startsWith('tickers.')) return

      const symbol = topic.slice('tickers.'.length)   // e.g. BTCUSDT
      const coin = symbol.replace('USDT', '')

      if (!activeSubs.has(coin)) return

      try {
        const raw = data.data
        if (!raw) return

        const existing = tickerStore.get(coin)

        if (data.type === 'snapshot' || !existing) {
          // Full snapshot — parse all fields
          const state: TickerState = {
            markPrice:         parseFloat(raw['markPrice'] ?? '0') || 0,
            indexPrice:        parseFloat(raw['indexPrice'] ?? '0') || 0,
            openInterest:      parseFloat(raw['openInterest'] ?? '0') || 0,
            openInterestValue: parseFloat(raw['openInterestValue'] ?? '0') || 0,
            fundingRate:       parseFloat(raw['fundingRate'] ?? '0') || 0,
            bid1Price:         parseFloat(raw['bid1Price'] ?? '0') || 0,
            bid1Size:          parseFloat(raw['bid1Size'] ?? '0') || 0,
            ask1Price:         parseFloat(raw['ask1Price'] ?? '0') || 0,
            ask1Size:          parseFloat(raw['ask1Size'] ?? '0') || 0,
          }
          tickerStore.set(coin, state)
          flushToStores(coin, state)
        } else {
          // Delta — merge changed fields only
          const merged = mergeDelta(existing, raw)
          tickerStore.set(coin, merged)
          flushToStores(coin, merged)
        }
      } catch (err) {
        log.error('bybit-ticker', `${coin}: parse error — ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    wsClient.on('exception', (err: unknown) => {
      log.warn('bybit-ticker', `WS exception: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return wsClient
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Subscribe to ticker stream for a coin.
 * Populates assetCtx, funding, and orderbook stores on every update.
 */
export function subscribeBybitTicker(coin: string): void {
  if (activeSubs.has(coin)) return

  const symbol = toSymbol(coin)
  activeSubs.set(coin, symbol)

  const client = getClient()
  client.subscribeV5([`tickers.${symbol}`], 'linear')
  log.info('bybit-ticker', `${coin}: subscribed tickers.${symbol}`)
}

/**
 * Unsubscribe ticker stream for a coin and clear its stores.
 */
export function unsubscribeBybitTicker(coin: string): void {
  const symbol = activeSubs.get(coin)
  if (!symbol) return

  wsClient?.unsubscribeV5([`tickers.${symbol}`], 'linear')
  activeSubs.delete(coin)
  tickerStore.delete(coin)
  removeAssetCtx(coin)
  removeFunding(coin)
  removeBook(coin)
  log.info('bybit-ticker', `${coin}: unsubscribed`)
}

/** Close all Bybit ticker subscriptions (call on SIGINT). */
export function closeAllBybitTicker(): void {
  if (wsClient) {
    try { wsClient.closeAll() } catch { /* ignore */ }
    wsClient = null
  }
  activeSubs.clear()
  tickerStore.clear()
}
