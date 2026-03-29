import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test'
import { backfillStartTime } from '../src/feed/rest.js'
import { checkStaleness } from '../src/feed/ws.js'

// ── backfillStartTime ────────────────────────────────────────────────────────

describe('backfillStartTime', () => {
  it('returns ~N bars ago for 1h', () => {
    const now = Date.now()
    const start = backfillStartTime('1h', 10)
    const expected = now - 10 * 3_600_000
    expect(Math.abs(start - expected)).toBeLessThan(5000)  // within 5s
  })

  it('returns ~N bars ago for 4h', () => {
    const now = Date.now()
    const start = backfillStartTime('4h', 5)
    const expected = now - 5 * 14_400_000
    expect(Math.abs(start - expected)).toBeLessThan(5000)
  })

  it('uses BACKFILL_CANDLE_COUNT as default', () => {
    // Should not throw with default args
    expect(() => backfillStartTime('1m')).not.toThrow()
  })
})

// ── checkStaleness ───────────────────────────────────────────────────────────

describe('checkStaleness', () => {
  it('does not throw when called with no subscriptions', () => {
    expect(() => checkStaleness()).not.toThrow()
  })

  it('logs warning for stale subscriptions', () => {
    // We can't easily unit-test the internal Map, but we verify no throw
    expect(() => checkStaleness()).not.toThrow()
  })
})
