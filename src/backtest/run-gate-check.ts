/**
 * Expectancy Gate Check — run walk-forward validation on real data.
 *
 * Usage: bun run src/backtest/run-gate-check.ts
 *
 * Steps:
 *   1. Download historical candles (if not already in PG)
 *   2. Load candles from PG
 *   3. Run walk-forward validation
 *   4. Print expectancy report
 *   5. Exit with code 0 (pass) or 1 (fail)
 *
 * Sprint 3 — Phase 3A gate check.
 */

import { sql } from '../db/connection.js'
import { runMigrations } from '../db/migrate.js'
import { BacktestDataManager, computeHTFIntervals, computeHTFWarmupMs } from './data-manager.js'
import { runBacktest } from './engine.js'
import { walkForward } from './walk-forward.js'
import { formatExpectancyReport, formatMetricsSummary } from './report.js'
import { formatPipelineStats } from '../scanner/pipeline.js'
import type { BacktestConfig, WalkForwardConfig } from './types.js'
import type { CandleInterval } from '../types.js'
import {
  BACKTEST_SLIPPAGE_PCT,
  BACKTEST_COMMISSION_PCT,
  WF_TRAIN_WINDOW_MS,
  WF_TEST_WINDOW_MS,
  WF_STEP_MS,
} from '../config.js'
import { log } from '../lib/logger.js'

// ─── Configuration ─────────────────────────────────────────────────────────

/** Coins to validate. Top liquid coins on Hyperliquid by OI/volume. */
const GATE_COINS = [
  // Tier 1 — Majors
  'BTC', 'ETH', 'SOL',
  // Tier 2 — Large caps, liquid
  'DOGE', 'AVAX', 'LINK', 'ARB', 'SUI',
  // Tier 3 — Mid caps, volatile (more setups, more noise)
  'WLD', 'INJ', 'TIA', 'SEI', 'WIF', 'PEPE', 'ONDO',
]

/** Timeframes to validate. */
const GATE_TIMEFRAMES: CandleInterval[] = ['15m', '1h', '4h']

/** How many months of history to use. */
const HISTORY_MONTHS = 3

/** Initial capital for backtest. */
const INITIAL_CAPITAL = 10_000

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log.info('gate-check', '=== EXPECTANCY GATE CHECK ===')

  // Ensure DB is ready
  await runMigrations(sql)

  const dm = new BacktestDataManager()

  const endDate = new Date()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - HISTORY_MONTHS)

  // Step 1: Download history (skips existing data via upsert)
  log.info('gate-check', `Downloading ${HISTORY_MONTHS} months of history for ${GATE_COINS.join(', ')}...`)

  // Determine extra HTF intervals needed for Layer 1 bias warmup
  const extraHTFs = computeHTFIntervals(GATE_TIMEFRAMES)
  if (extraHTFs.length > 0) {
    log.info('gate-check', `Extra HTF intervals for bias warmup: ${extraHTFs.join(', ')}`)
  }

  for (const coin of GATE_COINS) {
    // Download requested timeframes
    for (const tf of GATE_TIMEFRAMES) {
      const count = await dm.downloadHistory(coin, tf, startDate, endDate)
      log.info('gate-check', `${coin} ${tf}: ${count} candles`)
    }

    // Download extra HTF data with warmup buffer
    for (const htf of extraHTFs) {
      const warmupMs = computeHTFWarmupMs(htf)
      const htfStart = new Date(startDate.getTime() - warmupMs)
      const count = await dm.downloadHistory(coin, htf, htfStart, endDate)
      log.info('gate-check', `${coin} ${htf} (HTF warmup): ${count} candles`)
    }
  }

  // Step 2: Load candles
  log.info('gate-check', 'Loading candles from PG...')
  const candles = await dm.loadForBacktest(GATE_COINS, GATE_TIMEFRAMES, startDate, endDate)

  let totalCandles = 0
  for (const [key, series] of candles) {
    totalCandles += series.length
    log.info('gate-check', `${key}: ${series.length} candles`)
  }

  if (totalCandles === 0) {
    log.error('gate-check', 'No candle data loaded. Check DB connection and data availability.')
    await sql.end()
    process.exit(1)
  }

  // Step 2.5: Diagnostic — single full-range backtest for per-layer stats
  log.info('gate-check', 'Running diagnostic backtest (per-layer stats)...')

  const backtestConfig: BacktestConfig = {
    coins: GATE_COINS,
    timeframes: GATE_TIMEFRAMES,
    initialCapital: INITIAL_CAPITAL,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BACKTEST_COMMISSION_PCT,
  }

  const diagResult = runBacktest(candles, backtestConfig)
  if (diagResult.pipelineStats) {
    console.log('\n' + formatPipelineStats(diagResult.pipelineStats))
  }
  log.info('gate-check', `Diagnostic: ${diagResult.trades.length} trades on full dataset`)

  // Step 3: Run walk-forward
  log.info('gate-check', 'Running walk-forward validation...')

  const wfConfig: WalkForwardConfig = {
    backtestConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  }

  const result = walkForward(candles, wfConfig)

  // Step 4: Print report
  const report = formatExpectancyReport(result)
  console.log('\n' + report)

  // Also print one-line summaries
  console.log('\n' + formatMetricsSummary(result.isMetrics, 'IS'))
  console.log(formatMetricsSummary(result.oosMetrics, 'OOS'))

  // Step 5: Gate verdict
  if (result.passesGate) {
    log.info('gate-check', 'GATE PASSED — OOS expectancy > 0. Proceed to Phase 3B.')
  } else {
    log.warn('gate-check', 'GATE FAILED — OOS expectancy <= 0. Fix pipeline before proceeding.')
  }

  // Cleanup
  await sql.end()

  process.exit(result.passesGate ? 0 : 1)
}

main().catch(err => {
  log.error('gate-check', `Fatal: ${err instanceof Error ? err.message : String(err)}`)
  sql.end().catch(() => {})
  process.exit(1)
})
