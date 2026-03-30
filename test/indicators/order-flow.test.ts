/**
 * Order Flow indicator tests — computeDelta, cumulativeDelta, deltaConfirm,
 * bidAskImbalance, bookConfirm, fundingConfirm.
 */

import { describe, it, expect } from 'bun:test'
import {
  computeDelta,
  cumulativeDelta,
  deltaConfirm,
  bidAskImbalance,
  bookConfirm,
  fundingConfirm,
  oiConfirm,
} from '../../src/indicators/order-flow.js'
import type { RawTrade } from '../../src/indicators/order-flow.js'
import type { KeyZone, DeltaState } from '../../src/types.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const demandZone: KeyZone = { type: 'demand', top: 100, bottom: 95, strength: 0.7, origin: 'order-block' }
const supplyZone: KeyZone = { type: 'supply', top: 110, bottom: 105, strength: 0.7, origin: 'order-block' }

function makeDelta(overrides: Partial<DeltaState> = {}): DeltaState {
  return { delta: 0, cumDelta: 0, buyVol: 0, sellVol: 0, barTs: 1000, ...overrides }
}

// ── computeDelta ────────────────────────────────────────────────────────────

describe('computeDelta', () => {
  it('all buys → positive delta', () => {
    const trades: RawTrade[] = [
      { side: 'B', size: 10 },
      { side: 'B', size: 20 },
    ]
    const r = computeDelta(trades)
    expect(r.delta).toBe(30)
    expect(r.buyVol).toBe(30)
    expect(r.sellVol).toBe(0)
  })

  it('all sells → negative delta', () => {
    const trades: RawTrade[] = [
      { side: 'A', size: 15 },
      { side: 'A', size: 5 },
    ]
    const r = computeDelta(trades)
    expect(r.delta).toBe(-20)
    expect(r.buyVol).toBe(0)
    expect(r.sellVol).toBe(20)
  })

  it('mixed trades → net delta', () => {
    const trades: RawTrade[] = [
      { side: 'B', size: 100 },
      { side: 'A', size: 40 },
      { side: 'B', size: 10 },
    ]
    const r = computeDelta(trades)
    expect(r.delta).toBe(70)  // 110 - 40
    expect(r.buyVol).toBe(110)
    expect(r.sellVol).toBe(40)
  })

  it('empty trades → zero', () => {
    const r = computeDelta([])
    expect(r.delta).toBe(0)
    expect(r.buyVol).toBe(0)
    expect(r.sellVol).toBe(0)
  })
})

// ── cumulativeDelta ─────────────────────────────────────────────────────────

describe('cumulativeDelta', () => {
  it('sums delta over last N bars', () => {
    const history: DeltaState[] = [
      makeDelta({ delta: 10 }),
      makeDelta({ delta: -5 }),
      makeDelta({ delta: 20 }),
      makeDelta({ delta: -3 }),
    ]
    expect(cumulativeDelta(history, 3)).toBe(12)  // -5 + 20 + (-3)
  })

  it('uses all bars when fewer than N', () => {
    const history: DeltaState[] = [
      makeDelta({ delta: 10 }),
      makeDelta({ delta: 5 }),
    ]
    expect(cumulativeDelta(history, 10)).toBe(15)
  })

  it('empty history → 0', () => {
    expect(cumulativeDelta([], 5)).toBe(0)
  })

  it('positive trend → positive cumDelta', () => {
    const history = Array(5).fill(null).map(() => makeDelta({ delta: 10 }))
    expect(cumulativeDelta(history, 5)).toBe(50)
  })

  it('negative trend → negative cumDelta', () => {
    const history = Array(5).fill(null).map(() => makeDelta({ delta: -8 }))
    expect(cumulativeDelta(history, 5)).toBe(-40)
  })
})

// ── deltaConfirm ────────────────────────────────────────────────────────────

describe('deltaConfirm', () => {
  it('strong buying at demand → +0.15', () => {
    // buyVol=90, sellVol=10, delta=80, ratio=80/100=0.8 > 0.6
    const d = makeDelta({ delta: 80, buyVol: 90, sellVol: 10 })
    expect(deltaConfirm(d, demandZone)).toBe(0.15)
  })

  it('weak buying at demand → +0.05', () => {
    // buyVol=60, sellVol=40, delta=20, ratio=20/100=0.2 < 0.6
    const d = makeDelta({ delta: 20, buyVol: 60, sellVol: 40 })
    expect(deltaConfirm(d, demandZone)).toBe(0.05)
  })

  it('strong selling at demand (divergence) → -0.10', () => {
    // sellVol=90, buyVol=10, delta=-80, ratio=0.8 > 0.6
    const d = makeDelta({ delta: -80, buyVol: 10, sellVol: 90 })
    expect(deltaConfirm(d, demandZone)).toBe(-0.10)
  })

  it('strong selling at supply → +0.15', () => {
    const d = makeDelta({ delta: -80, buyVol: 10, sellVol: 90 })
    expect(deltaConfirm(d, supplyZone)).toBe(0.15)
  })

  it('weak selling at supply → +0.05', () => {
    const d = makeDelta({ delta: -20, buyVol: 40, sellVol: 60 })
    expect(deltaConfirm(d, supplyZone)).toBe(0.05)
  })

  it('strong buying at supply (divergence) → -0.10', () => {
    const d = makeDelta({ delta: 80, buyVol: 90, sellVol: 10 })
    expect(deltaConfirm(d, supplyZone)).toBe(-0.10)
  })

  it('null delta → 0', () => {
    expect(deltaConfirm(null, demandZone)).toBe(0)
  })

  it('zero volume → 0', () => {
    const d = makeDelta({ delta: 0, buyVol: 0, sellVol: 0 })
    expect(deltaConfirm(d, demandZone)).toBe(0)
  })
})

// ── bidAskImbalance ─────────────────────────────────────────────────────────

describe('bidAskImbalance', () => {
  it('balanced book → ~0', () => {
    const bids: [number, number][] = [[100, 50], [99, 50]]
    const asks: [number, number][] = [[101, 50], [102, 50]]
    expect(bidAskImbalance(bids, asks)).toBe(0)
  })

  it('bid-heavy → positive', () => {
    const bids: [number, number][] = [[100, 80], [99, 20]]
    const asks: [number, number][] = [[101, 10], [102, 10]]
    // (100 - 20) / 120 = 0.667
    expect(bidAskImbalance(bids, asks)).toBeCloseTo(0.667, 2)
  })

  it('ask-heavy → negative', () => {
    const bids: [number, number][] = [[100, 10]]
    const asks: [number, number][] = [[101, 80], [102, 10]]
    // (10 - 90) / 100 = -0.80
    expect(bidAskImbalance(bids, asks)).toBeCloseTo(-0.80, 2)
  })

  it('empty book → 0', () => {
    expect(bidAskImbalance([], [])).toBe(0)
  })

  it('all bids no asks → +1', () => {
    const bids: [number, number][] = [[100, 50]]
    expect(bidAskImbalance(bids, [])).toBe(1)
  })

  it('all asks no bids → -1', () => {
    const asks: [number, number][] = [[101, 50]]
    expect(bidAskImbalance([], asks)).toBe(-1)
  })
})

// ── bookConfirm ─────────────────────────────────────────────────────────────

describe('bookConfirm', () => {
  // BOOK_IMBALANCE_THRESHOLD = 0.3

  describe('demand zone', () => {
    it('absorption (imbalance >= 0.6) → +0.20', () => {
      expect(bookConfirm(0.7, demandZone)).toBe(0.20)
    })

    it('bid-heavy (imbalance >= 0.3) → +0.10', () => {
      expect(bookConfirm(0.35, demandZone)).toBe(0.10)
    })

    it('ask-heavy counter (imbalance <= -0.3) → -0.10', () => {
      expect(bookConfirm(-0.5, demandZone)).toBe(-0.10)
    })

    it('neutral → 0', () => {
      expect(bookConfirm(0.1, demandZone)).toBe(0)
    })
  })

  describe('supply zone', () => {
    it('absorption (imbalance <= -0.6) → +0.20', () => {
      expect(bookConfirm(-0.7, supplyZone)).toBe(0.20)
    })

    it('ask-heavy (imbalance <= -0.3) → +0.10', () => {
      expect(bookConfirm(-0.35, supplyZone)).toBe(0.10)
    })

    it('bid-heavy counter (imbalance >= 0.3) → -0.10', () => {
      expect(bookConfirm(0.5, supplyZone)).toBe(-0.10)
    })

    it('neutral → 0', () => {
      expect(bookConfirm(-0.1, supplyZone)).toBe(0)
    })
  })
})

// ── fundingConfirm ──────────────────────────────────────────────────────────

describe('fundingConfirm', () => {
  // FUNDING_CONTRARIAN_THRESHOLD = -0.0001

  it('negative funding + long → +0.10 (contrarian)', () => {
    expect(fundingConfirm(-0.0005, 'long')).toBe(0.10)
  })

  it('positive funding + short → +0.10 (contrarian)', () => {
    expect(fundingConfirm(0.0005, 'short')).toBe(0.10)
  })

  it('positive funding + long → 0 (not contrarian)', () => {
    expect(fundingConfirm(0.0005, 'long')).toBe(0)
  })

  it('negative funding + short → 0 (not contrarian)', () => {
    expect(fundingConfirm(-0.0005, 'short')).toBe(0)
  })

  it('null rate → 0', () => {
    expect(fundingConfirm(null, 'long')).toBe(0)
  })

  it('zero rate → 0', () => {
    expect(fundingConfirm(0, 'short')).toBe(0)
  })

  it('barely negative rate (above threshold) → 0', () => {
    // -0.00005 > -0.0001, so NOT below threshold
    expect(fundingConfirm(-0.00005, 'long')).toBe(0)
  })

  it('barely positive rate (below -threshold) → 0 for short', () => {
    // 0.00005 < 0.0001 (which is -FUNDING_CONTRARIAN_THRESHOLD)
    expect(fundingConfirm(0.00005, 'short')).toBe(0)
  })
})

// ── oiConfirm ──────────────────────────────────────────────────────────────

describe('oiConfirm', () => {
  // OI_SPIKE_THRESHOLD = 0.05 (5%)

  it('OI spike (>= 5%) + long → +0.10', () => {
    expect(oiConfirm(0.08, 'long')).toBe(0.10)
  })

  it('OI spike (>= 5%) + short → +0.10', () => {
    expect(oiConfirm(0.06, 'short')).toBe(0.10)
  })

  it('moderate OI increase (positive but < 5%) → +0.05', () => {
    expect(oiConfirm(0.03, 'long')).toBe(0.05)
  })

  it('exactly at threshold → +0.10', () => {
    expect(oiConfirm(0.05, 'short')).toBe(0.10)
  })

  it('flat OI (0) → 0', () => {
    expect(oiConfirm(0, 'long')).toBe(0)
  })

  it('declining OI (negative) → 0', () => {
    expect(oiConfirm(-0.03, 'short')).toBe(0)
  })

  it('null delta → 0', () => {
    expect(oiConfirm(null, 'long')).toBe(0)
  })
})
