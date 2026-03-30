/**
 * Token-bucket rate limiter for HL REST API.
 *
 * HL weight budget: 1200/min. Info requests cost weight 20+.
 * candleSnapshot has extra per-item surcharge.
 *
 * Strategy:
 *   - Burst phase: first ~45 requests pass immediately (startup backfill)
 *   - Sustained phase: even-spaced queue at ~1 req/1.2s
 *   - Tokens refill at 1 per REFILL_MS so burst recovers over time
 *
 * JS single-threaded guarantee: all code before `await` runs atomically,
 * so concurrent callers naturally serialize through the token counter
 * and queue without races.
 */

import { REST_BURST_TOKENS, REST_REFILL_MS } from '../config.js'

let tokens = REST_BURST_TOKENS
let lastRefillAt = Date.now()

/** Next available queue slot (ms). Used after burst exhaustion. */
let nextSlotTime = 0

/**
 * Acquire a slot before making a REST request.
 * - If burst tokens available: returns immediately (no await).
 * - Otherwise: queues with even spacing (1 req per REFILL_MS).
 */
export async function acquire(): Promise<void> {
  // Refill tokens based on elapsed time (1 token per REFILL_MS)
  const now = Date.now()
  const elapsed = now - lastRefillAt
  tokens = Math.min(REST_BURST_TOKENS, tokens + elapsed / REST_REFILL_MS)
  lastRefillAt = now

  if (tokens >= 1) {
    tokens -= 1
    return
  }

  // Burst exhausted — enter even-spacing queue
  if (now >= nextSlotTime) {
    nextSlotTime = now + REST_REFILL_MS
    return
  }

  // Queue behind other waiters
  const waitUntil = nextSlotTime
  nextSlotTime = waitUntil + REST_REFILL_MS
  await new Promise(r => setTimeout(r, waitUntil - now))
}
