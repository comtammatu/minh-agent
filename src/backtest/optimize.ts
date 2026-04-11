/**
 * Parameter optimizer — random search over PARAM_SCHEMA, evaluated via walk-forward.
 *
 * Usage: bun run src/backtest/optimize.ts [numTrials] [coins]
 *   numTrials: number of random parameter sets to evaluate (default: 200)
 *   coins:     comma-separated coin list (default: BTC,ETH,SOL)
 *
 * Flow:
 *   1. Fetch candles from Bybit for specified coins
 *   2. Split 80/20 into train / holdout sets
 *   3. For each trial: generate random params → walkForward on train data
 *   4. Top-N params: validate on holdout data
 *   5. Output: JSON file + console table + optional PostgreSQL write
 *
 * Evolution Phase 1 — Days 4-5.
 */

import type { Candle, CandleInterval } from '../types.js'
import type { BacktestConfig, StrategyParams, WalkForwardConfig, WalkForwardResult } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { walkForward } from './walk-forward.js'
import { getStrategyRegistry } from '../strategy/registry.js'
import { SmcSdStrategy } from '../strategy/strategies/smc-sd/index.js'
import {
  PARAM_SCHEMA,
  BACKTEST_SLIPPAGE_PCT,
  HTF_MAP,
  WF_TRAIN_WINDOW_MS,
  WF_TEST_WINDOW_MS,
  WF_STEP_MS,
} from '../config.js'
import { log } from '../lib/logger.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ParamRange {
  readonly min: number
  readonly max: number
  readonly step: number
  readonly type: 'float'
}

export type ParamSchemaMap = Record<string, ParamRange>

export interface TrialResult {
  trialIndex: number
  params: StrategyParams
  oosPF: number
  oosExpectancy: number
  maxDD: number
  winRate: number
  tradeCount: number
  numWindows: number
  durationMs: number
  error?: string
}

export interface HoldoutResult extends TrialResult {
  holdoutPF: number
  holdoutMaxDD: number
  holdoutTrades: number
}

export interface OptimizeRunResult {
  runId: string
  coins: string[]
  numTrials: number
  totalDurationMs: number
  trials: TrialResult[]
  topN: HoldoutResult[]
  plateauDetected: boolean
}

// ─── Core Functions (exported for testing) ────────────────────────────────

/**
 * Generate random parameter sets from schema via uniform random sampling.
 * Values are snapped to the nearest step.
 */
export function generateTrials(schema: ParamSchemaMap, count: number): StrategyParams[] {
  const keys = Object.keys(schema) as (keyof typeof schema)[]
  const trials: StrategyParams[] = []

  for (let i = 0; i < count; i++) {
    const params: Record<string, number> = {}
    for (const key of keys) {
      const range = schema[key]!
      const steps = Math.round((range.max - range.min) / range.step)
      const stepIndex = Math.floor(Math.random() * (steps + 1))
      const value = range.min + stepIndex * range.step
      // Snap to step precision to avoid float drift
      const decimals = range.step.toString().split('.')[1]?.length ?? 0
      params[key] = parseFloat(value.toFixed(decimals))
    }
    trials.push(params as unknown as StrategyParams)
  }

  return trials
}

/**
 * Split candle map into train (first fraction) and holdout (remaining) by time.
 * No overlap — holdout starts exactly where train ends.
 */
export function splitData(
  candles: Map<string, Candle[]>,
  trainFraction: number,
): { trainCandles: Map<string, Candle[]>; holdoutCandles: Map<string, Candle[]> } {
  const trainCandles = new Map<string, Candle[]>()
  const holdoutCandles = new Map<string, Candle[]>()

  for (const [key, series] of candles) {
    if (series.length === 0) continue
    const splitIdx = Math.floor(series.length * trainFraction)
    const train = series.slice(0, splitIdx)
    const holdout = series.slice(splitIdx)
    if (train.length > 0) trainCandles.set(key, train)
    if (holdout.length > 0) holdoutCandles.set(key, holdout)
  }

  return { trainCandles, holdoutCandles }
}

/**
 * Run a single optimizer trial: walkForward with given params on train data.
 * Returns null on error (logged + skipped).
 */
export function runTrial(
  trainCandles: Map<string, Candle[]>,
  baseConfig: BacktestConfig,
  wfConfig: WalkForwardConfig,
  params: StrategyParams,
  trialIndex: number,
): TrialResult {
  const start = Date.now()

  const configWithParams: BacktestConfig = {
    ...baseConfig,
    strategyParams: params,
  }

  const wfConfigWithParams: WalkForwardConfig = {
    ...wfConfig,
    backtestConfig: configWithParams,
  }

  try {
    const result: WalkForwardResult = walkForward(trainCandles, wfConfigWithParams)

    return {
      trialIndex,
      params,
      oosPF: result.oosMetrics.profitFactor,
      oosExpectancy: result.oosMetrics.expectancy,
      maxDD: result.oosMetrics.maxDrawdown,
      winRate: result.oosMetrics.winRate,
      tradeCount: result.oosMetrics.totalTrades,
      numWindows: result.windows.length,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.warn('optimizer', `Trial ${trialIndex} failed: ${errorMsg}`)
    return {
      trialIndex,
      params,
      oosPF: 0,
      oosExpectancy: 0,
      maxDD: 1,
      winRate: 0,
      tradeCount: 0,
      numWindows: 0,
      durationMs: Date.now() - start,
      error: errorMsg,
    }
  }
}

/**
 * Select top-N trials by OOS profit factor, excluding failures.
 * Minimum trade count filter: at least 5 OOS trades.
 */
export function selectTopN(trials: TrialResult[], n: number): TrialResult[] {
  return trials
    .filter(t => !t.error && t.tradeCount >= 5 && isFinite(t.oosPF))
    .sort((a, b) => b.oosPF - a.oosPF)
    .slice(0, n)
}

/**
 * Validate top params on holdout data (never seen by optimizer).
 */
export function validateHoldout(
  holdoutCandles: Map<string, Candle[]>,
  baseConfig: BacktestConfig,
  wfConfig: WalkForwardConfig,
  topTrials: TrialResult[],
): HoldoutResult[] {
  const results: HoldoutResult[] = []

  for (const trial of topTrials) {
    const configWithParams: BacktestConfig = {
      ...baseConfig,
      strategyParams: trial.params,
    }

    const wfConfigWithParams: WalkForwardConfig = {
      ...wfConfig,
      backtestConfig: configWithParams,
    }

    try {
      const result = walkForward(holdoutCandles, wfConfigWithParams)
      results.push({
        ...trial,
        holdoutPF: result.oosMetrics.profitFactor,
        holdoutMaxDD: result.oosMetrics.maxDrawdown,
        holdoutTrades: result.oosMetrics.totalTrades,
      })
    } catch (err) {
      log.warn('optimizer', `Holdout validation failed for trial ${trial.trialIndex}: ${err instanceof Error ? err.message : String(err)}`)
      results.push({
        ...trial,
        holdoutPF: 0,
        holdoutMaxDD: 1,
        holdoutTrades: 0,
      })
    }
  }

  return results
}

/**
 * Detect optimization plateau: if PF variance in top-20 is < 0.05,
 * random search is unlikely to find better — consider Optuna/TPE.
 */
export function detectPlateau(trials: TrialResult[], topN: number = 20): boolean {
  const top = selectTopN(trials, topN)
  if (top.length < 5) return false

  const pfs = top.map(t => t.oosPF)
  const mean = pfs.reduce((s, v) => s + v, 0) / pfs.length
  const variance = pfs.reduce((s, v) => s + (v - mean) ** 2, 0) / pfs.length
  return variance < 0.05
}

/**
 * Format results as console table.
 */
export function formatConsoleTable(topN: HoldoutResult[]): string {
  const lines: string[] = [
    '',
    '=== TOP PARAMETER COMBINATIONS ===',
    `${'#'.padStart(3)}  ${'OOS PF'.padStart(7)}  ${'OOS Exp'.padStart(8)}  ${'MaxDD'.padStart(6)}  ${'WR'.padStart(5)}  ${'Trades'.padStart(6)}  ${'Hold PF'.padStart(8)}  ${'Hold DD'.padStart(8)}  ${'Hold #'.padStart(6)}  Params`,
    '-'.repeat(120),
  ]

  for (let i = 0; i < topN.length; i++) {
    const t = topN[i]!
    const paramStr = Object.entries(t.params)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
      .join(' ')

    lines.push(
      `${(i + 1).toString().padStart(3)}  ${t.oosPF.toFixed(2).padStart(7)}  ${('$' + t.oosExpectancy.toFixed(2)).padStart(8)}  ${(t.maxDD * 100).toFixed(1).padStart(5)}%  ${(t.winRate * 100).toFixed(0).padStart(4)}%  ${t.tradeCount.toString().padStart(6)}  ${t.holdoutPF.toFixed(2).padStart(8)}  ${(t.holdoutMaxDD * 100).toFixed(1).padStart(7)}%  ${t.holdoutTrades.toString().padStart(6)}  ${paramStr}`
    )
  }

  lines.push('=' .repeat(120))
  return lines.join('\n')
}

// ─── DB Write (best-effort) ───────────────────────────────────────────────

async function writeTrialsToDB(
  runId: string,
  coins: string[],
  trials: TrialResult[],
  holdoutMap: Map<number, HoldoutResult>,
): Promise<void> {
  try {
    const { sql } = await import('../db/connection.js')

    for (const trial of trials) {
      const holdout = holdoutMap.get(trial.trialIndex)
      await sql`
        INSERT INTO optimization_trials (
          run_id, trial_index, params, coins, num_windows,
          oos_pf, oos_expectancy, max_dd, win_rate, trade_count,
          holdout_pf, holdout_max_dd, holdout_trades,
          error, duration_ms
        ) VALUES (
          ${runId}, ${trial.trialIndex}, ${JSON.stringify(trial.params)},
          ${sql.array(coins)}, ${trial.numWindows},
          ${trial.oosPF}, ${trial.oosExpectancy}, ${trial.maxDD},
          ${trial.winRate}, ${trial.tradeCount},
          ${holdout?.holdoutPF ?? null}, ${holdout?.holdoutMaxDD ?? null},
          ${holdout?.holdoutTrades ?? null},
          ${trial.error ?? null}, ${trial.durationMs}
        )
      `
    }
    log.info('optimizer', `Wrote ${trials.length} trials to PostgreSQL (run ${runId})`)
  } catch (err) {
    log.warn('optimizer', `DB write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── Data Fetch ───────────────────────────────────────────────────────────

const TIMEFRAMES: CandleInterval[] = ['5m', '15m', '1h', '4h']

const CANDLE_COUNTS: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 8_640,
  '15m': 17_280,
  '1h': 5_000,
  '4h': 5_000,
  '1d': 2_000,
}

/** Compute extra HTF intervals not already in the TF list. */
function computeExtraHTFs(tfs: CandleInterval[]): CandleInterval[] {
  const set = new Set(tfs)
  const extras = new Set<CandleInterval>()
  for (const tf of tfs) {
    const htf = HTF_MAP[tf]
    if (htf !== tf && !set.has(htf)) extras.add(htf)
  }
  return [...extras]
}

async function fetchAllCandles(
  coins: string[],
  tfs: CandleInterval[],
  extraHTFs: CandleInterval[],
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>()
  const allTFs = [...tfs, ...extraHTFs]
  const total = coins.length * allTFs.length
  let done = 0

  for (const coin of coins) {
    for (const tf of allTFs) {
      const count = CANDLE_COUNTS[tf] ?? 5000
      const candles = await fetchBybitCandlesBatched(coin, tf, count)
      done++

      if (candles === null) {
        log.warn('optimizer', `[${done}/${total}] ${coin} ${tf}: FAILED — skipping`)
        continue
      }

      const key = `${coin}|${tf}`
      result.set(key, candles)
      log.info('optimizer', `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles`)
    }
  }

  return result
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const numTrials = parseInt(process.argv[2] ?? '200', 10)
  const coins = process.argv[3]?.split(',') ?? ['BTC', 'ETH', 'SOL']
  const topNCount = Math.min(10, Math.ceil(numTrials * 0.05))
  const runId = crypto.randomUUID()

  // Register strategy
  const registry = getStrategyRegistry()
  try { registry.register(new SmcSdStrategy()) } catch { /* already registered */ }

  console.log('='.repeat(60))
  console.log('  PARAMETER OPTIMIZER — Evolution Phase 1')
  console.log(`  Run ID: ${runId}`)
  console.log(`  Coins: ${coins.join(', ')}`)
  console.log(`  Trials: ${numTrials}`)
  console.log(`  Top-N for holdout: ${topNCount}`)
  console.log('='.repeat(60))

  // Step 1: Fetch candles
  log.info('optimizer', 'Fetching candles from Bybit...')
  const extraHTFs = computeExtraHTFs(TIMEFRAMES)
  const allCandles = await fetchAllCandles(coins, TIMEFRAMES, extraHTFs)

  let totalCandles = 0
  for (const [, series] of allCandles) totalCandles += series.length
  if (totalCandles === 0) {
    log.error('optimizer', 'No candle data. Aborting.')
    process.exit(1)
  }
  log.info('optimizer', `Total: ${totalCandles} candles across ${allCandles.size} series`)

  // Step 2: Split 80/20
  const { trainCandles, holdoutCandles } = splitData(allCandles, 0.8)
  log.info('optimizer', `Train series: ${trainCandles.size}, Holdout series: ${holdoutCandles.size}`)

  // Step 3: Base configs
  const BYBIT_COMMISSION_PCT = 0.00055
  const baseConfig: BacktestConfig = {
    coins,
    timeframes: TIMEFRAMES,
    initialCapital: 10_000,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BYBIT_COMMISSION_PCT,
    strategy: 'smc-sd',
  }

  const wfConfig: WalkForwardConfig = {
    backtestConfig: baseConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  }

  // Step 4: Generate trials and run
  const paramSets = generateTrials(PARAM_SCHEMA, numTrials)
  const trials: TrialResult[] = []
  const runStart = Date.now()

  for (let i = 0; i < paramSets.length; i++) {
    const params = paramSets[i]!
    log.info('optimizer', `Trial ${i + 1}/${numTrials}...`)
    const result = runTrial(trainCandles, baseConfig, wfConfig, params, i)
    trials.push(result)

    if (result.error) {
      log.warn('optimizer', `  Trial ${i} ERROR: ${result.error}`)
    } else {
      log.info('optimizer', `  PF=${result.oosPF.toFixed(2)} DD=${(result.maxDD * 100).toFixed(1)}% trades=${result.tradeCount} (${result.durationMs}ms)`)
    }
  }

  const totalDuration = Date.now() - runStart

  // Step 5: Select top-N and validate on holdout
  const topTrials = selectTopN(trials, topNCount)
  log.info('optimizer', `Top ${topTrials.length} trials selected for holdout validation...`)

  const holdoutResults = validateHoldout(holdoutCandles, baseConfig, wfConfig, topTrials)

  // Step 6: Plateau detection
  const plateauDetected = detectPlateau(trials)
  if (plateauDetected) {
    log.warn('optimizer', 'PLATEAU DETECTED: PF variance < 0.05 in top-20. Consider Optuna/TPE for smarter sampling.')
  }

  // Step 7: Output
  const runResult: OptimizeRunResult = {
    runId,
    coins,
    numTrials,
    totalDurationMs: totalDuration,
    trials,
    topN: holdoutResults,
    plateauDetected,
  }

  // Write JSON
  const resultsDir = join(process.cwd(), 'results')
  mkdirSync(resultsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(resultsDir, `optimize-${timestamp}.json`)
  writeFileSync(jsonPath, JSON.stringify(runResult, null, 2))
  log.info('optimizer', `Results written to ${jsonPath}`)

  // Console table
  console.log(formatConsoleTable(holdoutResults))
  console.log(`\nTotal duration: ${(totalDuration / 1000).toFixed(1)}s`)
  console.log(`Successful trials: ${trials.filter(t => !t.error).length}/${numTrials}`)
  if (plateauDetected) {
    console.log('⚠ PLATEAU DETECTED — random search exhausted, consider Bayesian optimization')
  }

  // Step 8: DB write (best-effort)
  const holdoutMap = new Map<number, HoldoutResult>()
  for (const h of holdoutResults) holdoutMap.set(h.trialIndex, h)
  await writeTrialsToDB(runId, coins, trials, holdoutMap)

  log.info('optimizer', 'Done.')
}

// Only run main when executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('optimize.ts')
  || process.argv[1]?.endsWith('optimize.js')

if (isMainModule) {
  main().catch(err => {
    log.error('optimizer', `Fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
