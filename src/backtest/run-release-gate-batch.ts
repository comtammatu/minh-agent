/**
 * Batch compare several fixed BTC/ETH/SOL configurations against the same
 * unattended-live release gate.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-batch.ts
 *
 * Env:
 *   RELEASE_GATE_BATCH_COINS=BTC,ETH,SOL
 *   RELEASE_GATE_BATCH_EXTENDED_HISTORY=1
 *   RELEASE_GATE_BATCH_CONFIGS='[{"label":"default","params":{}},{"label":"rr2","params":{"SMC_MIN_RR":2}}]'
 */

import type { CandleInterval } from '../types.js'
import type { StrategyParams } from './types.js'
import {
  formatReleaseGateBatchTable,
  formatReleaseGateDiagnosticReport,
  type ReleaseGateBatchRow,
} from './report.js'
import {
  RELEASE_GATE_DEFAULT_COINS,
  resolveReleaseGateCounts,
  runReleaseGateValidation,
  writeReleaseGateResult,
} from './run-release-gate.js'
import { log } from '../lib/logger.js'

interface BatchCandidate {
  label: string
  params: StrategyParams
}

const DEFAULT_BATCH_CONFIGS: BatchCandidate[] = [
  { label: 'default', params: {} },
  { label: 'rr2', params: { SMC_MIN_RR: 2 } },
  {
    label: 'day8_style',
    params: {
      MIN_CONFIDENCE: 0.7,
      SL_WICK_ATR_MULT: 0.6,
      SMC_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SMC_MIN_RR: 2,
    },
  },
]

function resolveBatchCoins(): string[] {
  return (process.env.RELEASE_GATE_BATCH_COINS ?? RELEASE_GATE_DEFAULT_COINS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function resolveBatchCounts(): Record<CandleInterval, number> {
  const original = process.env.RELEASE_GATE_EXTENDED_HISTORY
  const batchOverride = process.env.RELEASE_GATE_BATCH_EXTENDED_HISTORY
  if (batchOverride != null) {
    process.env.RELEASE_GATE_EXTENDED_HISTORY = batchOverride
  }
  const counts = resolveReleaseGateCounts()
  if (original == null) delete process.env.RELEASE_GATE_EXTENDED_HISTORY
  else process.env.RELEASE_GATE_EXTENDED_HISTORY = original
  return counts
}

function resolveBatchConfigs(): BatchCandidate[] {
  const raw = process.env.RELEASE_GATE_BATCH_CONFIGS?.trim()
  if (!raw) return DEFAULT_BATCH_CONFIGS
  try {
    const parsed = JSON.parse(raw) as Array<{ label?: string; params?: StrategyParams }>
    return parsed
      .filter(item => item.label != null)
      .map(item => ({
        label: item.label!,
        params: item.params ?? {},
      }))
  } catch {
    log.error('release-gate-batch', 'RELEASE_GATE_BATCH_CONFIGS must be valid JSON array')
    process.exit(1)
  }
}

async function main() {
  const coins = resolveBatchCoins()
  const counts = resolveBatchCounts()
  const configs = resolveBatchConfigs()

  console.log('='.repeat(72))
  console.log('  RELEASE GATE BATCH COMPARE')
  console.log(`  Coins: ${coins.join(', ')}`)
  console.log(`  Configs: ${configs.map(c => c.label).join(', ')}`)
  console.log(`  History: ${counts['1h']} x 1h candles`)
  console.log('='.repeat(72))

  const rows: ReleaseGateBatchRow[] = []
  const outputs: Array<{ label: string; path: string }> = []
  const diagnostics: string[] = []

  for (const config of configs) {
    console.log(`\n--- ${config.label} ---`)
    const output = await runReleaseGateValidation({
      coins,
      strategyParams: config.params,
      counts,
    })
    rows.push({
      label: config.label,
      strategyParams: config.params,
      verdict: output.verdict,
      holdoutPf: output.holdout.oosMetrics.profitFactor,
      oosPf: output.oos.oosMetrics.profitFactor,
      holdoutTrades: output.holdout.oosMetrics.totalTrades,
      oosTrades: output.oos.oosMetrics.totalTrades,
      oosMaxDd: output.oos.oosMetrics.maxDrawdown,
    })
    const path = writeReleaseGateResult(output, `release-gate-${config.label}`)
    outputs.push({ label: config.label, path })
    diagnostics.push(formatReleaseGateDiagnosticReport(config.label, 'OOS', output.diagnostics.oos))
    diagnostics.push(formatReleaseGateDiagnosticReport(config.label, 'Holdout', output.diagnostics.holdout))
    log.info('release-gate-batch', `${config.label}: ${output.verdict} -> ${path}`)
  }

  console.log('\n' + '='.repeat(72))
  console.log('  RELEASE GATE BATCH SCORECARD')
  console.log('='.repeat(72))
  console.log(formatReleaseGateBatchTable(rows))
  console.log('='.repeat(72))
  for (const output of outputs) {
    console.log(`  ${output.label}: ${output.path}`)
  }

  for (const diagnostic of diagnostics) {
    console.log('\n' + diagnostic)
  }

  process.exit(rows.some(row => row.verdict === 'PASS') ? 0 : 1)
}

main().catch(err => {
  log.error('release-gate-batch', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
