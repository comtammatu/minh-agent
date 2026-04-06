/**
 * Layer 3: Zones — findEntryZones tests.
 *
 * Tests bias-directional filtering. The underlying compileKeyZones
 * is tested via structure golden tests — here we test the filter logic.
 */

import { describe, it, expect } from 'bun:test'
import { findEntryZones } from '../../src/scanner/strategies/layered/layers/zones.js'
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
  it('returns zones array for long bias', () => {
    const candles = buildSwingCandles(80)
    const result = findEntryZones(candles, 70, makeBias('long'))
    expect(Array.isArray(result.zones)).toBe(true)
    // All returned zones should be demand type
    for (const z of result.zones) {
      expect(z.type).toBe('demand')
    }
  })

  it('returns zones array for short bias', () => {
    const candles = buildSwingCandles(80)
    const result = findEntryZones(candles, 70, makeBias('short'))
    expect(Array.isArray(result.zones)).toBe(true)
    // All returned zones should be supply type
    for (const z of result.zones) {
      expect(z.type).toBe('supply')
    }
  })

  it('neutral bias → empty zones', () => {
    const candles = buildSwingCandles(80)
    const result = findEntryZones(candles, 70, makeBias('neutral'))
    expect(result.zones).toEqual([])
  })

  it('insufficient candles (< 30) → empty zones', () => {
    const candles = Array(20).fill(null).map(() => makeCandle())
    const result = findEntryZones(candles, 15, makeBias('long'))
    expect(result.zones).toEqual([])
  })

  it('zones are sorted by proximity to current price', () => {
    const candles = buildSwingCandles(80)
    const { zones } = findEntryZones(candles, 70, makeBias('long'))
    if (zones.length >= 2) {
      const price = candles[70]!.c
      const dist0 = Math.abs(price - (zones[0]!.top + zones[0]!.bottom) / 2)
      const dist1 = Math.abs(price - (zones[1]!.top + zones[1]!.bottom) / 2)
      expect(dist0).toBeLessThanOrEqual(dist1)
    }
  })

  it('returns totalBeforeFilter count', () => {
    const candles = buildSwingCandles(80)
    const result = findEntryZones(candles, 70, makeBias('long'))
    expect(result.totalBeforeFilter).toBeGreaterThanOrEqual(result.zones.length)
  })

  it('freshness filter drops old zones', () => {
    // With idx=70 and ZONE_MAX_AGE=50, zones created before idx 20 are stale
    const candles = buildSwingCandles(80)
    const result = findEntryZones(candles, 70, makeBias('long'))
    for (const z of result.zones) {
      expect(z.createdAtIdx).toBeGreaterThanOrEqual(70 - 50)
    }
  })
})
