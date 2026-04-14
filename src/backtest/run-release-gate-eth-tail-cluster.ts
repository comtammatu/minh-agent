/**
 * Tail-cluster diagnostic for the ETH-only release-gate artifact.
 *
 * Loads the latest `release-gate-1h-audit-eth_only_base-*` artifact and
 * prints a fingerprint of the 4 holdout tail trades.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-eth-tail-cluster.ts
 *
 * Env:
 *   RELEASE_GATE_ETH_TAIL_PREFIX=release-gate-1h-audit-eth_only_base
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ReleaseGateRunOutput } from './run-release-gate.js'
import {
  buildTailClusterFingerprintRows,
  buildTailClusterSummary,
  buildTailClusterTradeRows,
  buildTailClusterUnanimousRows,
  buildTailClusterMajorityRows,
  collectTailClusterTrades,
  formatTailClusterFingerprintTable,
  formatTailClusterSummary,
  formatTailClusterTradeTable,
} from './tail-cluster.js'
import { log } from '../lib/logger.js'

const DEFAULT_PREFIX = 'release-gate-1h-audit-eth_only_base'

function resolvePrefix(): string {
  return process.env.RELEASE_GATE_ETH_TAIL_PREFIX?.trim() || DEFAULT_PREFIX
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

function printSection(title: string, body: string): void {
  console.log('')
  console.log('='.repeat(82))
  console.log(`  ${title}`)
  console.log('='.repeat(82))
  console.log(body)
}

function main() {
  const prefix = resolvePrefix()
  const path = findLatestResultPath(prefix)
  const artifact = loadArtifact(path)
  const trades = collectTailClusterTrades(artifact.holdout.windows)
  const summary = buildTailClusterSummary(trades)
  const tradeRows = buildTailClusterTradeRows(artifact.holdout.windows)
  const unanimousRows = buildTailClusterUnanimousRows(trades)
  const majorityRows = buildTailClusterMajorityRows(trades)
  const fingerprintRows = buildTailClusterFingerprintRows(trades)

  console.log('='.repeat(82))
  console.log('  RELEASE GATE ETH TAIL CLUSTER')
  console.log('='.repeat(82))
  console.log(`  Artifact: ${path}`)
  console.log(`  Coins: ${artifact.coins.join(', ')}`)
  console.log(`  Params: ${JSON.stringify(artifact.strategyParams)}`)
  console.log(`  Holdout PF: ${artifact.holdout.oosMetrics.profitFactor.toFixed(2)} | Holdout trades: ${trades.length}`)
  console.log(`  Windows covered: ${tradeRows.length > 0 ? `${tradeRows[0]!.window} -> ${tradeRows.at(-1)!.window}` : 'n/a'}`)

  printSection('TAIL CLUSTER SUMMARY', formatTailClusterSummary(summary))

  printSection(
    'UNANIMOUS FINGERPRINT',
    unanimousRows.length > 0
      ? formatTailClusterFingerprintTable(unanimousRows)
      : '  No unanimous fields found.',
  )

  printSection(
    'REPEATED SIGNALS',
    majorityRows.length > 0
      ? formatTailClusterFingerprintTable(majorityRows)
      : '  No repeated signals beyond the unanimous set.',
  )

  printSection('TRADE LEDGER', formatTailClusterTradeTable(tradeRows))

  if (fingerprintRows.length > 0) {
    log.info('release-gate-eth-tail-cluster', `${prefix}: fingerprint rows=${fingerprintRows.length}`)
  } else {
    log.info('release-gate-eth-tail-cluster', `${prefix}: no repeated fingerprint rows`)
  }
}

try {
  main()
} catch (err) {
  log.error('release-gate-eth-tail-cluster', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
