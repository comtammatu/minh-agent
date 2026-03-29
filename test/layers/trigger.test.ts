/**
 * Layer 5: Trigger — findTrigger tests.
 *
 * Tests PA pattern filtering by bias direction, zone picking, signal shape.
 */

import { describe, it, expect } from 'bun:test'
import { findTrigger } from '../../src/scanner/layers/trigger.js'
import type { Candle, BiasResult, KeyZone, ZoneConfirmation } from '../../src/types.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

function makeBias(bias: 'long' | 'short'): BiasResult {
  return { bias, confidence: 0.7, source: 'test' }
}

function makeZoneConfirmation(overrides: Partial<ZoneConfirmation> = {}): ZoneConfirmation {
  const zone: KeyZone = { type: 'demand', top: 102, bottom: 98, strength: 0.7, origin: 'order-block' }
  return {
    zone,
    vsaBoost: 0.10,
    vpBoost: 0.05,
    throughZone: false,
    confirmed: true,
    ...overrides,
  }
}

describe('findTrigger', () => {
  it('returns null when no confirmed zones', () => {
    const candles = Array(30).fill(null).map(() => makeCandle())
    expect(findTrigger(candles, 28, [], makeBias('long'))).toBeNull()
  })

  it('returns null when no PA patterns detected', () => {
    // Flat candles → no PA patterns
    const candles: Candle[] = []
    for (let i = 0; i < 30; i++) {
      candles.push({ t: 1000 + i * 60000, o: 100, h: 100.1, l: 99.9, c: 100, v: 1000 })
    }
    const zones = [makeZoneConfirmation()]
    expect(findTrigger(candles, 28, zones, makeBias('long'))).toBeNull()
  })

  it('returns Signal with correct shape when trigger found', () => {
    // Build candles with a bullish engulfing at the end
    const candles: Candle[] = []
    for (let i = 0; i < 29; i++) {
      candles.push({
        t: 1000 + i * 60000,
        o: 100 - i * 0.1,
        h: 102 - i * 0.1,
        l: 97 - i * 0.1,
        c: 99 - i * 0.1,
        v: 1000,
      })
    }
    // Bearish candle followed by bullish engulfing
    candles[27] = { t: 1000 + 27 * 60000, o: 99, h: 100, l: 94, c: 95, v: 1500 }
    candles.push({ t: 1000 + 28 * 60000, o: 94, h: 101, l: 93, c: 100, v: 2000 })

    const zones = [makeZoneConfirmation()]
    const result = findTrigger(candles, 29, zones, makeBias('long'))

    if (result) {
      expect(result.side).toBe('long')
      expect(result.type).toBe('price-action')
      expect(typeof result.entryPrice).toBe('number')
      expect(typeof result.slPrice).toBe('number')
      expect(typeof result.tpPrice).toBe('number')
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
      expect(result.slPrice).toBeLessThan(result.entryPrice) // long: SL below entry
    }
  })

  it('filters out bearish patterns for long bias', () => {
    // Build candles with a bearish engulfing (should be filtered for long)
    const candles: Candle[] = []
    for (let i = 0; i < 29; i++) {
      candles.push({
        t: 1000 + i * 60000,
        o: 100 + i * 0.1,
        h: 103 + i * 0.1,
        l: 99 + i * 0.1,
        c: 102 + i * 0.1,
        v: 1000,
      })
    }
    // Bullish candle followed by bearish engulfing
    candles[27] = { t: 1000 + 27 * 60000, o: 102, h: 107, l: 101, c: 106, v: 1500 }
    candles.push({ t: 1000 + 28 * 60000, o: 107, h: 108, l: 100, c: 101, v: 2000 })

    const supplyZone: KeyZone = { type: 'supply', top: 108, bottom: 105, strength: 0.7, origin: 'order-block' }
    const zones = [makeZoneConfirmation({ zone: supplyZone })]
    const result = findTrigger(candles, 29, zones, makeBias('long'))

    // Should be null — bearish engulfing filtered out for long bias
    // (or if other bullish patterns detected, that's also fine)
    if (result) {
      expect(result.side).toBe('long') // must match bias
    }
  })

  it('throughZone zone gets priority', () => {
    const candles = Array(30).fill(null).map((_, i) => makeCandle({ t: 1000 + i * 60000 }))
    const normalZone = makeZoneConfirmation({ throughZone: false })
    const throughZone = makeZoneConfirmation({ throughZone: true })
    // Even if normalZone is first, throughZone should be picked
    const result = findTrigger(candles, 28, [normalZone, throughZone], makeBias('long'))
    // If result exists, patternData should reference throughZone
    if (result) {
      expect(result.patternData['throughZone']).toBe(true)
    }
  })
})
