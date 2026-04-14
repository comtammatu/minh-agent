/**
 * Compare OOS vs holdout diagnostics from existing release-gate artifacts.
 *
 * Focuses on drift by bucket so we can see which coins/regimes/setup variants
 * look acceptable in OOS but collapse on the unseen holdout tail.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-holdout-drift.ts
 *
 * Env:
 *   RELEASE_GATE_DRIFT_PREFIXES=release-gate-1h-audit-no_btc_base,release-gate-1h-audit-eth_only_base
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ReleaseGateRunOutput } from './run-release-gate.js'
import {
  buildReleaseGateDriftRows,
  formatReleaseGateDriftTable,
} from './report.js'
import { log } from '../lib/logger.js'

const DEFAULT_PREFIXES = [
  'release-gate-1h-audit-no_btc_base',
  'release-gate-1h-audit-no_btc_higher_conf',
  'release-gate-1h-audit-no_btc_sideways_guard',
  'release-gate-1h-audit-eth_only_base',
]

function resolvePrefixes(): string[] {
  return (process.env.RELEASE_GATE_DRIFT_PREFIXES ?? DEFAULT_PREFIXES.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
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

function printDimensionReport(
  label: string,
  dimension: 'By coin' | 'By regime' | 'By setup type',
  oosRows: ReleaseGateRunOutput['diagnostics']['oos']['byCoin'],
  holdoutRows: ReleaseGateRunOutput['diagnostics']['holdout']['byCoin'],
): void {
  console.log('')
  console.log('='.repeat(78))
  console.log(`  HOLDOUT DRIFT | ${label} | ${dimension}`)
  console.log('='.repeat(78))
  console.log(formatReleaseGateDriftTable(buildReleaseGateDriftRows(oosRows, holdoutRows)))
}

function main() {
  const prefixes = resolvePrefixes()

  console.log('='.repeat(78))
  console.log('  RELEASE GATE HOLDOUT DRIFT')
  console.log(`  Prefixes: ${prefixes.join(', ')}`)
  console.log('='.repeat(78))

  for (const prefix of prefixes) {
    const path = findLatestResultPath(prefix)
    const artifact = loadArtifact(path)

    console.log('')
    console.log('-'.repeat(78))
    console.log(`  Artifact: ${path}`)
    console.log(`  Coins: ${artifact.coins.join(', ')}`)
    console.log(`  Params: ${JSON.stringify(artifact.strategyParams)}`)
    console.log(`  OOS PF: ${artifact.oos.oosMetrics.profitFactor.toFixed(2)} | Holdout PF: ${artifact.holdout.oosMetrics.profitFactor.toFixed(2)}`)
    console.log(`  OOS trades: ${artifact.oos.oosMetrics.totalTrades} | Holdout trades: ${artifact.holdout.oosMetrics.totalTrades}`)
    console.log('-'.repeat(78))

    printDimensionReport(prefix, 'By coin', artifact.diagnostics.oos.byCoin, artifact.diagnostics.holdout.byCoin)
    printDimensionReport(prefix, 'By regime', artifact.diagnostics.oos.byRegime, artifact.diagnostics.holdout.byRegime)
    printDimensionReport(prefix, 'By setup type', artifact.diagnostics.oos.bySetupVariant, artifact.diagnostics.holdout.bySetupVariant)

    log.info('release-gate-holdout-drift', `${prefix}: loaded ${path}`)
  }
}

try {
  main()
} catch (err) {
  log.error('release-gate-holdout-drift', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
