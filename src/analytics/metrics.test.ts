/**
 * Analytics metrics engine tests — pure functions.
 * Sprint 3 S5.
 */

import { describe, it, expect } from 'bun:test'
import {
  computeWinRate,
  computeTotalPnl,
  filterTradesSince,
  aggregateByCoin,
  aggregatePatterns,
  computeDrawdown,
  buildLiveMetrics,
  daysAgo,
  startOfDayUTC,
} from './metrics.js'
import type { ClosedTradeRow, PatternPerfRow } from './types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<ClosedTradeRow> = {}): ClosedTradeRow {
  return {
    coin: 'BTC',
    side: 'long',
    realizedPnl: 100,
    closedAt: new Date('2026-03-30T12:00:00Z'),
    ...overrides,
  }
}

// ─── computeWinRate ─────────────────────────────────────────────────────────

describe('computeWinRate', () => {
  it('returns 0 for empty array', () => {
    expect(computeWinRate([])).toBe(0)
  })

  it('computes correct win rate', () => {
    const trades = [
      makeTrade({ realizedPnl: 100 }),
      makeTrade({ realizedPnl: -50 }),
      makeTrade({ realizedPnl: 200 }),
      makeTrade({ realizedPnl: -30 }),
    ]
    expect(computeWinRate(trades)).toBe(0.5)
  })

  it('returns 1 for all wins', () => {
    const trades = [makeTrade({ realizedPnl: 100 }), makeTrade({ realizedPnl: 50 })]
    expect(computeWinRate(trades)).toBe(1)
  })

  it('returns 0 for all losses', () => {
    const trades = [makeTrade({ realizedPnl: -100 }), makeTrade({ realizedPnl: -50 })]
    expect(computeWinRate(trades)).toBe(0)
  })

  it('treats zero PnL as loss', () => {
    const trades = [makeTrade({ realizedPnl: 0 })]
    expect(computeWinRate(trades)).toBe(0)
  })
})

// ─── computeTotalPnl ────────────────────────────────────────────────────────

describe('computeTotalPnl', () => {
  it('returns 0 for empty array', () => {
    expect(computeTotalPnl([])).toBe(0)
  })

  it('sums PnL correctly', () => {
    const trades = [
      makeTrade({ realizedPnl: 100 }),
      makeTrade({ realizedPnl: -50 }),
      makeTrade({ realizedPnl: 200 }),
    ]
    expect(computeTotalPnl(trades)).toBe(250)
  })
})

// ─── filterTradesSince ──────────────────────────────────────────────────────

describe('filterTradesSince', () => {
  it('filters trades by closed_at', () => {
    const trades = [
      makeTrade({ closedAt: new Date('2026-03-28T10:00:00Z') }),
      makeTrade({ closedAt: new Date('2026-03-30T10:00:00Z') }),
      makeTrade({ closedAt: new Date('2026-03-31T10:00:00Z') }),
    ]
    const since = new Date('2026-03-29T00:00:00Z')
    const filtered = filterTradesSince(trades, since)
    expect(filtered).toHaveLength(2)
  })

  it('returns empty for no matches', () => {
    const trades = [makeTrade({ closedAt: new Date('2026-03-25T10:00:00Z') })]
    const since = new Date('2026-03-29T00:00:00Z')
    expect(filterTradesSince(trades, since)).toHaveLength(0)
  })

  it('returns all for old since date', () => {
    const trades = [
      makeTrade({ closedAt: new Date('2026-03-28T10:00:00Z') }),
      makeTrade({ closedAt: new Date('2026-03-30T10:00:00Z') }),
    ]
    const since = new Date('2026-01-01T00:00:00Z')
    expect(filterTradesSince(trades, since)).toHaveLength(2)
  })
})

// ─── aggregateByCoin ────────────────────────────────────────────────────────

describe('aggregateByCoin', () => {
  it('returns empty for no trades', () => {
    expect(aggregateByCoin([])).toHaveLength(0)
  })

  it('aggregates by coin correctly', () => {
    const trades = [
      makeTrade({ coin: 'BTC', realizedPnl: 100 }),
      makeTrade({ coin: 'BTC', realizedPnl: -50 }),
      makeTrade({ coin: 'ETH', realizedPnl: 200 }),
      makeTrade({ coin: 'ETH', realizedPnl: 150 }),
      makeTrade({ coin: 'SOL', realizedPnl: -100 }),
    ]
    const result = aggregateByCoin(trades)

    expect(result).toHaveLength(3)

    // Sorted by totalPnl DESC: ETH(350), BTC(50), SOL(-100)
    expect(result[0]!.coin).toBe('ETH')
    expect(result[0]!.trades).toBe(2)
    expect(result[0]!.wins).toBe(2)
    expect(result[0]!.winRate).toBe(1)
    expect(result[0]!.totalPnl).toBe(350)
    expect(result[0]!.avgPnl).toBe(175)

    expect(result[1]!.coin).toBe('BTC')
    expect(result[1]!.trades).toBe(2)
    expect(result[1]!.wins).toBe(1)
    expect(result[1]!.winRate).toBe(0.5)
    expect(result[1]!.totalPnl).toBe(50)

    expect(result[2]!.coin).toBe('SOL')
    expect(result[2]!.totalPnl).toBe(-100)
  })
})

// ─── aggregatePatterns ──────────────────────────────────────────────────────

describe('aggregatePatterns', () => {
  it('returns empty for no rows', () => {
    expect(aggregatePatterns([])).toHaveLength(0)
  })

  it('converts rows to PatternMetric with computed winRate', () => {
    const rows: PatternPerfRow[] = [
      { week: new Date(), patternType: 'ob', signalGrade: 'A', trades: 10, wins: 7, totalPnl: 500, avgPnl: 50 },
      { week: new Date(), patternType: 'fvg', signalGrade: 'B', trades: 5, wins: 2, totalPnl: -100, avgPnl: -20 },
    ]
    const result = aggregatePatterns(rows)

    expect(result).toHaveLength(2)
    // Sorted by totalPnl DESC
    expect(result[0]!.patternType).toBe('ob')
    expect(result[0]!.winRate).toBe(0.7)
    expect(result[1]!.patternType).toBe('fvg')
    expect(result[1]!.winRate).toBe(0.4)
  })

  it('handles zero trades gracefully', () => {
    const rows: PatternPerfRow[] = [
      { week: new Date(), patternType: 'ob', signalGrade: 'A', trades: 0, wins: 0, totalPnl: 0, avgPnl: 0 },
    ]
    const result = aggregatePatterns(rows)
    expect(result[0]!.winRate).toBe(0)
  })
})

// ─── computeDrawdown ────────────────────────────────────────────────────────

describe('computeDrawdown', () => {
  it('returns zero for empty trades', () => {
    const { currentDrawdown, maxDrawdown } = computeDrawdown([], 10000)
    expect(currentDrawdown).toBe(0)
    expect(maxDrawdown).toBe(0)
  })

  it('returns zero for zero capital', () => {
    const trades = [makeTrade({ realizedPnl: 100 })]
    const { currentDrawdown, maxDrawdown } = computeDrawdown(trades, 0)
    expect(currentDrawdown).toBe(0)
    expect(maxDrawdown).toBe(0)
  })

  it('computes drawdown correctly', () => {
    // 10000 → 10500 → 10300 → 10800 → 10200
    const trades = [
      makeTrade({ realizedPnl: 500 }),   // equity: 10500, peak: 10500
      makeTrade({ realizedPnl: -200 }),  // equity: 10300, dd: 200/10500 ≈ 0.01905
      makeTrade({ realizedPnl: 500 }),   // equity: 10800, peak: 10800
      makeTrade({ realizedPnl: -600 }),  // equity: 10200, dd: 600/10800 ≈ 0.05556
    ]
    const { currentDrawdown, maxDrawdown } = computeDrawdown(trades, 10000)

    // Max DD = 600/10800 ≈ 0.05556
    expect(maxDrawdown).toBeCloseTo(600 / 10800, 4)
    // Current DD = same (at end, equity=10200, peak=10800)
    expect(currentDrawdown).toBeCloseTo(600 / 10800, 4)
  })

  it('current drawdown is 0 if equity at peak', () => {
    const trades = [
      makeTrade({ realizedPnl: 500 }),
      makeTrade({ realizedPnl: -200 }),
      makeTrade({ realizedPnl: 500 }),
    ]
    const { currentDrawdown, maxDrawdown } = computeDrawdown(trades, 10000)
    expect(currentDrawdown).toBe(0)
    expect(maxDrawdown).toBeCloseTo(200 / 10500, 4)
  })
})

// ─── daysAgo / startOfDayUTC ────────────────────────────────────────────────

describe('time helpers', () => {
  it('daysAgo returns correct date', () => {
    const now = new Date('2026-03-31T15:30:00Z')
    const result = daysAgo(7, now)
    expect(result.toISOString()).toBe('2026-03-24T00:00:00.000Z')
  })

  it('startOfDayUTC zeroes time', () => {
    const result = startOfDayUTC(new Date('2026-03-31T15:30:00Z'))
    expect(result.toISOString()).toBe('2026-03-31T00:00:00.000Z')
  })
})

// ─── buildLiveMetrics ───────────────────────────────────────────────────────

describe('buildLiveMetrics', () => {
  it('returns zero metrics for empty data', () => {
    const result = buildLiveMetrics({
      allTrades: [],
      patternRows: [],
      initialCapital: 10000,
      openPositionCount: 0,
    })

    expect(result.winRate.allTime).toBe(0)
    expect(result.pnl.allTime).toBe(0)
    expect(result.trades.allTime).toBe(0)
    expect(result.patternMetrics).toHaveLength(0)
    expect(result.coinMetrics).toHaveLength(0)
    expect(result.currentDrawdown).toBe(0)
    expect(result.maxDrawdown).toBe(0)
    expect(result.openPositionCount).toBe(0)
  })

  it('computes all fields correctly', () => {
    const now = new Date('2026-03-31T12:00:00Z')

    const allTrades: ClosedTradeRow[] = [
      // Older than 30 days — allTime only
      makeTrade({ coin: 'BTC', realizedPnl: 500, closedAt: new Date('2026-02-15T10:00:00Z') }),
      // Within 30 days
      makeTrade({ coin: 'ETH', realizedPnl: -200, closedAt: new Date('2026-03-10T10:00:00Z') }),
      // Within 7 days
      makeTrade({ coin: 'BTC', realizedPnl: 300, closedAt: new Date('2026-03-28T10:00:00Z') }),
      // Within 1 day
      makeTrade({ coin: 'SOL', realizedPnl: -100, closedAt: new Date('2026-03-31T06:00:00Z') }),
      makeTrade({ coin: 'BTC', realizedPnl: 150, closedAt: new Date('2026-03-31T10:00:00Z') }),
    ]

    const patternRows: PatternPerfRow[] = [
      { week: new Date(), patternType: 'ob', signalGrade: 'A', trades: 3, wins: 2, totalPnl: 450, avgPnl: 150 },
    ]

    const result = buildLiveMetrics({
      allTrades,
      patternRows,
      initialCapital: 10000,
      openPositionCount: 2,
      now,
    })

    // All time: 5 trades, 3 wins (500, 300, 150), 2 losses (-200, -100)
    expect(result.trades.allTime).toBe(5)
    expect(result.winRate.allTime).toBe(0.6)
    expect(result.pnl.allTime).toBe(650) // 500-200+300-100+150

    // Weekly: 3 trades (300, -100, 150)
    expect(result.trades.weekly).toBe(3)
    expect(result.pnl.weekly).toBe(350)

    // Daily: 2 trades (-100, 150)
    expect(result.trades.daily).toBe(2)
    expect(result.pnl.daily).toBe(50)

    // Monthly: 4 trades (-200, 300, -100, 150)
    expect(result.trades.monthly).toBe(4)
    expect(result.pnl.monthly).toBe(150)

    // Coin metrics: BTC (3 trades), ETH (1), SOL (1)
    expect(result.coinMetrics).toHaveLength(3)
    const btc = result.coinMetrics.find(c => c.coin === 'BTC')!
    expect(btc.trades).toBe(3)
    expect(btc.totalPnl).toBe(950)

    // Pattern metrics
    expect(result.patternMetrics).toHaveLength(1)
    expect(result.patternMetrics[0]!.winRate).toBeCloseTo(0.667, 2)

    // Open positions
    expect(result.openPositionCount).toBe(2)

    // Drawdown > 0 (there are losses in the sequence)
    expect(result.maxDrawdown).toBeGreaterThan(0)
  })
})
