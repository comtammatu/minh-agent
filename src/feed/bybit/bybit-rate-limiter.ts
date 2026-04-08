/**
 * Bybit REST rate limiter — token bucket.
 * Bybit market data (public): 120 req/10s per IP.
 * Budget: 120 burst tokens, refill 1/100ms (10/s sustained).
 *
 * JS single-threaded guarantee: all code before `await` runs atomically,
 * so concurrent callers naturally serialize through the token counter
 * and queue without races.
 */

import { BYBIT_REST_BURST_TOKENS, BYBIT_REST_REFILL_MS } from '../../config.js'

let tokens = BYBIT_REST_BURST_TOKENS
let lastRefillAt = Date.now()

/** Next available queue slot (ms). Used after burst exhaustion. */
let nextSlotTime = 0

/**
 * Acquire a slot before making a REST request.
 * - If burst tokens available: returns immediately (no await).
 * - Otherwise: queues with even spacing (1 req per BYBIT_REST_REFILL_MS).
 */
export async function acquire(): Promise<void> {
  // Refill tokens based on elapsed time (1 token per BYBIT_REST_REFILL_MS)
  const now = Date.now()
  const elapsed = now - lastRefillAt
  tokens = Math.min(BYBIT_REST_BURST_TOKENS, tokens + elapsed / BYBIT_REST_REFILL_MS)
  lastRefillAt = now

  if (tokens >= 1) {
    tokens -= 1
    return
  }

  // Burst exhausted — enter even-spacing queue
  if (now >= nextSlotTime) {
    nextSlotTime = now + BYBIT_REST_REFILL_MS
    return
  }

  // Queue behind other waiters
  const waitUntil = nextSlotTime
  nextSlotTime = waitUntil + BYBIT_REST_REFILL_MS
  await new Promise(r => setTimeout(r, waitUntil - now))
}
