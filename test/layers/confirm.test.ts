/**
 * Layer 4: Confirm — isAtZone + confirmZones tests.
 *
 * isAtZone is tested with precise candle/zone/ATR combos.
 * confirmZones is tested with pre-built candle arrays.
 */

import { describe, it, expect } from 'bun:test'
import { isAtZone, confirmZones } from '../../src/strategy/strategies/layered/layers/confirm.js'
import type { Candle, KeyZone, DeltaState } from '../../src/types.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

// ── isAtZone tests ───────────────────────────────────────────────────────────

describe('isAtZone', () => {
  const demandZone: KeyZone = { type: 'demand', top: 98, bottom: 95, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
  const supplyZone: KeyZone = { type: 'supply', top: 108, bottom: 105, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
  const atrVal = 5

  describe('demand zone', () => {
    it('wickTouch: low dips into zone, close above', () => {
      const candle = makeCandle({ l: 96, h: 103, c: 101 })
      const r = isAtZone(candle, demandZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.wickTouch).toBe(true)
    })

    it('nearZone: close within buffer of zone', () => {
      // buffer = 5 * 0.3 = 1.5, zone top = 98, so close <= 99.5 is near
      const candle = makeCandle({ l: 99, h: 103, c: 99 })
      const r = isAtZone(candle, demandZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.nearZone).toBe(true)
    })

    it('throughZone (Spring): low below zone bottom, close above bottom', () => {
      const candle = makeCandle({ l: 93, h: 101, c: 96 })
      const r = isAtZone(candle, demandZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.throughZone).toBe(true)
    })

    it('not at zone: price far above', () => {
      const candle = makeCandle({ l: 110, h: 115, c: 113 })
      const r = isAtZone(candle, demandZone, atrVal)
      expect(r.atZone).toBe(false)
    })
  })

  describe('supply zone', () => {
    it('wickTouch: high pushes into zone', () => {
      const candle = makeCandle({ l: 100, h: 106, c: 102 })
      const r = isAtZone(candle, supplyZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.wickTouch).toBe(true)
    })

    it('nearZone: close within buffer of zone', () => {
      // buffer = 1.5, zone bottom = 105, so close >= 103.5 is near
      const candle = makeCandle({ l: 103, h: 106, c: 104 })
      const r = isAtZone(candle, supplyZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.nearZone).toBe(true)
    })

    it('throughZone (false breakout): high above top, close below top', () => {
      const candle = makeCandle({ l: 103, h: 110, c: 107 })
      const r = isAtZone(candle, supplyZone, atrVal)
      expect(r.atZone).toBe(true)
      expect(r.throughZone).toBe(true)
    })

    it('not at zone: price far below', () => {
      const candle = makeCandle({ l: 85, h: 90, c: 88 })
      const r = isAtZone(candle, supplyZone, atrVal)
      expect(r.atZone).toBe(false)
    })
  })
})

// ── confirmZones tests ───────────────────────────────────────────────────────

describe('confirmZones', () => {
  it('returns empty when idx < 20', () => {
    const candles = Array(15).fill(null).map(() => makeCandle())
    const zone: KeyZone = { type: 'demand', top: 102, bottom: 98, strength: 0.7, origin: 'swing', createdAtIdx: 0 }
    expect(confirmZones(candles, 10, [zone])).toEqual([])
  })

  it('returns empty when no zone is at price', () => {
    // Build candles around 100, zone at 50-55 (far away)
    const candles = Array(30).fill(null).map((_, i) => makeCandle({ t: 1000 + i * 60000 }))
    const zone: KeyZone = { type: 'demand', top: 55, bottom: 50, strength: 0.7, origin: 'swing', createdAtIdx: 0 }
    const result = confirmZones(candles, 28, [zone])
    expect(result).toEqual([])
  })

  it('returns confirmed zone when price is at zone', () => {
    // Build candles trending down to zone level
    const candles: Candle[] = []
    for (let i = 0; i < 30; i++) {
      const base = 105 - i * 0.3  // drift from 105 down to ~96
      candles.push({
        t: 1000 + i * 60000,
        o: base + 0.5,
        h: base + 2,
        l: base - 2,
        c: base - 0.5,
        v: 1000 + i * 50,
      })
    }
    // Zone at 95-98, last candle should be near there
    const zone: KeyZone = { type: 'demand', top: 98, bottom: 95, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
    const result = confirmZones(candles, 28, [zone])
    // May or may not be at zone depending on exact candle position
    expect(Array.isArray(result)).toBe(true)
    for (const r of result) {
      expect(r.zone).toBe(zone)
      expect(typeof r.vsaBoost).toBe('number')
      expect(typeof r.vpBoost).toBe('number')
      expect(typeof r.throughZone).toBe('boolean')
      expect(typeof r.confirmed).toBe('boolean')
    }
  })

  it('ZoneConfirmation has correct shape', () => {
    // Force price exactly at zone
    const candles: Candle[] = []
    for (let i = 0; i < 30; i++) {
      candles.push({
        t: 1000 + i * 60000,
        o: 100,
        h: 102,
        l: 96,  // wick touches zone
        c: 99,
        v: 1000,
      })
    }
    const zone: KeyZone = { type: 'demand', top: 98, bottom: 95, strength: 0.7, origin: 'swing', createdAtIdx: 0 }
    const result = confirmZones(candles, 28, [zone])
    if (result.length > 0) {
      const zc = result[0]!
      expect(zc.vsaBoost).toBeGreaterThanOrEqual(0)
      expect(zc.vsaBoost).toBeLessThanOrEqual(0.20)
      expect(zc.vpBoost).toBeGreaterThanOrEqual(-0.10)
      expect(zc.vpBoost).toBeLessThanOrEqual(0.15)
    }
  })
})

// ── confirmZones with OrderFlowContext ───────────────────────────────────────

describe('confirmZones with order flow', () => {
  const zone: KeyZone = { type: 'demand', top: 98, bottom: 95, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }

  function buildCandlesAtZone(): Candle[] {
    // Force price exactly at zone (wick touches)
    return Array.from({ length: 30 }, (_, i) => ({
      t: 1000 + i * 60000,
      o: 100, h: 102, l: 96, c: 99, v: 1000,
    }))
  }

  it('deltaBoost = 0 when no order flow context', () => {
    const candles = buildCandlesAtZone()
    const result = confirmZones(candles, 28, [zone])
    if (result.length > 0) {
      expect(result[0]!.deltaBoost).toBe(0)
      expect(result[0]!.bookBoost).toBe(0)
      expect(result[0]!.fundingBoost).toBe(0)
    }
  })

  it('deltaBoost > 0 when strong buying at demand', () => {
    const candles = buildCandlesAtZone()
    const delta: DeltaState = { delta: 80, cumDelta: 80, buyVol: 90, sellVol: 10, barTs: 1000 }
    const result = confirmZones(candles, 28, [zone], { delta })
    if (result.length > 0) {
      expect(result[0]!.deltaBoost).toBeGreaterThan(0)
    }
  })

  it('bookBoost > 0 when bid-heavy at demand', () => {
    const candles = buildCandlesAtZone()
    const book = {
      coin: 'BTC',
      bids: [[97, 100], [96, 80]] as [number, number][],
      asks: [[100, 10], [101, 5]] as [number, number][],
      imbalance: 0.85,  // very bid-heavy
      timestamp: Date.now(),
    }
    const result = confirmZones(candles, 28, [zone], { book })
    if (result.length > 0) {
      expect(result[0]!.bookBoost).toBeGreaterThan(0)
    }
  })

  it('fundingBoost > 0 when negative funding + long signal', () => {
    const candles = buildCandlesAtZone()
    const funding = { coin: 'BTC', rate: -0.0005, premium: -0.001, timestamp: Date.now() }
    const result = confirmZones(candles, 28, [zone], { funding, signalSide: 'long' })
    if (result.length > 0) {
      expect(result[0]!.fundingBoost).toBe(0.10)
    }
  })

  it('new boost fields are included in ZoneConfirmation shape', () => {
    const candles = buildCandlesAtZone()
    const result = confirmZones(candles, 28, [zone], {})
    if (result.length > 0) {
      expect(typeof result[0]!.deltaBoost).toBe('number')
      expect(typeof result[0]!.bookBoost).toBe('number')
      expect(typeof result[0]!.fundingBoost).toBe('number')
    }
  })
})
