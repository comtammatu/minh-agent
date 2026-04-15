/**
 * Walk-forward universe comparison — same strategy params, two coin sets.
 *
 * Purpose: validate whether raw 1h diagnostics (Top-3 vs Rest) carry through
 * to walk-forward OOS. Does NOT optimize parameters.
 *
 * Default runs:
 *   A) Baseline 10-coin universe (same list as run-drilldown-diag.ts)
 *   B) Subset: BTC, ETH, SOL only (Tier-1 liquidity — matches Top-3 in raw reports)
 *
 * Usage:
 *   bun run src/backtest/run-wf-universe-compare.ts [baselineCoins] [subsetCoins]
 *
 * Env:
 *   WF_COMPARE_EXTENDED_HISTORY=1 — longer 1h/4h/5m/15m pulls (more WF coverage).
 *   WF_COMPARE_STRATEGY_PARAMS='{"SMC_MIN_RR":2}' — JSON overrides (else config defaults).
 *
 * Examples:
 *   bun run src/backtest/run-wf-universe-compare.ts
 *   WF_COMPARE_EXTENDED_HISTORY=1 bun run src/backtest/run-wf-universe-compare.ts
 *   bun run src/backtest/run-wf-universe-compare.ts \
 *     BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM \
 *     BTC,ETH,SOL,AVAX,LINK,BNB
 */

import type { Candle, CandleInterval } from '../types.js'
import type { BacktestConfig, StrategyParams, WalkForwardConfig } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { inferScanMode } from './optimize.js'
import { walkForward } from './walk-forward.js'
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

const TIMEFRAMES: CandleInterval[] = ['5m', '15m', '1h', '4h']

/** Same default 10-coin set as run-drilldown-diag.ts */
export const WF_COMPARE_BASELINE_10 = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'ARB', 'APT', 'BNB', 'DOT', 'ATOM',
] as const

/** Tier-1 liquidity subset for WF vs full-universe test (Top-3). */
export const WF_COMPARE_SUBSET_TOP3 = ['BTC', 'ETH', 'SOL'] as const

/** Mid-tier ~6 liquid majors (between Top-3 and full 10-coin diagnostic set). */
export const WF_COMPARE_SUBSET_MID6 = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'BNB',
] as const

/** Default: matches run-drilldown-diag.ts (enough 5m/15m for cascade + 5k HTF). */
const CANDLE_COUNTS_DEFAULT: Record<CandleInterval, number> = {
  '1m': 500, '5m': 8_640, '15m': 17_280, '1h': 5_000, '4h': 5_000, '1d': 2_000,
}

/**
 * Longer 1h/4h (+40%) and proportionally more 5m/15m for denser WF windows / OOS trades.
 * Enable: `WF_COMPARE_EXTENDED_HISTORY=1` (batched REST — same pattern as default).
 */
const CANDLE_COUNTS_EXTENDED: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 12_000,
  '15m': 24_000,
  '1h': 7_000,
  '4h': 7_000,
  '1d': 3_000,
}

const BYBIT_COMMISSION_PCT = 0.00055

function resolveCandleCounts(): Record<CandleInterval, number> {
  const ext = process.env.WF_COMPARE_EXTENDED_HISTORY
  if (ext === '1' || ext === 'true' || ext === 'yes') return CANDLE_COUNTS_EXTENDED
  return CANDLE_COUNTS_DEFAULT
}

/** Params: env `WF_COMPARE_STRATEGY_PARAMS` JSON, else `{}` (config.ts defaults). */
function resolveFixedParams(): StrategyParams {
  const raw = process.env.WF_COMPARE_STRATEGY_PARAMS?.trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as StrategyParams
  } catch {
    log.error('wf-compare', 'WF_COMPARE_STRATEGY_PARAMS must be valid JSON object')
    process.exit(1)
  }
}

export interface WfUniverseRunSummary {
  label: string
  coins: string[]
  subsetCriterion: string
  oosPF: number
  oosMaxDD: number
  oosTrades: number
  oosWins: number
  oosWinRate: number
  numWindows: number
  tradesByMode: Record<string, number>
  durationMs: number
}

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
  candleCounts: Record<CandleInterval, number>,
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>()
  const allTFs = [...tfs, ...extraHTFs]
  const total = coins.length * allTFs.length
  let done = 0

  for (const coin of coins) {
    for (const tf of allTFs) {
      const count = candleCounts[tf] ?? 5000
      const candles = await fetchBybitCandlesBatched(coin, tf, count)
      done++
      if (candles === null) {
        log.warn('wf-compare', `[${done}/${total}] ${coin} ${tf}: FAILED`)
        continue
      }
      result.set(`${coin}|${tf}`, candles)
      log.info('wf-compare', `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles`)
    }
  }
  return result
}

/** Keep only series whose coin is in `coins`. */
export function filterCandlesByCoins(
  candles: Map<string, Candle[]>,
  coins: string[],
): Map<string, Candle[]> {
  const allow = new Set(coins)
  const out = new Map<string, Candle[]>()
  for (const [key, series] of candles) {
    const coin = key.split('|')[0] ?? ''
    if (allow.has(coin)) out.set(key, series)
  }
  return out
}

function fmtPF(pf: number): string {
  if (!isFinite(pf)) return 'Inf'
  return pf.toFixed(3)
}

function runWfOnce(
  candles: Map<string, Candle[]>,
  coins: string[],
  label: string,
  subsetCriterion: string,
  strategyParams: StrategyParams,
): WfUniverseRunSummary {
  const start = Date.now()
  const baseConfig: BacktestConfig = {
    coins,
    timeframes: TIMEFRAMES,
    initialCapital: 10_000,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BYBIT_COMMISSION_PCT,
    strategy: 'smc-sd',
    strategyParams,
  }

  const wfConfig: WalkForwardConfig = {
    backtestConfig: baseConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  }

  const wfResult = walkForward(candles, wfConfig)
  const oosTrades = wfResult.windows.flatMap(w => w.testTrades ?? [])
  const tradesByMode = oosTrades.reduce((acc, t) => {
    const mode = inferScanMode(t.interval)
    acc[mode] = (acc[mode] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  const m = wfResult.oosMetrics
  return {
    label,
    coins: [...coins],
    subsetCriterion,
    oosPF: m.profitFactor,
    oosMaxDD: m.maxDrawdown,
    oosTrades: m.totalTrades,
    oosWins: m.wins,
    oosWinRate: m.winRate,
    numWindows: wfResult.windows.length,
    tradesByMode,
    durationMs: Date.now() - start,
  }
}

function printComparisonTable(a: WfUniverseRunSummary, b: WfUniverseRunSummary): void {
  const modeStr = (r: WfUniverseRunSummary) =>
    Object.entries(r.tradesByMode)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ') || '(none)'

  console.log('')
  console.log('='.repeat(88))
  console.log('  WALK-FORWARD UNIVERSE COMPARISON (fixed params, OOS aggregate)')
  console.log('='.repeat(88))
  console.log(
    `${'Run'.padEnd(6)} ${'PF'.padStart(10)} ${'MaxDD%'.padStart(8)} ${'Trades'.padStart(7)} ${'Wins'.padStart(5)} ${'WR%'.padStart(6)} ${'WFs'.padStart(4)} ${'modes (OOS)'.padEnd(36)}`,
  )
  console.log('-'.repeat(88))
  console.log(
    `${'A'.padEnd(6)} ${fmtPF(a.oosPF).padStart(10)} ${(a.oosMaxDD * 100).toFixed(2).padStart(7)}% ${String(a.oosTrades).padStart(7)} ${String(a.oosWins).padStart(5)} ${(a.oosWinRate * 100).toFixed(1).padStart(5)}% ${String(a.numWindows).padStart(4)} ${modeStr(a).slice(0, 36)}`,
  )
  console.log(
    `${'B'.padEnd(6)} ${fmtPF(b.oosPF).padStart(10)} ${(b.oosMaxDD * 100).toFixed(2).padStart(7)}% ${String(b.oosTrades).padStart(7)} ${String(b.oosWins).padStart(5)} ${(b.oosWinRate * 100).toFixed(1).padStart(5)}% ${String(b.numWindows).padStart(4)} ${modeStr(b).slice(0, 36)}`,
  )
  console.log('='.repeat(88))
  console.log(`  Run A: ${a.coins.join(',')}`)
  console.log(`  Run B: ${b.coins.join(',')} — ${b.subsetCriterion}`)
  console.log('')
}

async function main() {
  const baselineCoins = (process.argv[2] ?? WF_COMPARE_BASELINE_10.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const subsetCoins = (process.argv[3] ?? WF_COMPARE_SUBSET_TOP3.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const fixedParams = resolveFixedParams()
  const candleCounts = resolveCandleCounts()
  const extended =
    process.env.WF_COMPARE_EXTENDED_HISTORY === '1' ||
    process.env.WF_COMPARE_EXTENDED_HISTORY === 'true'

  const unionCoins = [...new Set([...baselineCoins, ...subsetCoins])]

  console.log('='.repeat(60))
  console.log('  WF UNIVERSE COMPARE')
  console.log(`  Fetch union: ${unionCoins.join(', ')}`)
  console.log(`  Run A (baseline): ${baselineCoins.join(', ')}`)
  console.log(`  Run B (subset):   ${subsetCoins.join(', ')}`)
  console.log(`  History: ${extended ? 'extended (WF_COMPARE_EXTENDED_HISTORY)' : 'default'}`)
  console.log(`  Params: ${JSON.stringify(fixedParams)} (empty object = config.ts defaults)`)
  console.log('='.repeat(60))

  const extraHTFs = computeExtraHTFs(TIMEFRAMES)
  log.info('wf-compare', 'Fetching candles from Bybit...')
  const allCandles = await fetchAllCandles(unionCoins, TIMEFRAMES, extraHTFs, candleCounts)

  let totalCandles = 0
  for (const [, series] of allCandles) totalCandles += series.length
  if (totalCandles === 0) {
    log.error('wf-compare', 'No candle data. Aborting.')
    process.exit(1)
  }

  const candlesA = filterCandlesByCoins(allCandles, baselineCoins)
  const candlesB = filterCandlesByCoins(allCandles, subsetCoins)

  const criterionB =
    subsetCoins.length === 3 && subsetCoins.every(c => ['BTC', 'ETH', 'SOL'].includes(c))
      ? 'Tier-1 liquidity Top-3 (BTC, ETH, SOL) — same criterion as raw Top-3 vs Rest diagnostics'
      : `Custom subset (${subsetCoins.length} coins) — mid-tier or experimental allowlist`

  const summaryA = runWfOnce(candlesA, baselineCoins, 'A_baseline_10', 'Full 10-coin baseline', fixedParams)
  const summaryB = runWfOnce(candlesB, subsetCoins, 'B_subset', criterionB, fixedParams)

  printComparisonTable(summaryA, summaryB)

  const out = {
    generatedAt: new Date().toISOString(),
    fixedParams,
    candleProfile: extended ? 'extended' : 'default',
    candleCounts,
    wfWindows: {
      trainWindowMs: WF_TRAIN_WINDOW_MS,
      testWindowMs: WF_TEST_WINDOW_MS,
      stepMs: WF_STEP_MS,
    },
    runA: summaryA,
    runB: summaryB,
  }

  const resultsDir = join(process.cwd(), 'results')
  mkdirSync(resultsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(resultsDir, `wf-universe-compare-${timestamp}.json`)
  writeFileSync(jsonPath, JSON.stringify(out, null, 2))
  log.info('wf-compare', `Wrote ${jsonPath}`)

  log.info('wf-compare', 'Done.')
}

main().catch(err => {
  log.error('wf-compare', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
