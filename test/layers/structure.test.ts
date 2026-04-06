/**
 * Layer 2: Structure — confirmStructure tests.
 *
 * Tests the 3-state verdict logic: confirm / neutral / deny.
 * Uses hand-crafted swing arrays to control detectStructuralBias output.
 */

import { describe, it, expect } from 'bun:test'
import { confirmStructure } from '../../src/strategy/strategies/layered/layers/structure.js'
import type { Candle, BiasResult, SwingPoint } from '../../src/types.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

const dummyCandles = Array(60).fill(null).map(() => makeCandle())

function makeBias(bias: 'long' | 'short' | 'neutral', confidence = 0.7): BiasResult {
  return { bias, confidence, source: 'test' }
}

// ── Swing fixtures ───────────────────────────────────────────────────────────

// Bullish structure: HH, HL, HH, HL, HH, HL
const bullishSwings: SwingPoint[] = [
  { type: 'HL', price: 100, index: 5 },
  { type: 'HH', price: 110, index: 10 },
  { type: 'HL', price: 105, index: 15 },
  { type: 'HH', price: 115, index: 20 },
  { type: 'HL', price: 108, index: 25 },
  { type: 'HH', price: 120, index: 30 },
]

// Bearish structure: LH, LL, LH, LL, LH, LL
const bearishSwings: SwingPoint[] = [
  { type: 'LH', price: 110, index: 5 },
  { type: 'LL', price: 95, index: 10 },
  { type: 'LH', price: 105, index: 15 },
  { type: 'LL', price: 90, index: 20 },
  { type: 'LH', price: 100, index: 25 },
  { type: 'LL', price: 85, index: 30 },
]

// Mixed / neutral structure: HH, LL, LH, HL (no clear pattern)
const neutralSwings: SwingPoint[] = [
  { type: 'HH', price: 110, index: 5 },
  { type: 'LL', price: 90, index: 10 },
  { type: 'LH', price: 105, index: 15 },
  { type: 'HL', price: 95, index: 20 },
]

// Too few swings (< 4)
const fewSwings: SwingPoint[] = [
  { type: 'HH', price: 110, index: 5 },
  { type: 'HL', price: 100, index: 10 },
]

// ── Tests ────────────────────────────────────────────────────────────────────

describe('confirmStructure', () => {
  it('long bias + bullish swings → confirm', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('long'), bullishSwings)).toBe('confirm')
  })

  it('long bias + bearish swings → deny', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('long'), bearishSwings)).toBe('deny')
  })

  it('long bias + neutral swings → neutral', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('long'), neutralSwings)).toBe('neutral')
  })

  it('short bias + bearish swings → confirm', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('short'), bearishSwings)).toBe('confirm')
  })

  it('short bias + bullish swings → deny', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('short'), bullishSwings)).toBe('deny')
  })

  it('short bias + neutral swings → neutral', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('short'), neutralSwings)).toBe('neutral')
  })

  it('< 4 swings → neutral (insufficient data)', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('long'), fewSwings)).toBe('neutral')
    expect(confirmStructure(dummyCandles, 50, makeBias('short'), fewSwings)).toBe('neutral')
  })

  it('empty swings → neutral', () => {
    expect(confirmStructure(dummyCandles, 50, makeBias('long'), [])).toBe('neutral')
  })
})
