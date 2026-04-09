/**
 * Bybit Backtest Runner — fetch candles from Bybit REST → run backtest engine.
 *
 * Usage: bun run src/backtest/run-bybit-backtest.ts [strategy]
 *   strategy: layered | quant | smc-sd | all (default: all)
 *
 * No PostgreSQL required — all data fetched directly into memory.
 * Uses fetchBybitCandlesBatched from feed/bybit/bybit-rest.ts.
 */

import type { Candle, CandleInterval } from '../types.js'
import type { BacktestConfig, StrategyType } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { runBacktest } from './engine.js'
import { walkForward } from './walk-forward.js'
import { formatExpectancyReport, formatMetricsSummary } from './report.js'
import { formatPipelineStats } from '../strategy/diagnostics.js'
import { getStrategyRegistry } from '../strategy/registry.js'
import { LayeredStrategyAdapter } from '../strategy/strategies/layered/index.js'
import { QuantStrategyAdapter } from '../strategy/strategies/quant/index.js'
import { SmcSdStrategy } from '../strategy/strategies/smc-sd/index.js'
import {
  BACKTEST_SLIPPAGE_PCT,
  BACKTEST_COMMISSION_PCT,
  HTF_MAP,
  TIMEFRAME_MS,
  WF_TRAIN_WINDOW_MS,
  WF_TEST_WINDOW_MS,
  WF_STEP_MS,
} from '../config.js'
import type { WalkForwardConfig } from './types.js'
import { log } from '../lib/logger.js'

// ─── Configuration ─────────────────────────────────────────────────────────

/** Coins to backtest — top liquid USDT perps on Bybit.
 *  Note: Bybit uses 1000PEPE not PEPE for symbol. Excluded to avoid mismatch. */
const COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP',
  'DOGE', 'AVAX', 'LINK', 'ARB', 'SUI',
  'WLD', 'INJ', 'TIA', 'SEI', 'ONDO',
]

/** Timeframes to scan.
 * 5m added for ICT micro-entry (4h POI → 15m CHoCH → 5m FVG entry).
 * 4h for POI registration, 15m for confirmation, 5m for entry, 1h for same-TF. */
const TIMEFRAMES: CandleInterval[] = ['5m', '15m', '1h', '4h']

/** How many candles to fetch per TF (Bybit allows large history). */
const CANDLE_COUNTS: Record<CandleInterval, number> = {
  '1m': 500,
  '5m': 5000,   // ~17 days — overlap with 15m for drill-down
  '15m': 5000,
  '1h': 5000,
  '4h': 5000,
  '1d': 2000,
}

/** HTF warmup candles needed for Layer 1 bias (computeHTFBias). */
const HTF_WARMUP_CANDLES = 50

/** Initial capital for backtest (USD). */
const INITIAL_CAPITAL = 10_000

/** Bybit taker fee = 0.055% (higher than HL's 0.03%). */
const BYBIT_COMMISSION_PCT = 0.00055

// ─── Helpers ───────────────────────────────────────────────────────────────

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

/** Fetch all coin × TF candles into memory Map. */
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
      const isHTF = extraHTFs.includes(tf)
      // For HTF warmup: fetch extra candles
      const fetchCount = isHTF ? count + HTF_WARMUP_CANDLES : count

      const candles = await fetchBybitCandlesBatched(coin, tf, fetchCount)
      done++

      if (candles === null) {
        log.warn('bb-backtest', `[${done}/${total}] ${coin} ${tf}: FAILED — skipping`)
        continue
      }

      const key = `${coin}|${tf}`
      result.set(key, candles)
      log.info('bb-backtest', `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles`)
    }
  }

  return result
}

/** Print trade details table. */
function printTradeDetails(trades: import('./types.js').BacktestTrade[]): void {
  if (trades.length === 0) return

  console.log(`\n=== TRADE DETAIL (${trades.length} trades) ===`)
  console.log('  Coin    TF    Side   Entry       SL          TP          SL%     TP%     R:R    PnL      Exit     Bars')

  for (const t of trades) {
    const slPct = Math.abs(t.entryPrice - t.slPrice) / t.entryPrice * 100
    const tpPct = Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice * 100
    const rr = slPct > 0 ? tpPct / slPct : 0
    const fmt = (n: number) => n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(4) : n.toFixed(6)
    console.log(`  ${t.coin.padEnd(7)} ${t.interval.padEnd(5)} ${t.side.padEnd(6)} ${fmt(t.entryPrice).padEnd(11)} ${fmt(t.slPrice).padEnd(11)} ${fmt(t.tpPrice).padEnd(11)} ${slPct.toFixed(2).padStart(5)}%  ${tpPct.toFixed(2).padStart(5)}%  ${rr.toFixed(2).padStart(4)}  ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2).padStart(8)}  ${t.exitReason.padEnd(8)} ${t.holdingBars}`)
  }

  // Summary stats
  const slPcts = trades.map(t => Math.abs(t.entryPrice - t.slPrice) / t.entryPrice * 100)
  const tpPcts = trades.map(t => Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice * 100)
  const rrs = slPcts.map((sl, i) => sl > 0 ? tpPcts[i]! / sl : 0)
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length

  console.log('  ───────────────────────────────────────────────────────────────────────────────────────')
  console.log(`  AVG SL%: ${avg(slPcts).toFixed(2)}%  |  AVG TP%: ${avg(tpPcts).toFixed(2)}%  |  AVG R:R: ${avg(rrs).toFixed(2)}  |  AVG PnL: $${avg(trades.map(t => t.pnl)).toFixed(2)}`)

  // Partial close breakdown
  const withPartials = trades.filter(t => t.partialCloses && t.partialCloses.length > 0)
  if (withPartials.length > 0) {
    const allPartials = withPartials.flatMap(t => t.partialCloses!)
    const byReason = new Map<string, number>()
    for (const p of allPartials) byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1)
    console.log(`  Partial closes: ${allPartials.length} across ${withPartials.length} trades`)
    for (const [reason, count] of byReason) console.log(`    ${reason}: ${count}`)
  }
  console.log('==========================================')
}

/** Run backtest + walk-forward for a single strategy and print results. */
function runStrategyBacktest(
  candles: Map<string, Candle[]>,
  strategy: StrategyType,
): void {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  STRATEGY: ${strategy.toUpperCase()} (Bybit data)`)
  console.log('='.repeat(60))

  const backtestConfig: BacktestConfig = {
    coins: COINS,
    timeframes: TIMEFRAMES,
    initialCapital: INITIAL_CAPITAL,
    slippagePct: BACKTEST_SLIPPAGE_PCT,
    commissionPct: BYBIT_COMMISSION_PCT,
    strategy,
  }

  // Diagnostic backtest (full range)
  const diagResult = runBacktest(candles, backtestConfig)

  if (diagResult.pipelineStats) {
    console.log('\n' + formatPipelineStats(diagResult.pipelineStats))
  }

  log.info('bb-backtest', `${strategy}: ${diagResult.trades.length} trades on full dataset`)
  printTradeDetails(diagResult.trades)

  // Walk-forward validation
  const wfConfig: WalkForwardConfig = {
    backtestConfig,
    trainWindowMs: WF_TRAIN_WINDOW_MS,
    testWindowMs: WF_TEST_WINDOW_MS,
    stepMs: WF_STEP_MS,
  }

  const wfResult = walkForward(candles, wfConfig)
  console.log('\n' + formatExpectancyReport(wfResult))
  console.log('\n' + formatMetricsSummary(wfResult.isMetrics, 'IS'))
  console.log(formatMetricsSummary(wfResult.oosMetrics, 'OOS'))

  if (wfResult.passesGate) {
    log.info('bb-backtest', `${strategy}: GATE PASSED`)
  } else {
    log.warn('bb-backtest', `${strategy}: GATE FAILED`)
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Register strategies (required before engine can use them)
  const registry = getStrategyRegistry()
  try { registry.register(new LayeredStrategyAdapter()) } catch { /* already registered */ }
  try { registry.register(new QuantStrategyAdapter()) } catch { /* already registered */ }
  try { registry.register(new SmcSdStrategy()) } catch { /* already registered */ }

  const arg = process.argv[2] ?? 'all'
  const strategies: StrategyType[] = arg === 'all'
    ? ['layered', 'quant', 'smc-sd']
    : [arg as StrategyType]

  console.log('='.repeat(60))
  console.log('  BYBIT BACKTEST RUNNER')
  console.log(`  Coins: ${COINS.join(', ')}`)
  console.log(`  Timeframes: ${TIMEFRAMES.join(', ')}`)
  console.log(`  Strategies: ${strategies.join(', ')}`)
  console.log(`  Commission: ${(BYBIT_COMMISSION_PCT * 100).toFixed(3)}% (Bybit taker)`)
  console.log('='.repeat(60))

  // Step 1: Fetch candles from Bybit REST
  const extraHTFs = computeExtraHTFs(TIMEFRAMES)
  if (extraHTFs.length > 0) {
    log.info('bb-backtest', `Extra HTF intervals for bias warmup: ${extraHTFs.join(', ')}`)
  }

  log.info('bb-backtest', 'Fetching candles from Bybit REST API...')
  const candles = await fetchAllCandles(COINS, TIMEFRAMES, extraHTFs)

  let totalCandles = 0
  for (const [, series] of candles) totalCandles += series.length

  if (totalCandles === 0) {
    log.error('bb-backtest', 'No candle data fetched. Check network / Bybit API availability.')
    process.exit(1)
  }

  log.info('bb-backtest', `Total: ${totalCandles} candles across ${candles.size} series`)

  // Step 2: Run backtest for each strategy
  for (const strategy of strategies) {
    runStrategyBacktest(candles, strategy)
  }

  log.info('bb-backtest', 'Done.')
}

main().catch(err => {
  log.error('bb-backtest', `Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
