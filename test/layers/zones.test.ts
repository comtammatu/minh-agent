/**
 * Layer 3: Zones — findEntryZones tests.
 *
 * Tests bias-directional filtering. The underlying compileKeyZones
 * is tested via structure golden tests — here we test the filter logic.
 */

import { describe, it, expect } from 'bun:test'
import { findEntryZones } from '../../src/scanner/layers/zones.js'
import type { Candle, BiasResult } from '../../src/types.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

function makeBias(bias: 'long' | 'short' | 'neutral'): BiasResult {
  return { bias, confidence: 0.7, source: 'test' }
}

/**
 * Build candles with clear swing structure so compileKeyZones produces zones.
 * Alternating up/down creates pivots → demand + supply zones.
 */
function buildSwingCandles(count = 80): Candle[] {
  const candles: Candle[] = []
  for (let i = 0; i < count; i++) {
    const phase = Math.floor(i / 10) % 2 === 0 // alternating 10-bar phases
    const base = 100 + (phase ? (i % 10) * 2 : -(i % 10) * 2)
    candles.push({
      t: 1000 + i * 60000,
      o: base - 1,
      h: base + 3,
      l: base - 3,
      c: base + 1,
      v: 1000 + i * 10,
    })
  }
  return candles
}

describe('findEntryZones', () => {
  it('returns array (possibly empty) for long bias', () => {
    const candles = buildSwingCandles(80)
    const zones = findEntryZones(candles, 70, makeBias('long'))
    expect(Array.isArray(zones)).toBe(true)
    // All returned zones should be demand type
    for (const z of zones) {
      expect(z.type).toBe('demand')
    }
  })

  it('returns array (possibly empty) for short bias', () => {
    const candles = buildSwingCandles(80)
    const zones = findEntryZones(candles, 70, makeBias('short'))
    expect(Array.isArray(zones)).toBe(true)
    // All returned zones should be supply type
    for (const z of zones) {
      expect(z.type).toBe('supply')
    }
  })

  it('neutral bias → empty array', () => {
    const candles = buildSwingCandles(80)
    const zones = findEntryZones(candles, 70, makeBias('neutral'))
    expect(zones).toEqual([])
  })

  it('insufficient candles (< 30) → empty array', () => {
    const candles = Array(20).fill(null).map(() => makeCandle())
    const zones = findEntryZones(candles, 15, makeBias('long'))
    expect(zones).toEqual([])
  })

  it('zones are sorted by proximity to current price', () => {
    const candles = buildSwingCandles(80)
    const zones = findEntryZones(candles, 70, makeBias('long'))
    if (zones.length >= 2) {
      const price = candles[70]!.c
      const dist0 = Math.abs(price - (zones[0]!.top + zones[0]!.bottom) / 2)
      const dist1 = Math.abs(price - (zones[1]!.top + zones[1]!.bottom) / 2)
      expect(dist0).toBeLessThanOrEqual(dist1)
    }
  })
})
