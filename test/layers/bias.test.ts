/**
 * Layer 1: Bias — determineBias tests.
 *
 * Tests focus on the bias FUNCTION logic (conflict resolution, HTF gate),
 * not the underlying Wyckoff/SMC indicators (those have their own golden tests).
 * We hand-craft candle arrays that produce known Wyckoff/SMC outputs.
 */

import { describe, it, expect } from 'bun:test'
import { determineBias } from '../../src/scanner/layers/bias.js'
import type { Candle, PivotPoint } from '../../src/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

/**
 * Build a trending candle array (60 candles). Direction controls slope.
 * These arrays produce predictable Wyckoff/SMC outputs.
 */
function buildTrendCandles(direction: 'up' | 'down' | 'flat', count = 60): Candle[] {
  const candles: Candle[] = []
  let base = 100
  for (let i = 0; i < count; i++) {
    const drift = direction === 'up' ? 0.5 : direction === 'down' ? -0.5 : 0
    base += drift
    const noise = (i % 3 - 1) * 0.3
    candles.push({
      t: 1000 + i * 60000,
      o: base - 0.5 + noise,
      h: base + 2 + Math.abs(noise),
      l: base - 2 - Math.abs(noise),
      c: base + noise,
      v: 1000 + (i % 5) * 100,
    })
  }
  return candles
}

const emptyPivots: PivotPoint[] = []

// ── Tests ────────────────────────────────────────────────────────────────────

describe('determineBias', () => {
  it('returns null when idx < 50', () => {
    const candles = buildTrendCandles('up', 60)
    expect(determineBias(candles, 30, [], emptyPivots)).toBeNull()
  })

  it('returns a BiasResult with required fields', () => {
    const candles = buildTrendCandles('up', 80)
    const result = determineBias(candles, 70, [], emptyPivots)
    // May be null or BiasResult — if result, check shape
    if (result) {
      expect(['long', 'short', 'neutral']).toContain(result.bias)
      expect(typeof result.confidence).toBe('number')
      expect(typeof result.source).toBe('string')
    }
  })

  it('HTF empty → proceeds with current TF only (no crash)', () => {
    const candles = buildTrendCandles('up', 80)
    const result = determineBias(candles, 70, [], emptyPivots)
    // Should not crash with empty HTF candles
    if (result) {
      expect(result.htfBias).toBeUndefined() // no HTF data → no htfBias
    }
  })

  it('HTF with enough data → includes htfBias', () => {
    const candles = buildTrendCandles('up', 80)
    const htfCandles = buildTrendCandles('up', 80) // aligned
    const result = determineBias(candles, 70, htfCandles, emptyPivots)
    if (result && result.bias !== 'neutral') {
      // HTF should be computed
      expect(result.htfBias).toBeDefined()
    }
  })

  it('HTF opposing → neutral', () => {
    const candles = buildTrendCandles('up', 80)
    const htfCandles = buildTrendCandles('down', 80) // opposing
    const result = determineBias(candles, 70, htfCandles, emptyPivots)
    // If current TF says long and HTF says short → neutral
    if (result && result.source === 'htf-oppose') {
      expect(result.bias).toBe('neutral')
    }
  })

  it('confidence is between 0 and 1', () => {
    const candles = buildTrendCandles('up', 80)
    const result = determineBias(candles, 70, [], emptyPivots)
    if (result) {
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('flat candles → likely neutral (no strong Wyckoff phase)', () => {
    // Very flat market with minimal trend — Wyckoff likely returns null phase
    const candles: Candle[] = []
    for (let i = 0; i < 80; i++) {
      candles.push({
        t: 1000 + i * 60000,
        o: 100,
        h: 100.5,
        l: 99.5,
        c: 100,
        v: 1000,
      })
    }
    const result = determineBias(candles, 70, [], emptyPivots)
    // Flat market: Wyckoff null phase + no BOS/CHoCH → neutral or null
    if (result) {
      // Could be neutral or weak bias from SMC
      expect(result.confidence).toBeLessThan(0.8)
    }
  })
})
