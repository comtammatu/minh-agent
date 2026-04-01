/**
 * Tests for /api/structure/:coin/:tf endpoint logic.
 *
 * Tests the analyzeStructure output shape used by the dashboard chart page.
 * Pure unit tests — no server I/O.
 */

import { describe, it, expect } from 'bun:test'
import { analyzeStructure } from '../../src/indicators/structure.js'
import type { Candle } from '../../src/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandles(count: number, startPrice: number = 100): Candle[] {
  const candles: Candle[] = []
  let price = startPrice
  for (let i = 0; i < count; i++) {
    // Create a trending pattern: up-down oscillation with slight upward drift
    const direction = i % 4 < 2 ? 1 : -1
    const change = direction * (1 + Math.sin(i * 0.3) * 2)
    price += change
    const o = price
    const c = price + change * 0.5
    const h = Math.max(o, c) + Math.abs(change) * 0.3
    const l = Math.min(o, c) - Math.abs(change) * 0.3
    candles.push({
      t: 1700000000000 + i * 60000,
      o,
      h,
      l,
      c,
      v: 1000 + Math.random() * 500,
    })
  }
  return candles
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Structure API (analyzeStructure shape)', () => {
  it('returns neutral structure for < 50 candles', () => {
    const candles = makeCandles(30)
    const result = analyzeStructure(candles)

    expect(result.bias).toBe('neutral')
    expect(result.biasConfidence).toBe(0)
    expect(result.swings).toEqual([])
    expect(result.demandZones).toEqual([])
    expect(result.supplyZones).toEqual([])
  })

  it('returns valid MarketStructure shape for 100+ candles', () => {
    const candles = makeCandles(150)
    const result = analyzeStructure(candles)

    // Shape validation
    expect(typeof result.bias).toBe('string')
    expect(['bullish', 'bearish', 'neutral']).toContain(result.bias)
    expect(typeof result.biasConfidence).toBe('number')
    expect(result.biasConfidence).toBeGreaterThanOrEqual(0)
    expect(result.biasConfidence).toBeLessThanOrEqual(1)
    expect(Array.isArray(result.swings)).toBe(true)
    expect(Array.isArray(result.demandZones)).toBe(true)
    expect(Array.isArray(result.supplyZones)).toBe(true)
  })

  it('swings have valid shape (type/price/index)', () => {
    const candles = makeCandles(150)
    const result = analyzeStructure(candles)

    for (const sw of result.swings) {
      expect(['HH', 'HL', 'LH', 'LL']).toContain(sw.type)
      expect(typeof sw.price).toBe('number')
      expect(typeof sw.index).toBe('number')
      expect(sw.index).toBeGreaterThanOrEqual(0)
      expect(sw.index).toBeLessThan(candles.length)
    }
  })

  it('zones have valid shape (type/top/bottom/strength/origin)', () => {
    const candles = makeCandles(200)
    const result = analyzeStructure(candles)
    const allZones = [...result.demandZones, ...result.supplyZones]

    for (const zone of allZones) {
      expect(['demand', 'supply']).toContain(zone.type)
      expect(typeof zone.top).toBe('number')
      expect(typeof zone.bottom).toBe('number')
      expect(zone.top).toBeGreaterThanOrEqual(zone.bottom)
      expect(typeof zone.strength).toBe('number')
      expect(zone.strength).toBeGreaterThanOrEqual(0)
      expect(zone.strength).toBeLessThanOrEqual(1)
      expect(typeof zone.origin).toBe('string')
      expect(typeof zone.createdAtIdx).toBe('number')
    }
  })

  it('demand zones have type=demand, supply zones have type=supply', () => {
    const candles = makeCandles(200)
    const result = analyzeStructure(candles)

    for (const zone of result.demandZones) {
      expect(zone.type).toBe('demand')
    }
    for (const zone of result.supplyZones) {
      expect(zone.type).toBe('supply')
    }
  })

  it('handles empty candle array gracefully', () => {
    const result = analyzeStructure([])

    expect(result.bias).toBe('neutral')
    expect(result.biasConfidence).toBe(0)
    expect(result.swings).toEqual([])
  })
})
