import { describe, it, expect } from 'bun:test'
import {
  checkPortfolioEntry,
  getPortfolioRiskSnapshot,
  type PortfolioPosition,
  type PortfolioCheckInput,
} from '../../src/agent/portfolio-risk.js'
import { PORTFOLIO_RISK } from '../../src/config.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    coin: 'BTC',
    notionalValue: 1000,
    ...overrides,
  }
}

function makeInput(overrides: Partial<PortfolioCheckInput> = {}): PortfolioCheckInput {
  return {
    positions: [],
    accountEquity: 10_000,
    proposedNotional: 1000,
    ...overrides,
  }
}

// ─── checkPortfolioEntry ────────────────────────────────────────────────────

describe('checkPortfolioEntry', () => {
  describe('total concurrent positions', () => {
    it('allows entry when under max concurrent', () => {
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition()],
      }))
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeNull()
    })

    it('blocks entry when at max concurrent', () => {
      const positions = Array.from({ length: PORTFOLIO_RISK.maxTotalConcurrent }, (_, i) =>
        makePosition({ coin: `COIN${i}` }),
      )
      const result = checkPortfolioEntry(makeInput({ positions }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('total concurrent positions')
    })
  })

  describe('total notional exposure', () => {
    it('allows entry when under exposure cap', () => {
      // 10k equity, 3x max = 30k. Existing 5k + proposed 1k = 6k → OK
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ notionalValue: 5000 })],
        proposedNotional: 1000,
      }))
      expect(result.allowed).toBe(true)
    })

    it('blocks entry when would exceed exposure cap', () => {
      // 10k equity, 3x max = 30k. Existing 25k + proposed 10k = 35k → blocked
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ notionalValue: 25_000 })],
        proposedNotional: 10_000,
      }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('total exposure')
      expect(result.reason).toContain('would exceed max')
    })

    it('blocks entry right at the boundary', () => {
      // 10k equity, 3x max = 30k. Existing 29k + proposed 1001 = 30001 → blocked
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ notionalValue: 29_000 })],
        proposedNotional: 1_001,
      }))
      expect(result.allowed).toBe(false)
    })

    it('allows entry exactly at the boundary', () => {
      // 10k equity, 3x max = 30k. Existing 29k + proposed 1k = 30k.
      // 30k / 10k = 3.0 → not > 3.0 → allowed
      const result = checkPortfolioEntry(makeInput({
        positions: [
          makePosition({ coin: 'BTC', notionalValue: 14_500 }),
          makePosition({ coin: 'ETH', notionalValue: 14_500 }),
        ],
        proposedNotional: 1_000,
      }))
      expect(result.allowed).toBe(true)
    })
  })

  describe('portfolio-only concurrent positions', () => {
    it('allows entry when total positions stay below the cap', () => {
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition()],
      }))
      expect(result.allowed).toBe(true)
    })

    it('blocks entry when at total concurrent cap', () => {
      const positions = Array.from(
        { length: PORTFOLIO_RISK.maxTotalConcurrent },
        (_, i) => makePosition({ coin: `COIN${i}` }),
      )
      const result = checkPortfolioEntry(makeInput({ positions }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('total concurrent positions')
    })
  })

  describe('exposure cap', () => {
    it('blocks entry when total exposure would exceed the global max', () => {
      const result = checkPortfolioEntry(makeInput({
        accountEquity: 100_000,
        positions: [makePosition({ notionalValue: 295_000 })],
        proposedNotional: 10_000,
      }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('exceed max')
    })

    it('allows entry when total exposure stays within the global max', () => {
      // Existing 20k + proposed 5k = 25k → OK
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ notionalValue: 20_000 })],
        proposedNotional: 5_000,
      }))
      expect(result.allowed).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('blocks when account equity is zero', () => {
      const result = checkPortfolioEntry(makeInput({ accountEquity: 0 }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('zero or negative')
    })

    it('blocks when account equity is negative', () => {
      const result = checkPortfolioEntry(makeInput({ accountEquity: -100 }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('zero or negative')
    })

    it('allows entry with no existing positions', () => {
      const result = checkPortfolioEntry(makeInput({
        positions: [],
        proposedNotional: 1000,
      }))
      expect(result.allowed).toBe(true)
    })

    it('handles multiple open positions across different coins', () => {
      const positions = [
        makePosition({ coin: 'BTC', notionalValue: 5000 }),
        makePosition({ coin: 'ETH', notionalValue: 3000 }),
        makePosition({ coin: 'SOL', notionalValue: 4000 }),
      ]
      // Total: 12k existing + 2k proposed = 14k. 14k / 10k = 1.4x → OK
      const result = checkPortfolioEntry(makeInput({
        positions,
        proposedNotional: 2000,
      }))
      expect(result.allowed).toBe(true)
    })
  })
})

// ─── getPortfolioRiskSnapshot ───────────────────────────────────────────────

describe('getPortfolioRiskSnapshot', () => {
  it('returns empty snapshot for no positions', () => {
    const snap = getPortfolioRiskSnapshot([], 10_000)
    expect(snap.totalPositions).toBe(0)
    expect(snap.totalNotional).toBe(0)
    expect(snap.exposureRatio).toBe(0)
  })

  it('aggregates total notional across the full portfolio', () => {
    const positions: PortfolioPosition[] = [
      { coin: 'BTC', notionalValue: 5000 },
      { coin: 'ETH', notionalValue: 3000 },
      { coin: 'SOL', notionalValue: 4000 },
    ]
    const snap = getPortfolioRiskSnapshot(positions, 10_000)
    expect(snap.totalPositions).toBe(3)
    expect(snap.totalNotional).toBe(12_000)
    expect(snap.exposureRatio).toBeCloseTo(1.2)
  })

  it('handles zero equity gracefully', () => {
    const snap = getPortfolioRiskSnapshot([makePosition()], 0)
    expect(snap.exposureRatio).toBe(0)
  })
})
