/**
 * Expectancy report formatter tests.
 *
 * Tests cover:
 *   1. formatExpectancyReport with passing result
 *   2. formatExpectancyReport with failing result
 *   3. formatExpectancyReport with empty windows (insufficient data)
 *   4. formatExpectancyReport with overfit warning
 *   5. formatMetricsSummary one-liner
 *
 * Sprint 3 S4.
 */

import { describe, test, expect } from 'bun:test'
import { formatExpectancyReport, formatMetricsSummary } from '../../src/backtest/report.js'
import type { BacktestMetrics, WalkForwardResult, WalkForwardWindow } from '../../src/backtest/types.js'

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    totalTrades: 20,
    wins: 12,
    losses: 8,
    winRate: 0.6,
    grossProfit: 1200,
    grossLoss: -600,
    netPnl: 600,
    profitFactor: 2.0,
    avgWin: 100,
    avgLoss: 75,
    avgPnl: 30,
    avgRR: 1.33,
    avgHoldingBars: 5,
    expectancy: 30,
    maxDrawdown: 0.05,
    maxDrawdownDuration: 3,
    sharpeRatio: 1.5,
    sortinoRatio: 2.0,
    calmarRatio: 3.0,
    ...overrides,
  }
}

function makeWindow(
  index: number,
  trainMetrics: BacktestMetrics,
  testMetrics: BacktestMetrics,
): WalkForwardWindow {
  const DAY_MS = 86400000
  return {
    index,
    trainStart: Date.UTC(2025, 0, 1) + index * 7 * DAY_MS,
    trainEnd: Date.UTC(2025, 0, 15) + index * 7 * DAY_MS,
    testStart: Date.UTC(2025, 0, 15) + index * 7 * DAY_MS,
    testEnd: Date.UTC(2025, 0, 22) + index * 7 * DAY_MS,
    trainMetrics,
    testMetrics,
  }
}

// ─── Report Tests ──────────────────────────────────────────────────────────

describe('formatExpectancyReport', () => {
  test('shows PASS verdict when OOS expectancy > 0', () => {
    const result: WalkForwardResult = {
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: 30 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: 25 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: 27.5 }),
      overfitRatio: 1.73,
      passesGate: true,
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('PASS')
    expect(report).toContain('[+]')
    expect(report).toContain('OOS Expectancy')
    expect(report).toContain('IN-SAMPLE vs OUT-OF-SAMPLE')
    expect(report).toContain('PER-WINDOW BREAKDOWN')
    expect(report).toContain('W0')
    expect(report).toContain('W1')
  })

  test('shows FAIL verdict when OOS expectancy <= 0', () => {
    const result: WalkForwardResult = {
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: -10 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: -5 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: -7.5 }),
      overfitRatio: Infinity,
      passesGate: false,
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('FAIL')
    expect(report).toContain('[-]')
  })

  test('shows INSUFFICIENT DATA when no windows', () => {
    const result: WalkForwardResult = {
      windows: [],
      isMetrics: makeMetrics({ totalTrades: 0, expectancy: 0 }),
      oosMetrics: makeMetrics({ totalTrades: 0, expectancy: 0 }),
      overfitRatio: 0,
      passesGate: false,
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('INSUFFICIENT DATA')
  })

  test('shows OVERFIT WARNING when ratio exceeds threshold', () => {
    const result: WalkForwardResult = {
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 100 }), makeMetrics({ expectancy: 10 })),
        makeWindow(1, makeMetrics({ expectancy: 90 }), makeMetrics({ expectancy: 8 })),
      ],
      isMetrics: makeMetrics({ expectancy: 95 }),
      oosMetrics: makeMetrics({ expectancy: 9 }),
      overfitRatio: 10.56, // 95/9
      passesGate: true,
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('OVERFIT WARNING')
    expect(report).toContain('10.56')
  })

  test('does NOT show overfit warning when ratio is within threshold', () => {
    const result: WalkForwardResult = {
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: 40 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: 35 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: 37.5 }),
      overfitRatio: 1.27,
      passesGate: true,
    }

    const report = formatExpectancyReport(result)

    expect(report).not.toContain('OVERFIT WARNING')
  })

  test('comparison table includes all key metrics', () => {
    const result: WalkForwardResult = {
      windows: [
        makeWindow(0, makeMetrics(), makeMetrics()),
        makeWindow(1, makeMetrics(), makeMetrics()),
      ],
      isMetrics: makeMetrics(),
      oosMetrics: makeMetrics(),
      overfitRatio: 1.0,
      passesGate: true,
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('Win Rate')
    expect(report).toContain('Net PnL')
    expect(report).toContain('Expectancy')
    expect(report).toContain('Profit Factor')
    expect(report).toContain('Sharpe')
    expect(report).toContain('Sortino')
    expect(report).toContain('Max Drawdown')
    expect(report).toContain('Avg R:R')
  })
})

// ─── MetricsSummary Tests ──────────────────────────────────────────────────

describe('formatMetricsSummary', () => {
  test('formats one-line summary with all key fields', () => {
    const m = makeMetrics()
    const summary = formatMetricsSummary(m)

    expect(summary).toContain('Trades: 20')
    expect(summary).toContain('WR: 60.0%')
    expect(summary).toContain('PnL: $600.00')
    expect(summary).toContain('Exp: $30.00')
    expect(summary).toContain('Sharpe: 1.50')
    expect(summary).toContain('MaxDD: 5.0%')
    expect(summary).toContain('PF: 2.00')
  })

  test('includes label prefix when provided', () => {
    const m = makeMetrics()
    const summary = formatMetricsSummary(m, 'OOS')

    expect(summary).toContain('[OOS]')
  })

  test('handles Infinity profit factor', () => {
    const m = makeMetrics({ profitFactor: Infinity })
    const summary = formatMetricsSummary(m)

    expect(summary).toContain('PF: Inf')
  })

  test('handles zero trades', () => {
    const m = makeMetrics({
      totalTrades: 0,
      winRate: 0,
      netPnl: 0,
      expectancy: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      profitFactor: 0,
    })
    const summary = formatMetricsSummary(m)

    expect(summary).toContain('Trades: 0')
    expect(summary).toContain('WR: 0.0%')
  })
})
