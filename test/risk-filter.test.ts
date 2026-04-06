/**
 * Risk filter tests — distance thresholds, R:R minimums, skip conditions.
 */

import { describe, it, expect } from 'bun:test'
import { assessRisk } from '../src/strategy/strategies/layered/risk-filter.js'
import type { Signal, KeyZone } from '../src/types.js'

function makeSignal(entry: number, sl: number, tp: number, side: 'long' | 'short' = 'long'): Signal {
  return {
    type: 'price-action',
    side,
    confidence: 0.7,
    entryPrice: entry,
    slPrice: sl,
    tpPrice: tp,
    patternData: {},
  }
}

function makeZone(top: number, bottom: number, type: 'demand' | 'supply' = 'demand'): KeyZone {
  return { type, top, bottom, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
}

describe('assessRisk', () => {
  describe('distance thresholds', () => {
    it('near zone (< 2%) → full size', () => {
      // price = 100, zone mid = 99 → 1% distance
      const signal = makeSignal(100, 97, 106)
      const zone = makeZone(100, 98) // mid = 99
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(true)
      expect(result.suggestedSize).toBe('full')
      expect(result.minRR).toBe(1.5)
    })

    it('medium zone (2-5%) → standard size', () => {
      // price = 100, zone mid = 97 → 3% distance
      const signal = makeSignal(100, 93, 114)
      const zone = makeZone(98, 96) // mid = 97
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(true)
      expect(result.suggestedSize).toBe('standard')
      expect(result.minRR).toBe(2.0)
    })

    it('far zone (5-8%) → partial size', () => {
      // price = 100, zone mid = 94 → 6% distance
      // entry=100, sl=95, tp=115 → risk=5, reward=15, RR=3.0 >= 3.0
      // posSize = 100/5 = 20 >= minSize(10) → ok
      // stopDist=5 < ATR×3=15 → ok
      const signal = makeSignal(100, 95, 115)
      const zone = makeZone(95, 93) // mid = 94
      const result = assessRisk(signal, zone, 100, 5)
      expect(result.tradeable).toBe(true)
      expect(result.suggestedSize).toBe('partial')
      expect(result.minRR).toBe(3.0)
    })

    it('skip zone (> 10%) → not tradeable', () => {
      // price = 100, zone mid = 88 → 12% distance
      const signal = makeSignal(100, 85, 130)
      const zone = makeZone(90, 86) // mid = 88
      const result = assessRisk(signal, zone, 100, 5)
      expect(result.tradeable).toBe(false)
      expect(result.suggestedSize).toBe('skip')
    })
  })

  describe('R:R validation', () => {
    it('passes when R:R >= minRR', () => {
      // entry=100, sl=97, tp=106 → risk=3, reward=6, R:R=2.0 >= 1.5
      const signal = makeSignal(100, 97, 106)
      const zone = makeZone(100, 98) // near → minRR=1.5
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(true)
    })

    it('fails when R:R < minRR', () => {
      // entry=100, sl=97, tp=102 → risk=3, reward=2, R:R=0.67 < 1.5
      const signal = makeSignal(100, 97, 102)
      const zone = makeZone(100, 98) // near → minRR=1.5
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(false)
      expect(result.reason).toContain('R:R')
    })
  })

  describe('stop too wide', () => {
    it('fails when stop > ATR × 3', () => {
      // entry=100, sl=80 → stopDist=20, ATR=5, 20 > 15 → too wide
      const signal = makeSignal(100, 80, 140)
      const zone = makeZone(100, 98) // near
      const result = assessRisk(signal, zone, 100, 5)
      expect(result.tradeable).toBe(false)
      expect(result.reason).toContain('stop too wide')
    })

    it('passes when stop <= ATR × 3', () => {
      // entry=100, sl=90 → stopDist=10, ATR=5, 10 < 15 → ok
      const signal = makeSignal(100, 90, 120)
      const zone = makeZone(100, 98) // near
      const result = assessRisk(signal, zone, 100, 5)
      // RR = 20/10 = 2.0 >= 1.5 → tradeable
      expect(result.tradeable).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('zero stop distance → not tradeable (R:R = 0)', () => {
      const signal = makeSignal(100, 100, 110) // sl === entry
      const zone = makeZone(100, 98)
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(false)
    })

    it('short side works correctly', () => {
      // Short: entry=100, sl=103, tp=94 → risk=3, reward=6, RR=2
      const signal = makeSignal(100, 103, 94, 'short')
      const zone = makeZone(102, 100, 'supply')
      const result = assessRisk(signal, zone, 100, 3)
      expect(result.tradeable).toBe(true)
    })
  })
})
