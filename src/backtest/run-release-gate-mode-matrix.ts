/**
 * Scan-mode isolation matrix for the unattended-live release gate.
 *
 * Reuses the same fetched BTC/ETH/SOL dataset and compares several
 * disabledScanModes profiles side by side.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-mode-matrix.ts
 *
 * Env:
 *   RELEASE_GATE_MODE_MATRIX_COINS=BTC,ETH,SOL
 *   RELEASE_GATE_MODE_MATRIX_EXTENDED_HISTORY=1
 */

import type { CandleInterval } from '../types.js'
import {
  formatReleaseGateDiagnosticReport,
  formatReleaseGateModeMatrixTable,
  type ReleaseGateModeMatrixRow,
} from './report.js'
import {
  RELEASE_GATE_DEFAULT_COINS,
  fetchReleaseGateCandles,
  resolveReleaseGateCounts,
  runReleaseGateValidationOnCandles,
  writeReleaseGateResult,
} from './run-release-gate.js'
import { log } from '../lib/logger.js'

interface ModeProfile {
  label: string
  disabledScanModes: string[]
}

const DEFAULT_MODE_PROFILES: ModeProfile[] = [
  { label: 'all_modes', disabledScanModes: [] },
  { label: 'no_1h', disabledScanModes: ['1h_same_tf'] },
  { label: 'drilldown_only', disabledScanModes: ['1h_same_tf', '4h_poi'] },
  { label: '15m_only', disabledScanModes: ['1h_same_tf', '4h_poi', '5m_micro'] },
  { label: '5m_only', disabledScanModes: ['1h_same_tf', '4h_poi', '15m_drilldown'] },
  { label: '1h_only', disabledScanModes: ['15m_drilldown', '5m_micro', '4h_poi'] },
]

function resolveModeMatrixCoins(): string[] {
  return (process.env.RELEASE_GATE_MODE_MATRIX_COINS ?? RELEASE_GATE_DEFAULT_COINS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function resolveModeMatrixCounts(): Record<CandleInterval, number> {
  const original = process.env.RELEASE_GATE_EXTENDED_HISTORY
  const override = process.env.RELEASE_GATE_MODE_MATRIX_EXTENDED_HISTORY
  if (override != null) {
    process.env.RELEASE_GATE_EXTENDED_HISTORY = override
  }
  const counts = resolveReleaseGateCounts()
  if (original == null) delete process.env.RELEASE_GATE_EXTENDED_HISTORY
  else process.env.RELEASE_GATE_EXTENDED_HISTORY = original
  return counts
}

async function main() {
  const coins = resolveModeMatrixCoins()
  const counts = resolveModeMatrixCounts()

  console.log('='.repeat(76))
  console.log('  RELEASE GATE SCAN-MODE MATRIX')
  console.log(`  Coins: ${coins.join(', ')}`)
  console.log(`  Profiles: ${DEFAULT_MODE_PROFILES.map(profile => profile.label).join(', ')}`)
  console.log(`  History: ${counts['1h']} x 1h candles`)
  console.log('='.repeat(76))

  log.info('release-gate-mode-matrix', 'Fetching candles once for all mode profiles...')
  const allCandles = await fetchReleaseGateCandles(coins, counts)

  const rows: ReleaseGateModeMatrixRow[] = []
  const outputs: Array<{ label: string; path: string }> = []
  const diagnostics: string[] = []

  for (const profile of DEFAULT_MODE_PROFILES) {
    console.log(`\n--- ${profile.label} ---`)
    const output = runReleaseGateValidationOnCandles(allCandles, {
      coins,
      strategyParams: {},
      counts,
      disabledScanModes: profile.disabledScanModes,
    })

    rows.push({
      label: profile.label,
      disabledScanModes: profile.disabledScanModes,
      verdict: output.verdict,
      holdoutPf: output.holdout.oosMetrics.profitFactor,
      oosPf: output.oos.oosMetrics.profitFactor,
      holdoutTrades: output.holdout.oosMetrics.totalTrades,
      oosTrades: output.oos.oosMetrics.totalTrades,
      oosMaxDd: output.oos.oosMetrics.maxDrawdown,
    })

    const path = writeReleaseGateResult(output, `release-gate-mode-${profile.label}`)
    outputs.push({ label: profile.label, path })
    diagnostics.push(formatReleaseGateDiagnosticReport(profile.label, 'OOS', output.diagnostics.oos))
    diagnostics.push(formatReleaseGateDiagnosticReport(profile.label, 'Holdout', output.diagnostics.holdout))
    log.info('release-gate-mode-matrix', `${profile.label}: ${output.verdict} -> ${path}`)
  }

  console.log('\n' + '='.repeat(76))
  console.log('  RELEASE GATE SCAN-MODE SCORECARD')
  console.log('='.repeat(76))
  console.log(formatReleaseGateModeMatrixTable(rows))
  console.log('='.repeat(76))
  for (const output of outputs) {
    console.log(`  ${output.label}: ${output.path}`)
  }

  for (const diagnostic of diagnostics) {
    console.log('\n' + diagnostic)
  }

  process.exit(rows.some(row => row.verdict === 'PASS') ? 0 : 1)
}

main().catch(err => {
  log.error('release-gate-mode-matrix', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
