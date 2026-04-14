/**
 * Deep window/time drift report for ETH 1h artifacts.
 *
 * Reads an existing release-gate artifact and answers whether holdout failure
 * is concentrated in a few tail windows or reflects a broader shift in recent
 * window behavior.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-eth-window-drift.ts
 *
 * Env:
 *   RELEASE_GATE_ETH_WINDOW_PREFIX=release-gate-1h-audit-eth_only_base
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { WalkForwardWindow } from './types.js'
import type { ReleaseGateRunOutput } from './run-release-gate.js'
import {
  buildReleaseGateWindowRows,
  formatReleaseGateWindowTable,
} from './report.js'
import { log } from '../lib/logger.js'

interface WindowSummary {
  nonEmpty: number
  positive: number
  negative: number
  totalPnl: number
  longestNegativeStreak: number
  trailingNegativeStreak: number
}

const DEFAULT_PREFIX = 'release-gate-1h-audit-eth_only_base'

function resolvePrefix(): string {
  return process.env.RELEASE_GATE_ETH_WINDOW_PREFIX?.trim() || DEFAULT_PREFIX
}

function findLatestResultPath(prefix: string): string {
  const resultsDir = join(process.cwd(), 'results')
  const match = readdirSync(resultsDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .at(-1)

  if (!match) {
    throw new Error(`No result artifact found for prefix "${prefix}" in ${resultsDir}`)
  }

  return join(resultsDir, match)
}

function loadArtifact(path: string): ReleaseGateRunOutput {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseGateRunOutput
}

function buildWindowSummary(windows: WalkForwardWindow[]): WindowSummary {
  let positive = 0
  let negative = 0
  let totalPnl = 0
  let longestNegativeStreak = 0
  let trailingNegativeStreak = 0
  let currentNegativeStreak = 0

  for (const window of windows) {
    if (window.testMetrics.totalTrades === 0) continue
    totalPnl += window.testMetrics.netPnl
    if (window.testMetrics.netPnl < 0) {
      negative += 1
      currentNegativeStreak += 1
      if (currentNegativeStreak > longestNegativeStreak) longestNegativeStreak = currentNegativeStreak
    } else if (window.testMetrics.netPnl > 0) {
      positive += 1
      currentNegativeStreak = 0
    } else {
      currentNegativeStreak = 0
    }
  }

  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index]!
    if (window.testMetrics.totalTrades === 0) continue
    if (window.testMetrics.netPnl < 0) {
      trailingNegativeStreak += 1
      continue
    }
    break
  }

  return {
    nonEmpty: positive + negative,
    positive,
    negative,
    totalPnl,
    longestNegativeStreak,
    trailingNegativeStreak,
  }
}

interface HoldoutTradeRow {
  window: number
  windowStart: string
  entryDate: string
  exitDate: string
  side: string
  regime: string
  zone: string
  killzone: string
  pnl: number
}

function buildHoldoutTradeRows(windows: WalkForwardWindow[]): HoldoutTradeRow[] {
  return windows.flatMap(window =>
    (window.testTrades ?? []).map(trade => ({
      window: window.index,
      windowStart: fmtDate(window.testStart),
      entryDate: fmtDate(trade.entryTime),
      exitDate: fmtDate(trade.exitTime),
      side: trade.side,
      regime: trade.diagnostics?.regime ?? 'unknown',
      zone: trade.diagnostics?.zoneOrigin ?? 'unknown',
      killzone: trade.diagnostics?.killzoneName ?? 'unknown',
      pnl: trade.pnl,
    })),
  )
}

function formatHoldoutTradeTable(rows: HoldoutTradeRow[]): string {
  const tableRows = [
    ['Win', 'Start', 'Entry', 'Exit', 'Side', 'Regime', 'Zone', 'Killzone', 'PnL'],
    ...rows.map(row => [
      String(row.window),
      row.windowStart,
      row.entryDate,
      row.exitDate,
      row.side,
      row.regime,
      row.zone,
      row.killzone,
      `$${fmtNum(row.pnl)}`,
    ]),
  ]

  const widths = tableRows[0]!.map((_, col) =>
    Math.max(...tableRows.map(row => row[col]!.length)),
  )

  return tableRows.map((row, i) => {
    const cells = row.map((cell, col) =>
      col === 8 ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!),
    )
    const line = `  ${cells.join('  |  ')}`
    if (i === 0) return line + `\n  ${'-'.repeat(line.length - 2)}`
    return line
  }).join('\n')
}

function formatWindowSummary(label: string, summary: WindowSummary): string {
  return [
    `  ${label}:`,
    `  non-empty windows=${summary.nonEmpty}, positive=${summary.positive}, negative=${summary.negative}, totalPnL=$${fmtNum(summary.totalPnl)}`,
    `  longest negative streak=${summary.longestNegativeStreak}, trailing negative streak=${summary.trailingNegativeStreak}`,
  ].join('\n')
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return n > 0 ? 'Inf' : '-Inf'
  return n.toFixed(2)
}

function main() {
  const prefix = resolvePrefix()
  const path = findLatestResultPath(prefix)
  const artifact = loadArtifact(path)

  const oosRows = buildReleaseGateWindowRows(artifact.oos.windows)
  const holdoutRows = buildReleaseGateWindowRows(artifact.holdout.windows)
  const oosSummary = buildWindowSummary(artifact.oos.windows)
  const holdoutSummary = buildWindowSummary(artifact.holdout.windows)
  const holdoutTrades = buildHoldoutTradeRows(artifact.holdout.windows)

  console.log('='.repeat(78))
  console.log('  RELEASE GATE ETH WINDOW DRIFT')
  console.log(`  Artifact: ${path}`)
  console.log(`  Coins: ${artifact.coins.join(', ')}`)
  console.log(`  Params: ${JSON.stringify(artifact.strategyParams)}`)
  console.log(`  OOS PF: ${artifact.oos.oosMetrics.profitFactor.toFixed(2)} | Holdout PF: ${artifact.holdout.oosMetrics.profitFactor.toFixed(2)}`)
  console.log('='.repeat(78))
  console.log(formatWindowSummary('OOS window summary', oosSummary))
  console.log(formatWindowSummary('Holdout window summary', holdoutSummary))

  console.log('\n' + '='.repeat(78))
  console.log('  OOS NON-EMPTY WINDOWS')
  console.log('='.repeat(78))
  console.log(formatReleaseGateWindowTable(oosRows))

  console.log('\n' + '='.repeat(78))
  console.log('  HOLDOUT NON-EMPTY WINDOWS')
  console.log('='.repeat(78))
  console.log(formatReleaseGateWindowTable(holdoutRows))

  console.log('\n' + '='.repeat(78))
  console.log('  HOLDOUT TRADE LEDGER')
  console.log('='.repeat(78))
  console.log(formatHoldoutTradeTable(holdoutTrades))

  log.info('release-gate-eth-window-drift', `${prefix}: loaded ${path}`)
}

try {
  main()
} catch (err) {
  log.error('release-gate-eth-window-drift', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
