/**
 * Focused 1h_same_tf audit for the unattended-live release gate.
 *
 * Reuses a single BTC/ETH/SOL candle fetch, disables non-1h scan modes,
 * then compares a few targeted coin subsets and stricter confidence/regime
 * profiles to isolate BTC and sideways-regime drag.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate-1h-audit.ts
 *
 * Env:
 *   RELEASE_GATE_1H_AUDIT_EXTENDED_HISTORY=1
 *   RELEASE_GATE_1H_AUDIT_PROFILES='[{"label":"no_btc","coins":["ETH","SOL"],"strategyParams":{"MIN_CONFIDENCE":0.65}}]'
 */

import type { CandleInterval } from '../types.js'
import type { StrategyParams } from './types.js'
import {
  formatReleaseGate1hAuditTable,
  formatReleaseGateDiagnosticReport,
  type ReleaseGate1hAuditRow,
} from './report.js'
import {
  fetchReleaseGateCandles,
  resolveReleaseGateCounts,
  runReleaseGateValidationOnCandles,
  writeReleaseGateResult,
} from './run-release-gate.js'
import { log } from '../lib/logger.js'

interface AuditProfile {
  label: string
  coins: string[]
  strategyParams: StrategyParams
}

interface AuditRun {
  label: string
  output: ReturnType<typeof runReleaseGateValidationOnCandles>
  path: string
}

const ONE_H_ONLY_DISABLED_SCAN_MODES = ['15m_drilldown', '5m_micro', '4h_poi'] as const

const DEFAULT_AUDIT_PROFILES: AuditProfile[] = [
  { label: 'all_base', coins: ['BTC', 'ETH', 'SOL'], strategyParams: {} },
  { label: 'no_btc_base', coins: ['ETH', 'SOL'], strategyParams: {} },
  { label: 'btc_only_base', coins: ['BTC'], strategyParams: {} },
  { label: 'eth_only_base', coins: ['ETH'], strategyParams: {} },
  { label: 'sol_only_base', coins: ['SOL'], strategyParams: {} },
  { label: 'all_higher_conf', coins: ['BTC', 'ETH', 'SOL'], strategyParams: { MIN_CONFIDENCE: 0.65 } },
  { label: 'no_btc_higher_conf', coins: ['ETH', 'SOL'], strategyParams: { MIN_CONFIDENCE: 0.65 } },
  {
    label: 'all_sideways_guard',
    coins: ['BTC', 'ETH', 'SOL'],
    strategyParams: { MIN_CONFIDENCE: 0.65, REGIME_MULT_NEUTRAL: 0.7, SMC_1H_CONFIDENCE_BASE: 0.7 },
  },
  {
    label: 'no_btc_sideways_guard',
    coins: ['ETH', 'SOL'],
    strategyParams: { MIN_CONFIDENCE: 0.65, REGIME_MULT_NEUTRAL: 0.7, SMC_1H_CONFIDENCE_BASE: 0.7 },
  },
  {
    label: 'btc_only_sideways_guard',
    coins: ['BTC'],
    strategyParams: { MIN_CONFIDENCE: 0.65, REGIME_MULT_NEUTRAL: 0.7, SMC_1H_CONFIDENCE_BASE: 0.7 },
  },
]

function resolve1hAuditCounts(): Record<CandleInterval, number> {
  const original = process.env.RELEASE_GATE_EXTENDED_HISTORY
  const override = process.env.RELEASE_GATE_1H_AUDIT_EXTENDED_HISTORY
  if (override != null) {
    process.env.RELEASE_GATE_EXTENDED_HISTORY = override
  }
  const counts = resolveReleaseGateCounts()
  if (original == null) delete process.env.RELEASE_GATE_EXTENDED_HISTORY
  else process.env.RELEASE_GATE_EXTENDED_HISTORY = original
  return counts
}

function resolve1hAuditProfiles(): AuditProfile[] {
  const raw = process.env.RELEASE_GATE_1H_AUDIT_PROFILES?.trim()
  if (!raw) return DEFAULT_AUDIT_PROFILES

  try {
    const parsed = JSON.parse(raw) as Array<{
      label?: string
      coins?: string[]
      strategyParams?: StrategyParams
    }>

    return parsed
      .filter(profile => profile.label != null && Array.isArray(profile.coins) && profile.coins.length > 0)
      .map(profile => ({
        label: profile.label!,
        coins: profile.coins!.map(coin => coin.trim()).filter(Boolean),
        strategyParams: profile.strategyParams ?? {},
      }))
  } catch {
    log.error('release-gate-1h-audit', 'RELEASE_GATE_1H_AUDIT_PROFILES must be valid JSON array')
    process.exit(1)
  }
}

function collectUniverse(profiles: AuditProfile[]): string[] {
  const seen = new Set<string>()
  for (const profile of profiles) {
    for (const coin of profile.coins) seen.add(coin)
  }
  return [...seen]
}

function buildAuditRows(runs: AuditRun[]): ReleaseGate1hAuditRow[] {
  return runs.map(run => ({
    label: run.label,
    coins: run.output.coins,
    strategyParams: run.output.strategyParams,
    verdict: run.output.verdict,
    holdoutPf: run.output.holdout.oosMetrics.profitFactor,
    oosPf: run.output.oos.oosMetrics.profitFactor,
    holdoutTrades: run.output.holdout.oosMetrics.totalTrades,
    oosTrades: run.output.oos.oosMetrics.totalTrades,
    oosMaxDd: run.output.oos.oosMetrics.maxDrawdown,
  }))
}

function selectDiagnosticRuns(runs: AuditRun[]): AuditRun[] {
  const selected = new Set<string>(['all_base', 'no_btc_base', 'btc_only_base'])
  const bestOosPf = runs.reduce((best, current) =>
    current.output.oos.oosMetrics.profitFactor > best.output.oos.oosMetrics.profitFactor ? current : best,
  runs[0]!)
  selected.add(bestOosPf.label)
  return runs.filter(run => selected.has(run.label))
}

function formatSelectedDiagnostics(runs: AuditRun[]): string[] {
  const sections: string[] = []
  for (const run of selectDiagnosticRuns(runs)) {
    sections.push(formatReleaseGateDiagnosticReport(run.label, 'OOS', run.output.diagnostics.oos))
    sections.push(formatReleaseGateDiagnosticReport(run.label, 'Holdout', run.output.diagnostics.holdout))
  }
  return sections
}

function summarizeBestCandidates(rows: ReleaseGate1hAuditRow[]): ReleaseGate1hAuditRow[] {
  return [...rows]
    .sort((a, b) => {
      if (b.oosPf !== a.oosPf) return b.oosPf - a.oosPf
      if (b.holdoutPf !== a.holdoutPf) return b.holdoutPf - a.holdoutPf
      return b.oosTrades - a.oosTrades
    })
    .slice(0, 3)
}

async function main() {
  const profiles = resolve1hAuditProfiles()
  const counts = resolve1hAuditCounts()
  const universe = collectUniverse(profiles)

  console.log('='.repeat(78))
  console.log('  RELEASE GATE 1H AUDIT')
  console.log(`  Universe fetch: ${universe.join(', ')}`)
  console.log(`  Profiles: ${profiles.map(profile => profile.label).join(', ')}`)
  console.log(`  Disabled scan modes: ${ONE_H_ONLY_DISABLED_SCAN_MODES.join(', ')}`)
  console.log(`  History: ${counts['1h']} x 1h candles`)
  console.log('='.repeat(78))

  log.info('release-gate-1h-audit', 'Fetching candles once for all 1h audit profiles...')
  const allCandles = await fetchReleaseGateCandles(universe, counts)

  const runs: AuditRun[] = []
  for (const profile of profiles) {
    console.log(`\n--- ${profile.label} ---`)
    const output = runReleaseGateValidationOnCandles(allCandles, {
      coins: profile.coins,
      strategyParams: profile.strategyParams,
      counts,
      disabledScanModes: [...ONE_H_ONLY_DISABLED_SCAN_MODES],
    })
    const path = writeReleaseGateResult(output, `release-gate-1h-audit-${profile.label}`)
    runs.push({ label: profile.label, output, path })
    log.info('release-gate-1h-audit', `${profile.label}: ${output.verdict} -> ${path}`)
  }

  const rows = buildAuditRows(runs)
  const selectedDiagnostics = formatSelectedDiagnostics(runs)
  const topRows = summarizeBestCandidates(rows)

  console.log('\n' + '='.repeat(78))
  console.log('  RELEASE GATE 1H AUDIT SCORECARD')
  console.log('='.repeat(78))
  console.log(formatReleaseGate1hAuditTable(rows))
  console.log('='.repeat(78))
  console.log('  Top OOS PF candidates')
  console.log(formatReleaseGate1hAuditTable(topRows))
  console.log('='.repeat(78))
  for (const run of runs) {
    console.log(`  ${run.label}: ${run.path}`)
  }

  for (const diagnostic of selectedDiagnostics) {
    console.log('\n' + diagnostic)
  }

  process.exit(rows.some(row => row.verdict === 'PASS') ? 0 : 1)
}

main().catch(err => {
  log.error('release-gate-1h-audit', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
