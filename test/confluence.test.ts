/**
 * Confluence scoring tests — grade boundaries C/B/A/A+.
 */

import { describe, it, expect } from 'bun:test'
import { scoreConfluence } from '../src/scanner/confluence.js'
import type { BiasResult, StructureVerdict, ZoneConfirmation, Signal, KeyZone } from '../src/types.js'

function makeBias(confidence = 0.7): BiasResult {
  return { bias: 'long', confidence, source: 'test' }
}

function makeZone(vsaBoost = 0, vpBoost = 0, deltaBoost = 0, bookBoost = 0): ZoneConfirmation {
  const zone: KeyZone = { type: 'demand', top: 102, bottom: 98, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
  return { zone, vsaBoost, vpBoost, deltaBoost, bookBoost, throughZone: false, confirmed: true }
}

function makeSignal(side: 'long' | 'short' = 'long'): Signal {
  return {
    type: 'price-action',
    side,
    confidence: 0.6,
    entryPrice: 100,
    slPrice: 95,
    tpPrice: 110,
    patternData: {},
  }
}

describe('scoreConfluence', () => {
  it('grade C when count < 3', () => {
    // Only bias low confidence (< 0.6) + neutral structure + no zone + no trigger
    const result = scoreConfluence(makeBias(0.3), 'neutral', null, null, 'SIDEWAYS')
    expect(result.grade).toBe('C')
    expect(result.count).toBeLessThan(3)
  })

  it('grade B when count 3-4', () => {
    // bias clear (+1) + confirm (+1) + trigger (+1) = 3
    const result = scoreConfluence(makeBias(0.7), 'confirm', null, makeSignal(), 'SIDEWAYS')
    expect(result.grade).toBe('B')
    expect(result.count).toBeGreaterThanOrEqual(3)
    expect(result.count).toBeLessThan(5)
  })

  it('grade A when count 6-7', () => {
    // bias clear (+1) + confirm (+1) + strong zone (+1) + VSA (+1) + delta (+1) + trigger (+1) = 6
    const result = scoreConfluence(
      makeBias(0.7),
      'confirm',
      makeZone(0.15, 0, 0.15),  // vsaBoost + deltaBoost
      makeSignal('long'),
      'SIDEWAYS',
    )
    expect(result.grade).toBe('A')
    expect(result.count).toBeGreaterThanOrEqual(6)
  })

  it('grade A+ when count >= 8', () => {
    // bias clear (+1) + confirm (+1) + strong zone (+1) + VSA (+1) + VP (+1) + delta (+1) + trigger (+1) + regime aligned (+1) = 8
    const result = scoreConfluence(
      makeBias(0.8),
      'confirm',
      makeZone(0.15, 0.10, 0.15),  // vsaBoost + vpBoost + deltaBoost
      makeSignal('long'),
      'BULL',  // aligned with long
    )
    expect(result.grade).toBe('A+')
    expect(result.count).toBeGreaterThanOrEqual(8)
  })

  it('neutral structure gives +0.5 instead of +1', () => {
    const confirm = scoreConfluence(makeBias(0.7), 'confirm', null, null, 'SIDEWAYS')
    const neutral = scoreConfluence(makeBias(0.7), 'neutral', null, null, 'SIDEWAYS')
    expect(confirm.count - neutral.count).toBeCloseTo(0.5, 5)
  })

  it('regime alignment gives +1 only when trigger exists', () => {
    const withTrigger = scoreConfluence(makeBias(0.7), 'confirm', null, makeSignal('long'), 'BULL')
    const noTrigger = scoreConfluence(makeBias(0.7), 'confirm', null, null, 'BULL')
    // With trigger: +1 trigger + +1 regime = 2 more
    // Without trigger: 0 trigger + 0 regime = 0 more
    expect(withTrigger.count).toBeGreaterThan(noTrigger.count)
  })

  it('confidence is between 0 and 1', () => {
    const result = scoreConfluence(
      makeBias(0.9),
      'confirm',
      makeZone(0.20, 0.15),
      makeSignal(),
      'BULL',
    )
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })
})
