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
    strategyId: 'layered',
    notionalValue: 1000,
    ...overrides,
  }
}

function makeInput(overrides: Partial<PortfolioCheckInput> = {}): PortfolioCheckInput {
  return {
    positions: [],
    accountEquity: 10_000,
    strategyId: 'layered',
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
      // 10k equity, 3x max = 30k. Split across strategies to avoid per-strategy cap.
      // layered: 14.5k, quant: 14.5k = 29k total. Proposed 1k for unknown-strat (no alloc cap).
      // 30k / 10k = 3.0 → not > 3.0 → allowed
      const result = checkPortfolioEntry(makeInput({
        positions: [
          makePosition({ strategyId: 'layered', notionalValue: 14_500 }),
          makePosition({ strategyId: 'quant', notionalValue: 14_500 }),
        ],
        strategyId: 'unknown-strat',
        proposedNotional: 1_000,
      }))
      expect(result.allowed).toBe(true)
    })
  })

  describe('per-strategy concurrent positions', () => {
    it('allows entry when strategy under its concurrent cap', () => {
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ strategyId: 'layered' })],
        strategyId: 'layered',
      }))
      expect(result.allowed).toBe(true)
    })

    it('blocks entry when strategy at its concurrent cap', () => {
      const positions = Array.from(
        { length: PORTFOLIO_RISK.strategyMaxConcurrent['layered']! },
        (_, i) => makePosition({ coin: `COIN${i}`, strategyId: 'layered' }),
      )
      const result = checkPortfolioEntry(makeInput({
        positions,
        strategyId: 'layered',
      }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("strategy 'layered'")
      expect(result.reason).toContain('concurrent positions')
    })

    it('allows entry for different strategy even if one is at cap', () => {
      const positions = Array.from(
        { length: PORTFOLIO_RISK.strategyMaxConcurrent['layered']! },
        (_, i) => makePosition({ coin: `COIN${i}`, strategyId: 'layered' }),
      )
      const result = checkPortfolioEntry(makeInput({
        positions,
        strategyId: 'quant',
      }))
      expect(result.allowed).toBe(true)
    })
  })

  describe('per-strategy allocation cap', () => {
    it('blocks entry when strategy would exceed allocated capital × exposure multiplier', () => {
      // layered allocation = 35% of 10k = 3.5k, × 3x = 10.5k cap
      // Existing 10k + proposed 2k = 12k → blocked
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ strategyId: 'layered', notionalValue: 10_000 })],
        strategyId: 'layered',
        proposedNotional: 2_000,
      }))
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("strategy 'layered'")
      expect(result.reason).toContain('allocation cap')
    })

    it('allows entry within allocation cap', () => {
      // layered allocation = 35% of 10k = 3.5k, × 3x = 10.5k cap
      // Existing 6k + proposed 4k = 10k → OK
      const result = checkPortfolioEntry(makeInput({
        positions: [makePosition({ strategyId: 'layered', notionalValue: 6_000 })],
        strategyId: 'layered',
        proposedNotional: 4_000,
      }))
      expect(result.allowed).toBe(true)
    })

    it('ignores allocation cap for unknown strategy (no config)', () => {
      const result = checkPortfolioEntry(makeInput({
        positions: [],
        strategyId: 'unknown-strategy',
        proposedNotional: 50_000,
        accountEquity: 10_000,
      }))
      // Only total exposure check applies: 50k / 10k = 5x > 3x → blocked
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('total exposure')
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

    it('handles multiple strategies with positions', () => {
      const positions = [
        makePosition({ coin: 'BTC', strategyId: 'layered', notionalValue: 5000 }),
        makePosition({ coin: 'ETH', strategyId: 'layered', notionalValue: 3000 }),
        makePosition({ coin: 'SOL', strategyId: 'quant', notionalValue: 4000 }),
      ]
      // Total: 12k existing + 2k proposed = 14k. 14k / 10k = 1.4x → OK
      // quant: 4k existing + 2k = 6k. quant allocation = 50% × 10k × 3x = 15k → OK
      const result = checkPortfolioEntry(makeInput({
        positions,
        strategyId: 'quant',
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
    expect(Object.keys(snap.perStrategy)).toHaveLength(0)
  })

  it('aggregates across strategies', () => {
    const positions: PortfolioPosition[] = [
      { coin: 'BTC', strategyId: 'layered', notionalValue: 5000 },
      { coin: 'ETH', strategyId: 'layered', notionalValue: 3000 },
      { coin: 'SOL', strategyId: 'quant', notionalValue: 4000 },
    ]
    const snap = getPortfolioRiskSnapshot(positions, 10_000)
    expect(snap.totalPositions).toBe(3)
    expect(snap.totalNotional).toBe(12_000)
    expect(snap.exposureRatio).toBeCloseTo(1.2)
    expect(snap.perStrategy['layered']).toEqual({ positions: 2, notional: 8000 })
    expect(snap.perStrategy['quant']).toEqual({ positions: 1, notional: 4000 })
  })

  it('handles zero equity gracefully', () => {
    const snap = getPortfolioRiskSnapshot([makePosition()], 0)
    expect(snap.exposureRatio).toBe(0)
  })
})
