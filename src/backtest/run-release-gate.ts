/**
 * Unattended-live release gate validator for narrowed BTC/ETH/SOL universe.
 *
 * Usage:
 *   bun run src/backtest/run-release-gate.ts
 *
 * Env:
 *   RELEASE_GATE_COINS=BTC,ETH,SOL
 *   RELEASE_GATE_EXTENDED_HISTORY=1
 *   RELEASE_GATE_STRATEGY_PARAMS='{"SMC_MIN_RR":2}'
 */

import type { Candle, CandleInterval } from '../types.js'
import type { BacktestConfig, StrategyParams, WalkForwardConfig } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { walkForward } from './walk-forward.js'
import {
  buildReleaseGateDiagnosticSummary,
  collectWalkForwardTrades,
  formatReleaseGateValidationReport,
  evaluateReleaseGateScorecard,
  type ReleaseGateDiagnosticSummary,
  type ReleaseGateScorecard,
} from './report.js'
import { getStrategyRegistry } from '../strategy/registry.js'
import { SmcSdStrategy } from '../strategy/strategies/smc-sd/index.js'
import {
  BACKTEST_SLIPPAGE_PCT,
  HTF_MAP,
  WF_TRAIN_WINDOW_MS,
  WF_TEST_WINDOW_MS,
  WF_STEP_MS,
} from '../config.js'
import { log } from '../lib/logger.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const RELEASE_GATE_TIMEFRAMES: CandleInterval[] = ['5m', '15m', '1h', '4h']
export const RELEASE_GATE_DEFAULT_COINS = ['BTC', 'ETH', 'SOL'] as const
const DEFAULT_COUNTS: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 8_640,
  '15m': 17_280,
  '1h': 5_000,
  '4h': 5_000,
  '1d': 2_000,
}
const EXTENDED_COUNTS: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 12_000,
  '15m': 24_000,
  '1h': 7_000,
  '4h': 7_000,
  '1d': 3_000,
}
const BYBIT_COMMISSION_PCT = 0.00055

export interface ReleaseGateRunOptions {
  coins: string[]
  strategyParams: StrategyParams
  counts: Record<CandleInterval, number>
  disabledScanModes?: string[]
}

export interface ReleaseGateRunOutput {
  generatedAt: string
  coins: string[]
  strategyParams: StrategyParams
  counts: Record<CandleInterval, number>
  disabledScanModes: string[]
  split: '80/20'
  trainSeries: number
  holdoutSeries: number
  oos: ReturnType<typeof walkForward>
  holdout: ReturnType<typeof walkForward>
  diagnostics: {
    oos: ReleaseGateDiagnosticSummary
    holdout: ReleaseGateDiagnosticSummary
  }
  scorecard: ReleaseGateScorecard
  verdict: 'PASS' | 'NO-GO'
}

export function resolveReleaseGateCoins(): string[] {
  return (process.env.RELEASE_GATE_COINS ?? RELEASE_GATE_DEFAULT_COINS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export function resolveReleaseGateCounts(): Record<CandleInterval, number> {
  const ext = process.env.RELEASE_GATE_EXTENDED_HISTORY
  if (ext === '1' || ext === 'true' || ext === 'yes') return EXTENDED_COUNTS
  return DEFAULT_COUNTS
}

export function resolveReleaseGateParams(): StrategyParams {
  const raw = process.env.RELEASE_GATE_STRATEGY_PARAMS?.trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as StrategyParams
  } catch {
    log.error('release-gate', 'RELEASE_GATE_STRATEGY_PARAMS must be valid JSON')
    process.exit(1)
  }
}

function ensureStrategyRegistered(): void {
  const registry = getStrategyRegistry()
  try {
    registry.register(new SmcSdStrategy())
  } catch {
    // already registered
  }
}

export function computeReleaseGateExtraHTFs(tfs: CandleInterval[]): CandleInterval[] {
  const set = new Set(tfs)
  const extras = new Set<CandleInterval>()
  for (const tf of tfs) {
    const htf = HTF_MAP[tf]
    if (htf !== tf && !set.has(htf)) extras.add(htf)
  }
  return [...extras]
}

export async function fetchReleaseGateCandles(
  coins: string[],
  counts: Record<CandleInterval, number>,
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>()
  const tfs = RELEASE_GATE_TIMEFRAMES
  const extraHTFs = computeReleaseGateExtraHTFs(tfs)
  const allTFs = [...tfs, ...extraHTFs]
  const total = coins.length * allTFs.length
  let done = 0

  for (const coin of coins) {
    for (const tf of allTFs) {
      const candles = await fetchBybitCandlesBatched(coin, tf, counts[tf] ?? 5000)
      done++
      if (candles == null) {
        log.warn('release-gate', `[${done}/${total}] ${coin} ${tf}: FAILED`)
        continue
      }
      result.set(`${coin}|${tf}`, candles)
      log.info('release-gate', `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles`)
    }
  }

  return result
}

function splitCandles(
  candles: Map<string, Candle[]>,
  trainFraction: number,
): { trainCandles: Map<string, Candle[]>; holdoutCandles: Map<string, Candle[]> } {
  const trainCandles = new Map<string, Candle[]>()
  const holdoutCandles = new Map<string, Candle[]>()

  for (const [key, series] of candles) {
    const splitIdx = Math.floor(series.length * trainFraction)
    const train = series.slice(0, splitIdx)
    const holdout = series.slice(splitIdx)
    if (train.length > 0) trainCandles.set(key, train)
    if (holdout.length > 0) holdoutCandles.set(key, holdout)
  }

  return { trainCandles, holdoutCandles }
}

export function runReleaseGateValidationOnCandles(
  allCandles: Map<string, Candle[]>,
  options: ReleaseGateRunOptions,
): ReleaseGateRunOutput {
  ensureStrategyRegistered()
  if (allCandles.size === 0) {
    throw new Error('No candle data fetched')
  }

  const { trainCandles, holdoutCandles } = splitCandles(allCandles, 0.8)
  const disabledScanModes = [...(options.disabledScanModes ?? [])]

  const backtestConfig: BacktestConfig = {
    coins: options.coins,
    timeframes: RELEASE_GATE_TIMEFRAMES,
    initialCapital: 10_000,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BYBIT_COMMISSION_PCT,
    strategy: 'smc-sd',
    strategyParams: options.strategyParams,
    disabledScanModes,
  }
  const wfConfig: WalkForwardConfig = {
    backtestConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  }

  log.info('release-gate', 'Running walk-forward on train slice...')
  const oos = walkForward(trainCandles, wfConfig)
  log.info('release-gate', 'Running walk-forward on unseen holdout slice...')
  const holdout = walkForward(holdoutCandles, wfConfig)

  const scorecard = evaluateReleaseGateScorecard({
    coins: options.coins,
    strategyParams: options.strategyParams,
    oos,
    holdout,
  })
  const diagnostics = {
    oos: buildReleaseGateDiagnosticSummary(collectWalkForwardTrades(oos), backtestConfig.initialCapital),
    holdout: buildReleaseGateDiagnosticSummary(collectWalkForwardTrades(holdout), backtestConfig.initialCapital),
  }
  const verdict: 'PASS' | 'NO-GO' = Object.values(scorecard).every(Boolean) ? 'PASS' : 'NO-GO'

  return {
    generatedAt: new Date().toISOString(),
    coins: [...options.coins],
    strategyParams: options.strategyParams,
    counts: options.counts,
    disabledScanModes,
    split: '80/20',
    trainSeries: trainCandles.size,
    holdoutSeries: holdoutCandles.size,
    oos,
    holdout,
    diagnostics,
    scorecard,
    verdict,
  }
}

export async function runReleaseGateValidation(options: ReleaseGateRunOptions): Promise<ReleaseGateRunOutput> {
  const allCandles = await fetchReleaseGateCandles(options.coins, options.counts)
  return runReleaseGateValidationOnCandles(allCandles, options)
}

export function writeReleaseGateResult(output: ReleaseGateRunOutput, prefix: string = 'release-gate'): string {
  const resultsDir = join(process.cwd(), 'results')
  mkdirSync(resultsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = join(resultsDir, `${prefix}-${timestamp}.json`)
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  return outputPath
}

async function main() {
  const coins = resolveReleaseGateCoins()
  const strategyParams = resolveReleaseGateParams()
  const counts = resolveReleaseGateCounts()

  console.log('='.repeat(60))
  console.log('  RELEASE GATE VALIDATION')
  console.log(`  Coins: ${coins.join(', ')}`)
  console.log(`  Params: ${JSON.stringify(strategyParams)}`)
  console.log(`  History: ${counts['1h']} x 1h candles`)
  console.log('='.repeat(60))

  const output = await runReleaseGateValidation({ coins, strategyParams, counts })
  const report = formatReleaseGateValidationReport({
    coins: output.coins,
    strategyParams: output.strategyParams,
    oos: output.oos,
    holdout: output.holdout,
  })
  console.log('\n' + report)

  const outputPath = writeReleaseGateResult(output)
  log.info('release-gate', `Wrote ${outputPath}`)
  process.exit(output.verdict === 'PASS' ? 0 : 1)
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('run-release-gate.ts')
  || process.argv[1]?.endsWith('run-release-gate.js')

if (isMainModule) {
  main().catch(err => {
    log.error('release-gate', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
