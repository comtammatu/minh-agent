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
import {
  buildReleaseGateDriftRows,
  buildReleaseGateDiagnosticSummary,
  buildReleaseGateWindowRows,
  collectWalkForwardTrades,
  evaluateReleaseGateScorecard,
  formatReleaseGateBatchTable,
  formatReleaseGateDiagnosticReport,
  formatReleaseGate1hAuditTable,
  formatReleaseGateDriftTable,
  formatReleaseGateModeMatrixTable,
  formatReleaseGateWindowTable,
  formatExpectancyReport,
  formatMetricsSummary,
  formatReleaseGateValidationReport,
} from '../../src/backtest/report.js'
import {
  buildTailClusterFingerprintRows,
  buildTailClusterMajorityRows,
  buildTailClusterSummary,
  buildTailClusterTradeRows,
  buildTailClusterUnanimousRows,
  collectTailClusterTrades,
  formatTailClusterFingerprintTable,
  formatTailClusterSummary,
  formatTailClusterTradeTable,
} from '../../src/backtest/tail-cluster.js'
import type { BacktestMetrics, BacktestTrade, WalkForwardResult, WalkForwardWindow } from '../../src/backtest/types.js'

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

function makeWalkForwardResult(overrides: Partial<WalkForwardResult> = {}): WalkForwardResult {
  return {
    windows: [
      makeWindow(0, makeMetrics({ expectancy: 40 }), makeMetrics({ expectancy: 20 })),
      makeWindow(1, makeMetrics({ expectancy: 35 }), makeMetrics({ expectancy: 15 })),
    ],
    isMetrics: makeMetrics({ expectancy: 37.5 }),
    oosMetrics: makeMetrics({ expectancy: 17.5 }),
    overfitRatio: 1.5,
    passesGate: true,
    oosExpectancyCI: { lower: 5, upper: 25, mean: 17.5 },
    windowConsistency: { consistentWindows: 2, totalWindows: 2, ratio: 1 },
    gateDetail: {
      minTrades: true,
      positiveExpectancy: true,
      ciLowerPositive: true,
      windowConsistent: true,
      notOverfit: true,
    },
    ...overrides,
  }
}

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    coin: 'BTC',
    interval: '1h',
    side: 'long',
    patternType: 'smc-sd',
    confluenceGrade: 'B',
    entryPrice: 100,
    exitPrice: 102,
    slPrice: 95,
    tpPrice: 110,
    sizeUsd: 1000,
    entryTime: Date.UTC(2025, 0, 1),
    exitTime: Date.UTC(2025, 0, 2),
    holdingBars: 4,
    pnl: 20,
    pnlPct: 0.02,
    exitReason: 'tp_hit',
    diagnostics: {
      setupVariant: '1h_same_tf',
      regime: 'BULL',
      zoneOrigin: 'order-block',
      killzoneName: 'london',
    },
    ...overrides,
  }
}

// ─── Report Tests ──────────────────────────────────────────────────────────

describe('formatExpectancyReport', () => {
  test('shows PASS verdict when OOS expectancy > 0', () => {
    const result = makeWalkForwardResult({
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: 30 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: 25 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: 27.5 }),
      overfitRatio: 1.73,
      passesGate: true,
    })

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
    const result = makeWalkForwardResult({
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: -10 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: -5 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: -7.5 }),
      overfitRatio: Infinity,
      passesGate: false,
      oosExpectancyCI: { lower: -12, upper: -3, mean: -7.5 },
      windowConsistency: { consistentWindows: 0, totalWindows: 2, ratio: 0 },
      gateDetail: {
        minTrades: false,
        positiveExpectancy: false,
        ciLowerPositive: false,
        windowConsistent: false,
        notOverfit: false,
      },
    })

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
      oosExpectancyCI: { lower: 0, upper: 0, mean: 0 },
      windowConsistency: { consistentWindows: 0, totalWindows: 0, ratio: 0 },
      gateDetail: {
        minTrades: false,
        positiveExpectancy: false,
        ciLowerPositive: false,
        windowConsistent: false,
        notOverfit: false,
      },
    }

    const report = formatExpectancyReport(result)

    expect(report).toContain('INSUFFICIENT DATA')
  })

  test('shows OVERFIT WARNING when ratio exceeds threshold', () => {
    const result = makeWalkForwardResult({
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 100 }), makeMetrics({ expectancy: 10 })),
        makeWindow(1, makeMetrics({ expectancy: 90 }), makeMetrics({ expectancy: 8 })),
      ],
      isMetrics: makeMetrics({ expectancy: 95 }),
      oosMetrics: makeMetrics({ expectancy: 9 }),
      overfitRatio: 10.56,
      passesGate: true,
    })

    const report = formatExpectancyReport(result)

    expect(report).toContain('OVERFIT WARNING')
    expect(report).toContain('10.56')
  })

  test('does NOT show overfit warning when ratio is within threshold', () => {
    const result = makeWalkForwardResult({
      windows: [
        makeWindow(0, makeMetrics({ expectancy: 50 }), makeMetrics({ expectancy: 40 })),
        makeWindow(1, makeMetrics({ expectancy: 45 }), makeMetrics({ expectancy: 35 })),
      ],
      isMetrics: makeMetrics({ expectancy: 47.5 }),
      oosMetrics: makeMetrics({ expectancy: 37.5 }),
      overfitRatio: 1.27,
      passesGate: true,
    })

    const report = formatExpectancyReport(result)

    expect(report).not.toContain('OVERFIT WARNING')
  })

  test('comparison table includes all key metrics', () => {
    const result = makeWalkForwardResult({
      windows: [
        makeWindow(0, makeMetrics(), makeMetrics()),
        makeWindow(1, makeMetrics(), makeMetrics()),
      ],
      isMetrics: makeMetrics(),
      oosMetrics: makeMetrics(),
      overfitRatio: 1.0,
      passesGate: true,
    })

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

describe('release gate report', () => {
  test('evaluates scorecard against unattended-live thresholds', () => {
    const oos = makeWalkForwardResult({
      oosMetrics: makeMetrics({ profitFactor: 1.2, totalTrades: 120, maxDrawdown: 0.15 }),
    })
    const holdout = makeWalkForwardResult({
      oosMetrics: makeMetrics({ profitFactor: 1.3, totalTrades: 45 }),
    })

    const scorecard = evaluateReleaseGateScorecard({
      coins: ['BTC', 'ETH', 'SOL'],
      strategyParams: {},
      oos,
      holdout,
    })

    expect(scorecard).toEqual({
      holdoutPf: true,
      oosPf: true,
      holdoutTrades: true,
      oosTrades: true,
      oosMaxDd: true,
    })
  })

  test('formats NO-GO report when any scorecard row fails', () => {
    const oos = makeWalkForwardResult({
      passesGate: false,
      oosMetrics: makeMetrics({ profitFactor: 0.95, totalTrades: 70, maxDrawdown: 0.28 }),
    })
    const holdout = makeWalkForwardResult({
      passesGate: false,
      oosMetrics: makeMetrics({ profitFactor: 0.9, totalTrades: 20 }),
    })

    const report = formatReleaseGateValidationReport({
      coins: ['BTC', 'ETH', 'SOL'],
      strategyParams: { SMC_MIN_RR: 2 },
      oos,
      holdout,
    })

    expect(report).toContain('UNATTENDED-LIVE RELEASE GATE VALIDATION')
    expect(report).toContain('Verdict: NO-GO')
    expect(report).toContain('Holdout PF')
    expect(report).toContain('OOS PF')
    expect(report).toContain('Holdout WFA gate: FAIL')
  })

  test('formats batch comparison table for multiple candidates', () => {
    const table = formatReleaseGateBatchTable([
      {
        label: 'default',
        strategyParams: {},
        verdict: 'NO-GO',
        holdoutPf: 0.08,
        oosPf: 0.41,
        holdoutTrades: 12,
        oosTrades: 39,
        oosMaxDd: 0.269,
      },
      {
        label: 'rr2',
        strategyParams: { SMC_MIN_RR: 2 },
        verdict: 'NO-GO',
        holdoutPf: 0.22,
        oosPf: 0.73,
        holdoutTrades: 18,
        oosTrades: 54,
        oosMaxDd: 0.18,
      },
    ])

    expect(table).toContain('Label')
    expect(table).toContain('Verdict')
    expect(table).toContain('default')
    expect(table).toContain('rr2')
    expect(table).toContain('{"SMC_MIN_RR":2}')
  })

  test('formats scan-mode matrix table with disabled-mode provenance', () => {
    const table = formatReleaseGateModeMatrixTable([
      {
        label: 'all_modes',
        disabledScanModes: [],
        verdict: 'NO-GO',
        holdoutPf: 0.08,
        oosPf: 0.41,
        holdoutTrades: 12,
        oosTrades: 39,
        oosMaxDd: 0.269,
      },
      {
        label: '1h_only',
        disabledScanModes: ['15m_drilldown', '5m_micro', '4h_poi'],
        verdict: 'NO-GO',
        holdoutPf: 0.06,
        oosPf: 0.38,
        holdoutTrades: 10,
        oosTrades: 35,
        oosMaxDd: 0.28,
      },
    ])

    expect(table).toContain('Disabled modes')
    expect(table).toContain('all_modes')
    expect(table).toContain('(none)')
    expect(table).toContain('15m_drilldown,5m_micro,4h_poi')
  })

  test('formats 1h audit table with coin subsets and params', () => {
    const table = formatReleaseGate1hAuditTable([
      {
        label: 'all_base',
        coins: ['BTC', 'ETH', 'SOL'],
        strategyParams: {},
        verdict: 'NO-GO',
        holdoutPf: 0.08,
        oosPf: 0.41,
        holdoutTrades: 12,
        oosTrades: 39,
        oosMaxDd: 0.269,
      },
      {
        label: 'no_btc_sideways_guard',
        coins: ['ETH', 'SOL'],
        strategyParams: {
          MIN_CONFIDENCE: 0.65,
          REGIME_MULT_NEUTRAL: 0.7,
          SMC_1H_CONFIDENCE_BASE: 0.7,
        },
        verdict: 'PASS',
        holdoutPf: 1.22,
        oosPf: 1.17,
        holdoutTrades: 41,
        oosTrades: 111,
        oosMaxDd: 0.14,
      },
    ])

    expect(table).toContain('Coins')
    expect(table).toContain('all_base')
    expect(table).toContain('BTC,ETH,SOL')
    expect(table).toContain('no_btc_sideways_guard')
    expect(table).toContain('{"MIN_CONFIDENCE":0.65,"REGIME_MULT_NEUTRAL":0.7,"SMC_1H_CONFIDENCE_BASE":0.7}')
  })

  test('builds and formats drift rows between OOS and holdout buckets', () => {
    const rows = buildReleaseGateDriftRows(
      [
        { bucket: 'SIDEWAYS', trades: 17, winRate: 0.47, netPnl: -419.38, expectancy: -24.67, profitFactor: 0.98 },
        { bucket: 'BULL', trades: 4, winRate: 0.5, netPnl: 240.73, expectancy: 60.18, profitFactor: null as unknown as number },
      ],
      [
        { bucket: 'SIDEWAYS', trades: 3, winRate: 0, netPnl: -467.35, expectancy: -155.78, profitFactor: 0 },
        { bucket: 'BEAR', trades: 2, winRate: 0, netPnl: -310.34, expectancy: -155.17, profitFactor: 0 },
      ],
    )

    expect(rows[0]).toEqual({
      bucket: 'BULL',
      oosTrades: 4,
      oosPf: Infinity,
      oosPnl: 240.73,
      holdoutTrades: 0,
      holdoutPf: 0,
      holdoutPnl: 0,
      pfDelta: -Infinity,
      pnlDelta: -240.73,
    })

    const table = formatReleaseGateDriftTable(rows)
    expect(table).toContain('Bucket')
    expect(table).toContain('SIDEWAYS')
    expect(table).toContain('BEAR')
    expect(table).toContain('Inf')
  })

  test('builds and formats non-empty window rows', () => {
    const rows = buildReleaseGateWindowRows([
      makeWindow(0, makeMetrics(), makeMetrics({ totalTrades: 0, netPnl: 0, profitFactor: 0, winRate: 0 })),
      makeWindow(1, makeMetrics(), makeMetrics({ totalTrades: 2, netPnl: 120, profitFactor: null as unknown as number, winRate: 1 })),
      makeWindow(2, makeMetrics(), makeMetrics({ totalTrades: 1, netPnl: -80, profitFactor: 0, winRate: 0 })),
    ])

    expect(rows).toEqual([
      {
        index: 1,
        start: '2025-01-22',
        end: '2025-01-29',
        trades: 2,
        winRate: 1,
        pnl: 120,
        profitFactor: Infinity,
      },
      {
        index: 2,
        start: '2025-01-29',
        end: '2025-02-05',
        trades: 1,
        winRate: 0,
        pnl: -80,
        profitFactor: 0,
      },
    ])

    const table = formatReleaseGateWindowTable(rows)
    expect(table).toContain('Win')
    expect(table).toContain('2025-01-22')
    expect(table).toContain('$120.00')
    expect(table).toContain('$-80.00')
    expect(table).toContain('Inf')
  })

  test('collects OOS trades from walk-forward windows', () => {
    const trades = [
      makeTrade({ coin: 'BTC' }),
      makeTrade({ coin: 'ETH', pnl: -30, exitPrice: 97 }),
    ]
    const result = makeWalkForwardResult({
      windows: [
        { ...makeWindow(0, makeMetrics(), makeMetrics()), testTrades: [trades[0]!] },
        { ...makeWindow(1, makeMetrics(), makeMetrics()), testTrades: [trades[1]!] },
      ],
    })

    expect(collectWalkForwardTrades(result)).toEqual(trades)
  })

  test('builds diagnostic summary by coin/timeframe/regime/setup type', () => {
    const summary = buildReleaseGateDiagnosticSummary([
      makeTrade({ coin: 'BTC', interval: '1h', pnl: -40, diagnostics: { setupVariant: '1h_same_tf', regime: 'SIDEWAYS', zoneOrigin: 'order-block', killzoneName: 'london' } }),
      makeTrade({ coin: 'ETH', interval: '5m', pnl: 25, diagnostics: { setupVariant: '5m_micro_entry', regime: 'BULL', zoneOrigin: 'breaker-block', killzoneName: 'ny-open' } }),
      makeTrade({ coin: 'ETH', interval: '5m', pnl: -15, diagnostics: { setupVariant: '5m_micro_entry', regime: 'BULL', zoneOrigin: 'breaker-block', killzoneName: 'ny-open' } }),
    ], 10_000)

    expect(summary.totalTrades).toBe(3)
    expect(summary.byCoin[0]?.bucket).toBe('BTC')
    expect(summary.byCoin[0]?.netPnl).toBe(-40)
    expect(summary.byTimeframe[0]?.bucket).toBe('1h')
    expect(summary.byRegime[0]?.bucket).toBe('SIDEWAYS')
    expect(summary.bySetupVariant[0]?.bucket).toBe('1h_same_tf')
  })

  test('formats release-gate diagnostics report', () => {
    const report = formatReleaseGateDiagnosticReport('default', 'OOS', buildReleaseGateDiagnosticSummary([
      makeTrade({ coin: 'BTC', pnl: -40 }),
      makeTrade({ coin: 'ETH', interval: '5m', pnl: 25, diagnostics: { setupVariant: '5m_micro_entry', regime: 'BULL', zoneOrigin: 'breaker-block', killzoneName: 'ny-open' } }),
    ], 10_000))

    expect(report).toContain('RELEASE GATE DIAGNOSTICS | default | OOS')
    expect(report).toContain('By coin')
    expect(report).toContain('By timeframe')
    expect(report).toContain('By regime')
    expect(report).toContain('By setup type')
    expect(report).toContain('5m_micro_entry')
  })

  test('builds tail-cluster summary and fingerprint tables', () => {
    const trade1 = makeTrade({
      entryTime: Date.UTC(2026, 2, 15, 9, 0, 0),
      exitTime: Date.UTC(2026, 2, 15, 11, 0, 0),
      pnl: -164.84,
      pnlPct: -0.016,
      holdingBars: 16,
      exitReason: 'sl_hit',
      side: 'long',
      diagnostics: {
        setupVariant: '1h_same_tf',
        regime: 'BULL',
        zoneOrigin: 'order-block',
        killzoneName: 'london-open',
      },
    })
    const trade2 = makeTrade({
      entryTime: Date.UTC(2026, 2, 24, 18, 0, 0),
      exitTime: Date.UTC(2026, 2, 24, 20, 0, 0),
      pnl: -157.28,
      pnlPct: -0.015,
      holdingBars: 10,
      exitReason: 'sl_hit',
      side: 'short',
      diagnostics: {
        setupVariant: '1h_same_tf',
        regime: 'SIDEWAYS',
        zoneOrigin: 'swing',
        killzoneName: 'us-session',
      },
    })
    const trade3 = makeTrade({
      entryTime: Date.UTC(2026, 2, 28, 23, 0, 0),
      exitTime: Date.UTC(2026, 2, 29, 3, 0, 0),
      pnl: -158.5,
      pnlPct: -0.016,
      holdingBars: 111,
      exitReason: 'sl_hit',
      side: 'long',
      diagnostics: {
        setupVariant: '1h_same_tf',
        regime: 'BULL',
        zoneOrigin: 'breaker-block',
        killzoneName: 'off-session',
      },
    })

    const windows = [
      { ...makeWindow(48, makeMetrics(), makeMetrics({ totalTrades: 1, netPnl: -164.84, profitFactor: 0, winRate: 0 })), testTrades: [trade1] },
      { ...makeWindow(49, makeMetrics(), makeMetrics({ totalTrades: 1, netPnl: -157.28, profitFactor: 0, winRate: 0 })), testTrades: [trade2] },
      { ...makeWindow(50, makeMetrics(), makeMetrics({ totalTrades: 1, netPnl: -158.5, profitFactor: 0, winRate: 0 })), testTrades: [trade3] },
    ]

    const trades = collectTailClusterTrades(windows)
    const summary = buildTailClusterSummary(trades)
    const fingerprintRows = buildTailClusterFingerprintRows(trades)
    const unanimousRows = buildTailClusterUnanimousRows(trades)
    const majorityRows = buildTailClusterMajorityRows(trades)

    expect(trades).toHaveLength(3)
    expect(summary).toMatchObject({
      totalTrades: 3,
      wins: 0,
      losses: 3,
      netPnl: -480.62,
      trailingLossStreak: 3,
    })
    expect(summary.firstEntry).toBe('2026-03-15')
    expect(summary.lastEntry).toBe('2026-03-28')

    expect(unanimousRows.map(row => row.field)).toEqual(expect.arrayContaining([
      'coin',
      'interval',
      'strategyId',
      'setupVariant',
      'patternType',
      'confluenceGrade',
      'exitReason',
    ]))
    expect(majorityRows.map(row => row.field)).toEqual(expect.arrayContaining([
      'side',
      'regime',
    ]))
    expect(fingerprintRows.some(row => row.field === 'setupVariant' && row.value === '1h_same_tf' && row.count === 3 && row.total === 3)).toBe(true)

    const summaryText = formatTailClusterSummary(summary)
    const fingerprintText = formatTailClusterFingerprintTable(unanimousRows)
    const tradeText = formatTailClusterTradeTable(buildTailClusterTradeRows(windows))

    expect(summaryText).toContain('Trailing loss streak: 3')
    expect(fingerprintText).toContain('setupVariant')
    expect(fingerprintText).toContain('1h_same_tf')
    expect(tradeText).toContain('london-open')
    expect(tradeText).toContain('us-session')
    expect(tradeText).toContain('off-session')
  })
})
