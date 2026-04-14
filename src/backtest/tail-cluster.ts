/**
 * Tail-cluster diagnostics for release-gate holdout artifacts.
 *
 * Focuses on a small set of trades that cluster at the tail of the holdout
 * slice and turns their metadata into a compact failure fingerprint.
 */

import type { BacktestTrade, WalkForwardWindow } from './types.js'

export interface TailClusterTradeRow {
  window: number
  windowStart: string
  entryDate: string
  entryHourUtc: string
  entryWeekdayUtc: string
  exitDate: string
  side: string
  patternType: string
  confluenceGrade: string
  strategyId: string
  setupVariant: string
  regime: string
  zoneOrigin: string
  killzoneName: string
  exitReason: string
  holdingBars: number
  pnl: number
}

export interface TailClusterFingerprintRow {
  field: string
  value: string
  count: number
  total: number
  share: number
}

export interface TailClusterSummary {
  totalTrades: number
  wins: number
  losses: number
  netPnl: number
  avgHoldingBars: number
  minHoldingBars: number
  maxHoldingBars: number
  firstEntry: string
  lastEntry: string
  trailingLossStreak: number
}

interface FingerprintBucket {
  field: string
  value: string
  count: number
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function collectTailClusterTrades(windows: WalkForwardWindow[]): BacktestTrade[] {
  return windows.flatMap(window => window.testTrades ?? [])
}

export function buildTailClusterTradeRows(windows: WalkForwardWindow[]): TailClusterTradeRow[] {
  return windows
    .flatMap(window =>
      (window.testTrades ?? []).map(trade => ({
        window: window.index,
        windowStart: fmtDate(window.testStart),
        entryDate: fmtDate(trade.entryTime),
        entryHourUtc: fmtHour(trade.entryTime),
        entryWeekdayUtc: fmtWeekday(trade.entryTime),
        exitDate: fmtDate(trade.exitTime),
        side: trade.side,
        patternType: trade.patternType,
        confluenceGrade: trade.confluenceGrade ?? 'unknown',
        strategyId: trade.strategyId ?? 'unknown',
        setupVariant: trade.diagnostics?.setupVariant ?? 'unknown',
        regime: trade.diagnostics?.regime ?? 'unknown',
        zoneOrigin: trade.diagnostics?.zoneOrigin ?? 'unknown',
        killzoneName: trade.diagnostics?.killzoneName ?? 'unknown',
        exitReason: trade.exitReason,
        holdingBars: trade.holdingBars,
        pnl: trade.pnl,
      })),
    )
    .sort((a, b) => {
      if (a.window !== b.window) return a.window - b.window
      if (a.entryDate !== b.entryDate) return a.entryDate.localeCompare(b.entryDate)
      return a.exitDate.localeCompare(b.exitDate)
    })
}

export function buildTailClusterSummary(trades: BacktestTrade[]): TailClusterSummary {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
      avgHoldingBars: 0,
      minHoldingBars: 0,
      maxHoldingBars: 0,
      firstEntry: 'n/a',
      lastEntry: 'n/a',
      trailingLossStreak: 0,
    }
  }

  let wins = 0
  let losses = 0
  let netPnl = 0
  let holdingBarsTotal = 0
  let minHoldingBars = Number.POSITIVE_INFINITY
  let maxHoldingBars = 0

  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime)
  for (const trade of sorted) {
    netPnl += trade.pnl
    holdingBarsTotal += trade.holdingBars
    if (trade.pnl > 0) wins += 1
    else losses += 1
    if (trade.holdingBars < minHoldingBars) minHoldingBars = trade.holdingBars
    if (trade.holdingBars > maxHoldingBars) maxHoldingBars = trade.holdingBars
  }

  let trailingLossStreak = 0
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]!.pnl < 0) {
      trailingLossStreak += 1
      continue
    }
    break
  }

  return {
    totalTrades: sorted.length,
    wins,
    losses,
    netPnl,
    avgHoldingBars: holdingBarsTotal / sorted.length,
    minHoldingBars,
    maxHoldingBars,
    firstEntry: fmtDate(sorted[0]!.entryTime),
    lastEntry: fmtDate(sorted.at(-1)!.entryTime),
    trailingLossStreak,
  }
}

export function buildTailClusterFingerprintRows(trades: BacktestTrade[]): TailClusterFingerprintRow[] {
  const total = trades.length
  if (total === 0) return []

  const buckets = new Map<string, FingerprintBucket>()
  for (const trade of trades) {
    for (const [field, value] of enumerateFingerprintFields(trade)) {
      const key = `${field}\u0000${value}`
      const bucket = buckets.get(key)
      if (bucket === undefined) {
        buckets.set(key, { field, value, count: 1 })
      } else {
        bucket.count += 1
      }
    }
  }

  return [...buckets.values()]
    .filter(bucket => bucket.count > 1)
    .map(bucket => ({
      field: bucket.field,
      value: bucket.value,
      count: bucket.count,
      total,
      share: bucket.count / total,
    }))
    .sort((a, b) => {
      if (a.share !== b.share) return b.share - a.share
      if (a.field !== b.field) return a.field.localeCompare(b.field)
      return a.value.localeCompare(b.value)
    })
}

export function buildTailClusterUnanimousRows(trades: BacktestTrade[]): TailClusterFingerprintRow[] {
  return buildTailClusterFingerprintRows(trades).filter(row => row.count === row.total)
}

export function buildTailClusterMajorityRows(trades: BacktestTrade[]): TailClusterFingerprintRow[] {
  return buildTailClusterFingerprintRows(trades).filter(row => row.count < row.total)
}

export function formatTailClusterTradeTable(rows: TailClusterTradeRow[]): string {
  const tableRows = [
    ['Win', 'Start', 'Entry', 'Entry Hr', 'DOW', 'Exit', 'Side', 'Pattern', 'Grade', 'Strategy', 'Setup', 'Regime', 'Zone', 'Killzone', 'Exit', 'Hold', 'PnL'],
    ...rows.map(row => [
      String(row.window),
      row.windowStart,
      row.entryDate,
      row.entryHourUtc,
      row.entryWeekdayUtc,
      row.exitDate,
      row.side,
      row.patternType,
      row.confluenceGrade,
      row.strategyId,
      row.setupVariant,
      row.regime,
      row.zoneOrigin,
      row.killzoneName,
      row.exitReason,
      String(row.holdingBars),
      `$${fmtNum(row.pnl)}`,
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 15 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

export function formatTailClusterSummary(summary: TailClusterSummary): string {
  return [
    `  Trades: ${summary.totalTrades} | Wins: ${summary.wins} | Losses: ${summary.losses} | Net PnL: $${fmtNum(summary.netPnl)}`,
    `  Avg hold: ${fmtNum(summary.avgHoldingBars)} bars | Range: ${summary.minHoldingBars}..${summary.maxHoldingBars} bars`,
    `  Entries: ${summary.firstEntry} -> ${summary.lastEntry} | Trailing loss streak: ${summary.trailingLossStreak}`,
  ].join('\n')
}

export function formatTailClusterFingerprintTable(rows: TailClusterFingerprintRow[]): string {
  const tableRows = [
    ['Field', 'Value', 'Count', 'Share'],
    ...rows.map(row => [
      row.field,
      row.value,
      `${row.count}/${row.total}`,
      `${(row.share * 100).toFixed(0)}%`,
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col >= 2 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

function enumerateFingerprintFields(trade: BacktestTrade): Array<[string, string]> {
  return [
    ['coin', trade.coin],
    ['interval', trade.interval],
    ['strategyId', trade.strategyId ?? 'unknown'],
    ['setupVariant', trade.diagnostics?.setupVariant ?? 'unknown'],
    ['patternType', trade.patternType],
    ['confluenceGrade', trade.confluenceGrade ?? 'unknown'],
    ['exitReason', trade.exitReason],
    ['side', trade.side],
    ['regime', trade.diagnostics?.regime ?? 'unknown'],
    ['zoneOrigin', trade.diagnostics?.zoneOrigin ?? 'unknown'],
    ['killzoneName', trade.diagnostics?.killzoneName ?? 'unknown'],
    ['entryHourUtc', fmtHour(trade.entryTime)],
    ['entryWeekdayUtc', fmtWeekday(trade.entryTime)],
  ]
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function fmtHour(ms: number): string {
  return `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00Z`
}

function fmtWeekday(ms: number): string {
  return WEEKDAY_LABELS[new Date(ms).getUTCDay()]!
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return n > 0 ? 'Inf' : '-Inf'
  return n.toFixed(2)
}
