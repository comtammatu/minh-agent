/**
 * Order book feed tests — snapshot storage, depth cap, staleness.
 *
 * Tests focus on observable behavior: getLatestBook, checkBookStaleness.
 * WS subscription is not triggered in unit tests.
 */

import { describe, it, expect } from 'bun:test'
import { getLatestBook, checkBookStaleness } from '../../src/feed/orderbook.js'
import { bidAskImbalance } from '../../src/indicators/order-flow.js'

// ── getLatestBook ────────────────────────────────────────────────────────────

describe('getLatestBook', () => {
  it('returns null for coin not yet subscribed', () => {
    expect(getLatestBook('UNKNOWN_COIN_XYZ')).toBeNull()
  })

  it('returns null before any subscription', () => {
    expect(getLatestBook('NOT_SUBSCRIBED')).toBeNull()
  })
})

// ── checkBookStaleness ───────────────────────────────────────────────────────

describe('checkBookStaleness', () => {
  it('does not throw when called with no subscriptions', () => {
    expect(() => checkBookStaleness()).not.toThrow()
  })

  it('is safe to call repeatedly', () => {
    expect(() => {
      checkBookStaleness()
      checkBookStaleness()
    }).not.toThrow()
  })
})

// ── Depth cap logic (tested via bidAskImbalance) ─────────────────────────────

describe('depth cap logic', () => {
  it('imbalance calculation works with capped levels', () => {
    // Simulate what orderbook.ts does: top 20 levels only
    const bids: [number, number][] = Array.from({ length: 25 }, (_, i) => [100 - i, 10])
    const asks: [number, number][] = Array.from({ length: 25 }, (_, i) => [101 + i, 10])

    const capped_bids = bids.slice(0, 20)
    const capped_asks = asks.slice(0, 20)

    const imbalance = bidAskImbalance(capped_bids, capped_asks)
    // Equal volumes → 0 imbalance
    expect(imbalance).toBe(0)
  })

  it('bid-heavy after cap gives positive imbalance', () => {
    const bids: [number, number][] = Array.from({ length: 20 }, (_, i) => [100 - i, 50])
    const asks: [number, number][] = Array.from({ length: 20 }, (_, i) => [101 + i, 10])

    const imbalance = bidAskImbalance(bids, asks)
    expect(imbalance).toBeGreaterThan(0)
  })

  it('ask-heavy after cap gives negative imbalance', () => {
    const bids: [number, number][] = Array.from({ length: 20 }, (_, i) => [100 - i, 10])
    const asks: [number, number][] = Array.from({ length: 20 }, (_, i) => [101 + i, 50])

    const imbalance = bidAskImbalance(bids, asks)
    expect(imbalance).toBeLessThan(0)
  })
})

// ── OrderBookSnapshot shape contract ─────────────────────────────────────────

describe('OrderBookSnapshot shape', () => {
  it('null returned for unsubscribed coins', () => {
    // When subscribeOrderBook(coin) is called at runtime:
    // getLatestBook returns { coin, bids, asks, imbalance, timestamp }
    // TypeScript enforces this at compile time.
    const result = getLatestBook('PHANTOM')
    expect(result).toBeNull()
  })
})
