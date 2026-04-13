/**
 * Order Flow indicator tests — computeDelta, cumulativeDelta, deltaConfirm,
 * bidAskImbalance, bookConfirm, fundingConfirm.
 */

import { describe, it, expect } from 'bun:test'
import { VP_BINS, VP_VALUE_AREA_PCT } from '../../src/config.js'
import {
  computeDelta,
  cumulativeDelta,
  deltaConfirm,
  bidAskImbalance,
  bookConfirm,
  fundingConfirm,
  oiConfirm,
  buildVolumeProfile,
} from '../../src/indicators/order-flow.js'
import type { RawTrade } from '../../src/indicators/order-flow.js'
import type { KeyZone, DeltaState, Candle } from '../../src/types.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const demandZone: KeyZone = { type: 'demand', top: 100, bottom: 95, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }
const supplyZone: KeyZone = { type: 'supply', top: 110, bottom: 105, strength: 0.7, origin: 'order-block', createdAtIdx: 0 }

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

describe('buildVolumeProfile', () => {
  it('matches the previous naive implementation', () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 100 + i * 0.07
      const wave = Math.sin(i / 4.5) * 3.1
      return {
        t: i * 60_000,
        o: base + wave - 0.2,
        h: base + wave + 1.3 + (i % 5) * 0.04,
        l: base + wave - 1.0 - (i % 4) * 0.05,
        c: base + Math.cos(i / 6) * 0.75,
        v: 800 + (i % 11) * 35,
      }
    })

    const naiveBuildVolumeProfile = (
      series: Candle[],
      startIdx: number,
      endIdx: number,
      params: { numBins?: number; valueAreaPct?: number } = {},
    ) => {
      const numBins = params.numBins ?? VP_BINS
      const valueAreaPct = params.valueAreaPct ?? VP_VALUE_AREA_PCT
      if (startIdx < 0 || endIdx >= series.length || startIdx >= endIdx) return null

      let hi = -Infinity
      let lo = Infinity
      for (let i = startIdx; i <= endIdx; i++) {
        const candle = series[i]!
        if (candle.h > hi) hi = candle.h
        if (candle.l < lo) lo = candle.l
      }
      if (hi === lo) return null

      const binSize = (hi - lo) / numBins
      const bins = Array.from({ length: numBins }, (_, i) => ({
        priceLevel: lo + binSize * (i + 0.5),
        volume: 0,
      }))

      for (let i = startIdx; i <= endIdx; i++) {
        const candle = series[i]!
        const lowBin = Math.max(0, Math.floor((candle.l - lo) / binSize))
        const highBin = Math.min(numBins - 1, Math.floor((candle.h - lo) / binSize))
        const binsSpanned = highBin - lowBin + 1
        const volPerBin = candle.v / binsSpanned
        for (let b = lowBin; b <= highBin; b++) bins[b]!.volume += volPerBin
      }

      let poc = 0
      let maxVol = 0
      for (let i = 0; i < bins.length; i++) {
        if (bins[i]!.volume > maxVol) {
          maxVol = bins[i]!.volume
          poc = i
        }
      }

      const total = bins.reduce((sum, bin) => sum + bin.volume, 0)
      const target = total * valueAreaPct
      let acc = bins[poc]!.volume
      let upper = poc
      let lower = poc
      while (acc < target && (upper < bins.length - 1 || lower > 0)) {
        const upVol = upper < bins.length - 1 ? bins[upper + 1]!.volume : 0
        const dnVol = lower > 0 ? bins[lower - 1]!.volume : 0
        if (upVol >= dnVol && upper < bins.length - 1) {
          upper++
          acc += bins[upper]!.volume
        } else if (lower > 0) {
          lower--
          acc += bins[lower]!.volume
        } else {
          upper++
          acc += bins[upper]!.volume
        }
      }

      const pocPrice = bins[poc]!.priceLevel
      const vah = bins[upper]!.priceLevel + binSize / 2
      const val = bins[lower]!.priceLevel - binSize / 2

      const avgVol = total / numBins
      const hvn: number[] = []
      for (let i = 1; i < bins.length - 1; i++) {
        const volume = bins[i]!.volume
        if (volume > avgVol * 1.5 && volume > bins[i - 1]!.volume && volume > bins[i + 1]!.volume) {
          hvn.push(bins[i]!.priceLevel)
        }
      }

      const lvnThreshold = avgVol * 0.5
      const lvn: number[] = []
      let zoneStart = -1
      for (let i = 1; i < bins.length - 1; i++) {
        if (bins[i]!.volume < lvnThreshold) {
          if (zoneStart === -1) zoneStart = i
        } else if (zoneStart !== -1) {
          lvn.push(bins[Math.floor((zoneStart + i - 1) / 2)]!.priceLevel)
          zoneStart = -1
        }
      }
      if (zoneStart !== -1) {
        lvn.push(bins[Math.floor((zoneStart + bins.length - 2) / 2)]!.priceLevel)
      }

      return { poc: pocPrice, vah, val, hvn, lvn }
    }

    expect(buildVolumeProfile(candles, 5, 95)).toEqual(naiveBuildVolumeProfile(candles, 5, 95))
    expect(buildVolumeProfile(candles, 10, 110, { numBins: 32, valueAreaPct: 0.68 }))
      .toEqual(naiveBuildVolumeProfile(candles, 10, 110, { numBins: 32, valueAreaPct: 0.68 }))
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
