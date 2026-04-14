/**
 * Expectancy report formatter — plain text summary for console/log.
 *
 * Takes WalkForwardResult and produces a readable report with:
 *   - Per-window train vs test metrics
 *   - Aggregated OOS vs IS comparison
 *   - Overfit detection flag
 *   - Pass/fail gate verdict
 *
 * Pure function, zero I/O.
 *
 * Sprint 3 S4.
 */

import type {
  BacktestMetrics,
  BacktestTrade,
  StrategyParams,
  WalkForwardResult,
  WalkForwardWindow,
} from './types.js'
import {
  WF_OVERFIT_THRESHOLD,
  RELEASE_GATE_HOLDOUT_MIN_PF,
  RELEASE_GATE_OOS_MIN_PF,
  RELEASE_GATE_HOLDOUT_MIN_TRADES,
  RELEASE_GATE_OOS_MIN_TRADES,
  RELEASE_GATE_OOS_MAX_DD,
} from '../config.js'

/**
 * Format a walk-forward result into a readable text report.
 */
export function formatExpectancyReport(result: WalkForwardResult): string {
  const lines: string[] = []

  lines.push('=' .repeat(60))
  lines.push('  WALK-FORWARD VALIDATION REPORT')
  lines.push('=' .repeat(60))
  lines.push('')

  // Gate verdict (top of report for quick scanning)
  if (result.windows.length === 0) {
    lines.push('  VERDICT: INSUFFICIENT DATA')
    lines.push('  Not enough data for minimum number of walk-forward windows.')
    lines.push('=' .repeat(60))
    return lines.join('\n')
  }

  const verdict = result.passesGate ? 'PASS' : 'FAIL'
  const verdictSymbol = result.passesGate ? '[+]' : '[-]'
  lines.push(`  ${verdictSymbol} VERDICT: ${verdict}`)
  lines.push(`  OOS Expectancy: $${fmtNum(result.oosMetrics.expectancy)} per trade`)

  if (result.overfitRatio > WF_OVERFIT_THRESHOLD) {
    lines.push(`  [!] OVERFIT WARNING: IS/OOS ratio = ${fmtNum(result.overfitRatio)}x (threshold: ${WF_OVERFIT_THRESHOLD}x)`)
  }

  lines.push('')
  lines.push('-' .repeat(60))

  // Summary table: IS vs OOS
  lines.push('  IN-SAMPLE vs OUT-OF-SAMPLE SUMMARY')
  lines.push('-' .repeat(60))
  lines.push(formatComparisonTable(result.isMetrics, result.oosMetrics))

  lines.push('')
  lines.push('-' .repeat(60))

  // Per-window breakdown
  lines.push('  PER-WINDOW BREAKDOWN')
  lines.push('-' .repeat(60))

  for (const w of result.windows) {
    lines.push(formatWindowRow(w))
  }

  lines.push('')
  lines.push('=' .repeat(60))

  return lines.join('\n')
}

/**
 * Format a single BacktestMetrics into a concise one-line summary.
 */
export function formatMetricsSummary(m: BacktestMetrics, label?: string): string {
  const prefix = label ? `[${label}] ` : ''
  return `${prefix}Trades: ${m.totalTrades} | WR: ${pct(m.winRate)} | PnL: $${fmtNum(m.netPnl)} | Exp: $${fmtNum(m.expectancy)} | Sharpe: ${fmtNum(m.sharpeRatio)} | MaxDD: ${pct(m.maxDrawdown)} | PF: ${fmtNum(m.profitFactor)}`
}

export interface ReleaseGateValidationInput {
  coins: string[]
  strategyParams: StrategyParams
  oos: WalkForwardResult
  holdout: WalkForwardResult
}

export interface ReleaseGateScorecard {
  holdoutPf: boolean
  oosPf: boolean
  holdoutTrades: boolean
  oosTrades: boolean
  oosMaxDd: boolean
}

export interface ReleaseGateBatchRow {
  label: string
  strategyParams: StrategyParams
  verdict: 'PASS' | 'NO-GO'
  holdoutPf: number
  oosPf: number
  holdoutTrades: number
  oosTrades: number
  oosMaxDd: number
}

export interface ReleaseGateModeMatrixRow {
  label: string
  disabledScanModes: string[]
  verdict: 'PASS' | 'NO-GO'
  holdoutPf: number
  oosPf: number
  holdoutTrades: number
  oosTrades: number
  oosMaxDd: number
}

export interface ReleaseGate1hAuditRow {
  label: string
  coins: string[]
  strategyParams: StrategyParams
  verdict: 'PASS' | 'NO-GO'
  holdoutPf: number
  oosPf: number
  holdoutTrades: number
  oosTrades: number
  oosMaxDd: number
}

export interface ReleaseGateDiagnosticRow {
  bucket: string
  trades: number
  winRate: number
  netPnl: number
  expectancy: number
  profitFactor: number
}

export interface ReleaseGateDiagnosticSummary {
  totalTrades: number
  byCoin: ReleaseGateDiagnosticRow[]
  byTimeframe: ReleaseGateDiagnosticRow[]
  byRegime: ReleaseGateDiagnosticRow[]
  bySetupVariant: ReleaseGateDiagnosticRow[]
}

export interface ReleaseGateDriftRow {
  bucket: string
  oosTrades: number
  oosPf: number
  oosPnl: number
  holdoutTrades: number
  holdoutPf: number
  holdoutPnl: number
  pfDelta: number
  pnlDelta: number
}

export interface ReleaseGateWindowRow {
  index: number
  start: string
  end: string
  trades: number
  winRate: number
  pnl: number
  profitFactor: number
}

export function evaluateReleaseGateScorecard(input: ReleaseGateValidationInput): ReleaseGateScorecard {
  return {
    holdoutPf: input.holdout.oosMetrics.profitFactor > RELEASE_GATE_HOLDOUT_MIN_PF,
    oosPf: input.oos.oosMetrics.profitFactor > RELEASE_GATE_OOS_MIN_PF,
    holdoutTrades: input.holdout.oosMetrics.totalTrades >= RELEASE_GATE_HOLDOUT_MIN_TRADES,
    oosTrades: input.oos.oosMetrics.totalTrades >= RELEASE_GATE_OOS_MIN_TRADES,
    oosMaxDd: input.oos.oosMetrics.maxDrawdown < RELEASE_GATE_OOS_MAX_DD,
  }
}

export function formatReleaseGateValidationReport(input: ReleaseGateValidationInput): string {
  const scorecard = evaluateReleaseGateScorecard(input)
  const overallPass = Object.values(scorecard).every(Boolean)
  const pass = (value: boolean) => value ? 'PASS' : 'FAIL'
  const paramsLabel = Object.keys(input.strategyParams).length > 0
    ? JSON.stringify(input.strategyParams)
    : '{}'

  const lines: string[] = []
  lines.push('='.repeat(68))
  lines.push('  UNATTENDED-LIVE RELEASE GATE VALIDATION')
  lines.push('='.repeat(68))
  lines.push(`  Coins: ${input.coins.join(', ')}`)
  lines.push(`  Params: ${paramsLabel}`)
  lines.push(`  Verdict: ${overallPass ? 'PASS' : 'NO-GO'}`)
  lines.push('')
  lines.push('  SCORECARD')
  lines.push(`  [${pass(scorecard.holdoutPf)}] Holdout PF: ${fmtNum(input.holdout.oosMetrics.profitFactor)} (need > ${RELEASE_GATE_HOLDOUT_MIN_PF.toFixed(2)})`)
  lines.push(`  [${pass(scorecard.oosPf)}] OOS PF: ${fmtNum(input.oos.oosMetrics.profitFactor)} (need > ${RELEASE_GATE_OOS_MIN_PF.toFixed(2)})`)
  lines.push(`  [${pass(scorecard.holdoutTrades)}] Holdout trades: ${input.holdout.oosMetrics.totalTrades} (need >= ${RELEASE_GATE_HOLDOUT_MIN_TRADES})`)
  lines.push(`  [${pass(scorecard.oosTrades)}] OOS trades: ${input.oos.oosMetrics.totalTrades} (need >= ${RELEASE_GATE_OOS_MIN_TRADES})`)
  lines.push(`  [${pass(scorecard.oosMaxDd)}] OOS MaxDD: ${pct(input.oos.oosMetrics.maxDrawdown)} (need < ${pct(RELEASE_GATE_OOS_MAX_DD)})`)
  lines.push('')
  lines.push('  OOS WFA')
  lines.push(`  ${formatMetricsSummary(input.oos.oosMetrics, 'OOS')}`)
  lines.push(`  ${formatMetricsSummary(input.oos.isMetrics, 'IS')}`)
  lines.push('')
  lines.push('  HOLDOUT WFA')
  lines.push(`  ${formatMetricsSummary(input.holdout.oosMetrics, 'Holdout OOS')}`)
  lines.push(`  ${formatMetricsSummary(input.holdout.isMetrics, 'Holdout IS')}`)
  lines.push('')
  lines.push('  Statistical gates')
  lines.push(`  OOS WFA gate: ${input.oos.passesGate ? 'PASS' : 'FAIL'}`)
  lines.push(`  Holdout WFA gate: ${input.holdout.passesGate ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('  Interpretation')
  lines.push(`  - Treat OOS as walk-forward on the train slice and holdout as walk-forward on the unseen 20% tail.`)
  lines.push(`  - A single failing scorecard row keeps unattended live at NO-GO.`)
  lines.push('='.repeat(68))
  return lines.join('\n')
}

export function formatReleaseGateBatchTable(rows: ReleaseGateBatchRow[]): string {
  const paramLabel = (params: StrategyParams) =>
    Object.keys(params).length > 0 ? JSON.stringify(params) : '{}'

  const tableRows = [
    ['Label', 'Verdict', 'Hold PF', 'OOS PF', 'Hold #', 'OOS #', 'OOS DD%', 'Params'],
    ...rows.map(row => [
      row.label,
      row.verdict,
      fmtNum(row.holdoutPf),
      fmtNum(row.oosPf),
      String(row.holdoutTrades),
      String(row.oosTrades),
      (row.oosMaxDd * 100).toFixed(1),
      paramLabel(row.strategyParams),
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 2 && col <= 6 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

export function formatReleaseGateModeMatrixTable(rows: ReleaseGateModeMatrixRow[]): string {
  const modeLabel = (disabledScanModes: string[]) =>
    disabledScanModes.length > 0 ? disabledScanModes.join(',') : '(none)'

  const tableRows = [
    ['Label', 'Verdict', 'Hold PF', 'OOS PF', 'Hold #', 'OOS #', 'OOS DD%', 'Disabled modes'],
    ...rows.map(row => [
      row.label,
      row.verdict,
      fmtNum(row.holdoutPf),
      fmtNum(row.oosPf),
      String(row.holdoutTrades),
      String(row.oosTrades),
      (row.oosMaxDd * 100).toFixed(1),
      modeLabel(row.disabledScanModes),
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 2 && col <= 6 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

export function formatReleaseGate1hAuditTable(rows: ReleaseGate1hAuditRow[]): string {
  const coinLabel = (coins: string[]) => coins.join(',')
  const paramLabel = (params: StrategyParams) =>
    Object.keys(params).length > 0 ? JSON.stringify(params) : '{}'

  const tableRows = [
    ['Label', 'Coins', 'Verdict', 'Hold PF', 'OOS PF', 'Hold #', 'OOS #', 'OOS DD%', 'Params'],
    ...rows.map(row => [
      row.label,
      coinLabel(row.coins),
      row.verdict,
      fmtNum(row.holdoutPf),
      fmtNum(row.oosPf),
      String(row.holdoutTrades),
      String(row.oosTrades),
      (row.oosMaxDd * 100).toFixed(1),
      paramLabel(row.strategyParams),
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 3 && col <= 7 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

export function collectWalkForwardTrades(result: WalkForwardResult): BacktestTrade[] {
  return result.windows.flatMap(window => window.testTrades ?? [])
}

export function buildReleaseGateDiagnosticSummary(
  trades: BacktestTrade[],
  _initialCapital: number,
): ReleaseGateDiagnosticSummary {
  return {
    totalTrades: trades.length,
    byCoin: buildDiagnosticRows(trades, trade => trade.coin),
    byTimeframe: buildDiagnosticRows(trades, trade => trade.interval),
    byRegime: buildDiagnosticRows(trades, trade => trade.diagnostics?.regime ?? 'unknown'),
    bySetupVariant: buildDiagnosticRows(trades, trade => trade.diagnostics?.setupVariant ?? 'unknown'),
  }
}

export function formatReleaseGateDiagnosticReport(
  label: string,
  scope: 'OOS' | 'Holdout',
  summary: ReleaseGateDiagnosticSummary,
): string {
  const lines: string[] = []
  lines.push('='.repeat(72))
  lines.push(`  RELEASE GATE DIAGNOSTICS | ${label} | ${scope}`)
  lines.push('='.repeat(72))
  lines.push(`  Trades: ${summary.totalTrades}`)

  if (summary.totalTrades === 0) {
    lines.push('  No trades in this slice.')
    lines.push('='.repeat(72))
    return lines.join('\n')
  }

  lines.push('')
  lines.push('  By coin')
  lines.push(formatDiagnosticTable(summary.byCoin))
  lines.push('')
  lines.push('  By timeframe')
  lines.push(formatDiagnosticTable(summary.byTimeframe))
  lines.push('')
  lines.push('  By regime')
  lines.push(formatDiagnosticTable(summary.byRegime))
  lines.push('')
  lines.push('  By setup type')
  lines.push(formatDiagnosticTable(summary.bySetupVariant))
  lines.push('='.repeat(72))
  return lines.join('\n')
}

export function buildReleaseGateDriftRows(
  oosRows: ReleaseGateDiagnosticRow[],
  holdoutRows: ReleaseGateDiagnosticRow[],
): ReleaseGateDriftRow[] {
  const buckets = new Set<string>()
  for (const row of oosRows) buckets.add(row.bucket)
  for (const row of holdoutRows) buckets.add(row.bucket)

  const oosByBucket = new Map(oosRows.map(row => [row.bucket, row] as const))
  const holdoutByBucket = new Map(holdoutRows.map(row => [row.bucket, row] as const))

  return [...buckets]
    .map(bucket => {
      const oos = oosByBucket.get(bucket)
      const holdout = holdoutByBucket.get(bucket)
      const oosPf = normalizeSerializedProfitFactor(oos?.profitFactor, oos?.trades ?? 0, oos?.netPnl ?? 0)
      const holdoutPf = normalizeSerializedProfitFactor(holdout?.profitFactor, holdout?.trades ?? 0, holdout?.netPnl ?? 0)
      const oosPnl = oos?.netPnl ?? 0
      const holdoutPnl = holdout?.netPnl ?? 0
      return {
        bucket,
        oosTrades: oos?.trades ?? 0,
        oosPf,
        oosPnl,
        holdoutTrades: holdout?.trades ?? 0,
        holdoutPf,
        holdoutPnl,
        pfDelta: holdoutPf - oosPf,
        pnlDelta: holdoutPnl - oosPnl,
      }
    })
    .sort((a, b) => {
      if (a.pfDelta !== b.pfDelta) return a.pfDelta - b.pfDelta
      if (a.pnlDelta !== b.pnlDelta) return a.pnlDelta - b.pnlDelta
      return a.bucket.localeCompare(b.bucket)
    })
}

export function formatReleaseGateDriftTable(rows: ReleaseGateDriftRow[]): string {
  const tableRows = [
    ['Bucket', 'OOS #', 'OOS PF', 'OOS PnL', 'Hold #', 'Hold PF', 'Hold PnL', 'dPF', 'dPnL'],
    ...rows.map(row => [
      row.bucket,
      String(row.oosTrades),
      fmtNum(row.oosPf),
      `$${fmtNum(row.oosPnl)}`,
      String(row.holdoutTrades),
      fmtNum(row.holdoutPf),
      `$${fmtNum(row.holdoutPnl)}`,
      fmtSigned(row.pfDelta),
      `$${fmtSigned(row.pnlDelta)}`,
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

export function buildReleaseGateWindowRows(windows: WalkForwardWindow[]): ReleaseGateWindowRow[] {
  return windows
    .filter(window => window.testMetrics.totalTrades > 0)
    .map(window => ({
      index: window.index,
      start: fmtDate(window.testStart),
      end: fmtDate(window.testEnd),
      trades: window.testMetrics.totalTrades,
      winRate: window.testMetrics.winRate,
      pnl: window.testMetrics.netPnl,
      profitFactor: normalizeSerializedProfitFactor(
        window.testMetrics.profitFactor,
        window.testMetrics.totalTrades,
        window.testMetrics.netPnl,
      ),
    }))
}

export function formatReleaseGateWindowTable(rows: ReleaseGateWindowRow[]): string {
  const tableRows = [
    ['Win', 'Start', 'End', 'Trades', 'WR', 'PnL', 'PF'],
    ...rows.map(row => [
      String(row.index),
      row.start,
      row.end,
      String(row.trades),
      pct(row.winRate),
      `$${fmtNum(row.pnl)}`,
      fmtNum(row.profitFactor),
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 3 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

// ─── Internal ──────────────────────────────────────────────────────────────

function buildDiagnosticRows(
  trades: BacktestTrade[],
  groupBy: (trade: BacktestTrade) => string,
): ReleaseGateDiagnosticRow[] {
  const grouped = new Map<string, BacktestTrade[]>()

  for (const trade of trades) {
    const bucket = groupBy(trade)
    const entry = grouped.get(bucket) ?? []
    entry.push(trade)
    grouped.set(bucket, entry)
  }

  return Array.from(grouped.entries())
    .map(([bucket, bucketTrades]) => {
      const metrics = computeBucketMetrics(bucketTrades)
      return {
        bucket,
        trades: bucketTrades.length,
        winRate: metrics.winRate,
        netPnl: metrics.netPnl,
        expectancy: metrics.expectancy,
        profitFactor: metrics.profitFactor,
      }
    })
    .sort((a, b) => {
      if (a.netPnl !== b.netPnl) return a.netPnl - b.netPnl
      if (a.expectancy !== b.expectancy) return a.expectancy - b.expectancy
      return b.trades - a.trades
    })
}

function computeBucketMetrics(
  trades: BacktestTrade[],
): Pick<BacktestMetrics, 'winRate' | 'netPnl' | 'expectancy' | 'profitFactor'> {
  if (trades.length === 0) {
    return { winRate: 0, netPnl: 0, expectancy: 0, profitFactor: 0 }
  }

  const wins = trades.filter(trade => trade.pnl > 0)
  const losses = trades.filter(trade => trade.pnl <= 0)
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0)
  const grossLoss = losses.reduce((sum, trade) => sum + trade.pnl, 0)
  const netPnl = grossProfit + grossLoss
  const winRate = wins.length / trades.length
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(grossLoss) / losses.length : 0
  const lossRate = 1 - winRate
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss)
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? Infinity : 0)
    : grossProfit / Math.abs(grossLoss)

  return { winRate, netPnl, expectancy, profitFactor }
}

function formatDiagnosticTable(rows: ReleaseGateDiagnosticRow[]): string {
  const tableRows = [
    ['Bucket', 'Trades', 'WR', 'PnL', 'Exp', 'PF'],
    ...rows.map(row => [
      row.bucket,
      String(row.trades),
      pct(row.winRate),
      `$${fmtNum(row.netPnl)}`,
      `$${fmtNum(row.expectancy)}`,
      fmtNum(row.profitFactor),
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

function formatComparisonTable(is: BacktestMetrics, oos: BacktestMetrics): string {
  const rows = [
    ['Metric',         'In-Sample',              'Out-of-Sample',            'Delta'],
    ['Trades',         `${is.totalTrades}`,       `${oos.totalTrades}`,       `${oos.totalTrades - is.totalTrades}`],
    ['Win Rate',       pct(is.winRate),            pct(oos.winRate),           delta(oos.winRate - is.winRate, true)],
    ['Net PnL',        `$${fmtNum(is.netPnl)}`,   `$${fmtNum(oos.netPnl)}`,  `$${fmtNum(oos.netPnl - is.netPnl)}`],
    ['Expectancy',     `$${fmtNum(is.expectancy)}`,`$${fmtNum(oos.expectancy)}`, `$${fmtNum(oos.expectancy - is.expectancy)}`],
    ['Profit Factor',  fmtNum(is.profitFactor),    fmtNum(oos.profitFactor),  fmtNum(oos.profitFactor - is.profitFactor)],
    ['Sharpe',         fmtNum(is.sharpeRatio),     fmtNum(oos.sharpeRatio),   fmtNum(oos.sharpeRatio - is.sharpeRatio)],
    ['Sortino',        fmtNum(is.sortinoRatio),    fmtNum(oos.sortinoRatio),  fmtNum(oos.sortinoRatio - is.sortinoRatio)],
    ['Max Drawdown',   pct(is.maxDrawdown),        pct(oos.maxDrawdown),      delta(oos.maxDrawdown - is.maxDrawdown, true)],
    ['Avg R:R',        fmtNum(is.avgRR),           fmtNum(oos.avgRR),         fmtNum(oos.avgRR - is.avgRR)],
    ['Avg Hold (bars)',fmtNum(is.avgHoldingBars),   fmtNum(oos.avgHoldingBars), fmtNum(oos.avgHoldingBars - is.avgHoldingBars)],
  ]

  // Compute column widths
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map(r => r[col]!.length))
  )

  return rows.map((row, i) => {
    const cells = row.map((cell, col) => cell.padStart(widths[col]!))
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + '\n  ' + '-'.repeat(line.length - 2)
    return line
  }).join('\n')
}

function formatWindowRow(w: WalkForwardWindow): string {
  const trainRange = `${fmtDate(w.trainStart)}→${fmtDate(w.trainEnd)}`
  const testRange = `${fmtDate(w.testStart)}→${fmtDate(w.testEnd)}`
  const trainSummary = `T:${w.trainMetrics.totalTrades} WR:${pct(w.trainMetrics.winRate)} Exp:$${fmtNum(w.trainMetrics.expectancy)}`
  const testSummary = `T:${w.testMetrics.totalTrades} WR:${pct(w.testMetrics.winRate)} Exp:$${fmtNum(w.testMetrics.expectancy)}`

  return `  W${w.index} Train[${trainRange}] ${trainSummary}\n     Test [${testRange}] ${testSummary}`
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return n > 0 ? 'Inf' : '-Inf'
  return n.toFixed(2)
}

function normalizeSerializedProfitFactor(
  value: number | null | undefined,
  trades: number,
  netPnl: number,
): number {
  if (typeof value === 'number') return value
  if (trades === 0) return 0
  return netPnl > 0 ? Infinity : 0
}

function pct(n: number): string {
  if (!isFinite(n)) return 'Inf%'
  return `${(n * 100).toFixed(1)}%`
}

function delta(n: number, asPct: boolean): string {
  const formatted = asPct ? pct(n) : fmtNum(n)
  return n >= 0 ? `+${formatted}` : formatted
}

function fmtSigned(n: number): string {
  if (!isFinite(n)) return n > 0 ? '+Inf' : n < 0 ? '-Inf' : '0.00'
  return `${n >= 0 ? '+' : '-'}${fmtNum(Math.abs(n))}`
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
