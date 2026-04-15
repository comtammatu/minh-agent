/**
 * Drilldown cascade diagnostic runner.
 *
 * Runs a single optimizer trial with default params and prints
 * detailed stage-by-stage counters showing where the 4H→15m→5m
 * cascade drops to zero.
 *
 * Usage: bun run src/backtest/run-drilldown-diag.ts [coins]
 *   coins: comma-separated (default: BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM)
 */

import type { Candle, CandleInterval } from '../types.js'
import type { BacktestConfig, BacktestTrade, WalkForwardConfig } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { inferScanMode, runTrial } from './optimize.js'
import { runBacktest } from './engine.js'
import { walkForward } from './walk-forward.js'
import { computeMetrics } from './metrics.js'
import { getDrilldownDiagnostics, resetDrilldownDiagnostics } from '../strategy/strategies/smc-sd/index.js'
import {
  BACKTEST_SLIPPAGE_PCT,
  HTF_MAP,
  WF_TRAIN_WINDOW_MS,
  WF_TEST_WINDOW_MS,
  WF_STEP_MS,
} from '../config.js'
import { log } from '../lib/logger.js'

const TIMEFRAMES: CandleInterval[] = ['5m', '15m', '1h', '4h']

/** Top-3 liquidity tier for 1h_same_tf vs universe comparison (diagnostic only). */
const TOP3_COINS = new Set(['BTC', 'ETH', 'SOL'])

const CANDLE_COUNTS: Record<CandleInterval, number> = {
  '1m': 500, '5m': 8_640, '15m': 17_280, '1h': 5_000, '4h': 5_000, '1d': 2_000,
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
        log.warn('diag', `[${done}/${total}] ${coin} ${tf}: FAILED`)
        continue
      }
      result.set(`${coin}|${tf}`, candles)
      log.info('diag', `[${done}/${total}] ${coin} ${tf}: ${candles.length} candles`)
    }
  }
  return result
}

async function main() {
  const coins = (process.argv[2] ?? 'BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM').split(',')

  console.log('='.repeat(60))
  console.log('  DRILLDOWN CASCADE DIAGNOSTIC')
  console.log(`  Coins: ${coins.join(', ')}`)
  console.log('='.repeat(60))

  // Fetch candles
  log.info('diag', 'Fetching candles from Bybit...')
  const extraHTFs = computeExtraHTFs(TIMEFRAMES)
  const allCandles = await fetchAllCandles(coins, TIMEFRAMES, extraHTFs)

  let totalCandles = 0
  for (const [, series] of allCandles) totalCandles += series.length
  if (totalCandles === 0) { log.error('diag', 'No candle data. Aborting.'); process.exit(1) }
  log.info('diag', `Total: ${totalCandles} candles across ${allCandles.size} series`)

  // Use all data (no train/holdout split — we want max signal count for diagnostics)
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

  // Default params (no optimization — just see what the cascade does with defaults)
  const defaultParams = {}

  // Reset diagnostics before run
  resetDrilldownDiagnostics()

  const configWithParams: BacktestConfig = {
    ...baseConfig,
    strategyParams: defaultParams,
  }
  const wfConfigWithParams: WalkForwardConfig = {
    ...wfConfig,
    backtestConfig: configWithParams,
  }

  log.info('diag', 'Running 1-trial walk-forward with default params...')
  const start = Date.now()
  const wfResult = walkForward(allCandles, wfConfigWithParams)
  const oosTrades = wfResult.windows.flatMap(w => w.testTrades ?? [])
  const tradesByMode = oosTrades.reduce((acc, t) => {
    const mode = inferScanMode(t.interval)
    acc[mode] = (acc[mode] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  const result = {
    oosPF: wfResult.oosMetrics.profitFactor,
    tradeCount: wfResult.oosMetrics.totalTrades,
    winRate: wfResult.oosMetrics.winRate,
    maxDD: wfResult.oosMetrics.maxDrawdown,
    tradesByMode,
  }
  const oosTrades1h = oosTrades.filter(t => t.interval === '1h')
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  // Get diagnostics
  const d = getDrilldownDiagnostics()

  console.log('\n' + '='.repeat(60))
  console.log('  DRILLDOWN CASCADE DIAGNOSTICS')
  console.log('='.repeat(60))

  console.log('\n── 4H STAGE (POI Registration) ──')
  console.log(`  Calls:           ${d.scan4h_calls}`)
  console.log(`  No break:        ${d.scan4h_no_break} (${pct(d.scan4h_no_break, d.scan4h_calls)})`)
  console.log(`  No zones:        ${d.scan4h_no_zones} (${pct(d.scan4h_no_zones, d.scan4h_calls)})`)
  console.log(`  POIs registered: ${d.scan4h_pois_registered}`)
  console.log(`  Swing signals:   ${d.scan4h_swing_signals}`)

  console.log('\n── 15M STAGE (POI Confirmation) ──')
  console.log(`  Calls:              ${d.scan15m_calls}`)
  console.log(`  No HTF POIs:        ${d.scan15m_no_htf_pois} (${pct(d.scan15m_no_htf_pois, d.scan15m_calls)})`)
  console.log(`  POIs expired:       ${d.scan15m_pois_expired}`)
  console.log(`  POIs checked:       ${d.scan15m_pois_checked}`)
  console.log(`  Not at zone:        ${d.scan15m_not_at_zone} (${pct(d.scan15m_not_at_zone, d.scan15m_pois_checked)})`)
  console.log(`  No confirm break:   ${d.scan15m_no_confirm_break} (${pct(d.scan15m_no_confirm_break, d.scan15m_pois_checked)})`)
  console.log(`  Already confirmed:  ${d.scan15m_already_confirmed}`)
  console.log(`  ✓ CONFIRMED:        ${d.scan15m_confirmed}`)
  console.log(`  Scalp signals:      ${d.scan15m_scalp_signals}`)

  console.log('\n── 5M STAGE (Micro Entry) ──')
  console.log(`  Calls:              ${d.scan5m_calls}`)
  console.log(`  No confirmed POIs:  ${d.scan5m_no_confirmed_pois} (${pct(d.scan5m_no_confirmed_pois, d.scan5m_calls)})`)
  console.log(`  POIs expired:       ${d.scan5m_pois_expired}`)
  console.log(`  Not at zone:        ${d.scan5m_not_at_zone}`)
  console.log(`  No FVG:             ${d.scan5m_no_fvg}`)
  console.log(`  Body rejected:      ${d.scan5m_body_rejected}`)
  console.log(`  SL too wide:        ${d.scan5m_sl_too_wide}`)
  console.log(`  SL too tight:       ${d.scan5m_sl_too_tight}`)
  console.log(`  Require CHoCH fail: ${d.scan5m_require_choch_fail}`)
  console.log(`  R:R too low:        ${d.scan5m_rr_too_low}`)
  console.log(`  Confidence too low: ${d.scan5m_confidence_too_low}`)
  console.log(`  ✓ SIGNALS:          ${d.scan5m_signals}`)

  console.log('\n── CASCADE FUNNEL ──')
  console.log(`  4H POIs → 15m confirmed → 5m signals`)
  console.log(`  ${d.scan4h_pois_registered} → ${d.scan15m_confirmed} → ${d.scan5m_signals}`)
  const convRate15m = d.scan4h_pois_registered > 0
    ? ((d.scan15m_confirmed / d.scan4h_pois_registered) * 100).toFixed(2)
    : 'N/A'
  const convRate5m = d.scan15m_confirmed > 0
    ? ((d.scan5m_signals / d.scan15m_confirmed) * 100).toFixed(2)
    : 'N/A'
  console.log(`  4H→15m conv: ${convRate15m}%`)
  console.log(`  15m→5m conv: ${convRate5m}%`)

  console.log('\n── TRIAL RESULT ──')
  console.log(`  OOS PF:     ${formatPf(result.oosPF)}`)
  console.log(`  Trades:     ${result.tradeCount}`)
  console.log(`  Win rate:   ${(result.winRate * 100).toFixed(1)}%`)
  console.log(`  Max DD:     ${(result.maxDD * 100).toFixed(1)}%`)
  console.log(`  Elapsed:    ${elapsed}s`)
  if (result.tradesByMode) {
    console.log(`  By mode:    ${JSON.stringify(result.tradesByMode)}`)
  }

  console.log('\n── OOS per-coin (1h_same_tf / interval=1h) ──')
  const wfCoinRows = computeCoinStats(oosTrades1h, baseConfig.initialCapital)
  if (wfCoinRows.length === 0) {
    console.log('  (no OOS 1h trades)')
  } else {
    console.log(`  ${'coin'.padEnd(8)} | ${'trades'.padStart(6)} | ${'PF'.padStart(8)} | ${'WR'.padStart(7)} | ${'net PnL'.padStart(10)}`)
    console.log(`  ${'-'.repeat(52)}`)
    for (const w of wfCoinRows) {
      const pfStr = formatPf(w.pf)
      console.log(
        `  ${w.coin.padEnd(8)} | ${String(w.trades).padStart(6)} | ${pfStr.padStart(8)} | ${(w.wr * 100).toFixed(1).padStart(6)}% | $${w.netPnl.toFixed(2).padStart(9)}`,
      )
    }
    const profitable = wfCoinRows.filter(w => w.netPnl > 0).map(w => w.coin)
    const losing = wfCoinRows.filter(w => w.netPnl <= 0).map(w => w.coin)
    console.log(`  Profitable coins: ${profitable.length ? profitable.join(', ') : '(none)'}`)
    console.log(`  Losing / flat:    ${losing.length ? losing.join(', ') : '(none)'}`)
  }

  console.log('\n' + '='.repeat(60))

  // ── ISOLATED 5M DRILLDOWN (disable 1h + 15m to eliminate slot contention) ──
  console.log('\n\n' + '='.repeat(60))
  console.log('  ISOLATED 5M DRILLDOWN (1h_same_tf + 15m_drilldown disabled)')
  console.log('='.repeat(60))

  const isolatedConfig: BacktestConfig = {
    ...baseConfig,
    disabledScanModes: ['1h_same_tf', '15m_drilldown'],
  }

  const isolatedWfConfig: WalkForwardConfig = {
    ...wfConfig,
    backtestConfig: isolatedConfig,
  }

  resetDrilldownDiagnostics()
  log.info('diag', 'Running isolated 5m drilldown trial (1h+15m disabled)...')
  const isoStart = Date.now()
  const isoResult = runTrial(allCandles, isolatedConfig, isolatedWfConfig, defaultParams, 0)
  const isoElapsed = ((Date.now() - isoStart) / 1000).toFixed(1)

  console.log('\n── ISOLATED 5M RESULT ──')
  console.log(`  Trades:     ${isoResult.tradeCount}`)
  console.log(`  OOS PF:     ${formatPf(isoResult.oosPF)}`)
  console.log(`  Win rate:   ${(isoResult.winRate * 100).toFixed(1)}%`)
  console.log(`  Max DD:     ${(isoResult.maxDD * 100).toFixed(1)}%`)
  console.log(`  Elapsed:    ${isoElapsed}s`)
  if (isoResult.tradesByMode) {
    console.log(`  By mode:    ${JSON.stringify(isoResult.tradesByMode)}`)
  }

  console.log('\n── COMPARISON ──')
  console.log(`  Full run:     ${result.tradeCount} trades (PF ${formatPf(result.oosPF)})`)
  console.log(`  Isolated 5m:  ${isoResult.tradeCount} trades (PF ${formatPf(isoResult.oosPF)})`)
  const delta = isoResult.tradeCount - (result.tradesByMode?.['5m_micro'] ?? 0)
  console.log(`  5m trades unlocked by removing contention: ${delta}`)

  console.log('\n' + '='.repeat(60))

  // ── RAW 5M BACKTEST (no walk-forward, all data) ──
  console.log('\n\n' + '='.repeat(60))
  console.log('  RAW 5M BACKTEST (no WF)')
  console.log('='.repeat(60))

  resetDrilldownDiagnostics()
  log.info('diag', 'Running raw 5m backtest (no walk-forward, all candle data)...')
  const rawStart = Date.now()
  const rawResult = runBacktest(allCandles, isolatedConfig)
  const rawElapsed = ((Date.now() - rawStart) / 1000).toFixed(1)

  const rawMetrics = rawResult.metrics
  const rawTrades = rawResult.trades

  console.log('\n── RAW 5M BACKTEST (no WF) ──')
  console.log(`  Trade count: ${rawMetrics.totalTrades}`)
  console.log(`  PF:          ${rawMetrics.profitFactor === Infinity ? 'Inf' : rawMetrics.profitFactor.toFixed(3)}`)
  console.log(`  Win rate:    ${(rawMetrics.winRate * 100).toFixed(1)}%`)
  console.log(`  Max DD:      ${(rawMetrics.maxDrawdown * 100).toFixed(1)}%`)
  console.log(`  Net PnL:     $${rawMetrics.netPnl.toFixed(2)}`)
  console.log(`  Expectancy:  $${rawMetrics.expectancy.toFixed(2)}`)
  console.log(`  Elapsed:     ${rawElapsed}s`)

  if (rawTrades.length > 0 && rawTrades.length < 20) {
    console.log('\n── INDIVIDUAL TRADES ──')
    for (const t of rawTrades) {
      const pnlSign = t.pnl >= 0 ? '+' : ''
      console.log(
        `  ${t.coin} ${t.side.toUpperCase()} ${t.interval} | ` +
        `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} | ` +
        `pnl=${pnlSign}${(t.pnlPct * 100).toFixed(2)}% ($${pnlSign}${t.pnl.toFixed(2)}) | ` +
        `reason=${t.exitReason}`
      )
    }
  } else if (rawTrades.length >= 20) {
    console.log(`\n  (${rawTrades.length} trades — too many to list individually)`)
  }

  console.log('\n' + '='.repeat(60))

  // ── RAW 1H BACKTEST (no WF) — 1h_same_tf coin-level quality ──
  console.log('\n\n' + '='.repeat(60))
  console.log('  RAW 1H BACKTEST (no WF)')
  console.log('='.repeat(60))

  const config1hOnly: BacktestConfig = {
    ...baseConfig,
    disabledScanModes: ['5m_micro', '15m_drilldown', '4h_poi'],
  }

  resetDrilldownDiagnostics()
  log.info('diag', 'Running raw 1h-only backtest (no walk-forward, all candle data)...')
  const raw1hStart = Date.now()
  const raw1hResult = runBacktest(allCandles, config1hOnly)
  const raw1hElapsed = ((Date.now() - raw1hStart) / 1000).toFixed(1)

  const raw1hMetrics = raw1hResult.metrics
  const raw1hTrades = raw1hResult.trades.filter(t => t.interval === '1h')

  console.log('\n── RAW 1H BACKTEST (no WF) — aggregate ──')
  console.log(`  Trade count: ${raw1hMetrics.totalTrades} (1h interval rows: ${raw1hTrades.length})`)
  console.log(`  PF:          ${raw1hMetrics.profitFactor === Infinity ? 'Inf' : raw1hMetrics.profitFactor.toFixed(3)}`)
  console.log(`  Win rate:    ${(raw1hMetrics.winRate * 100).toFixed(1)}%`)
  console.log(`  Max DD:      ${(raw1hMetrics.maxDrawdown * 100).toFixed(1)}%`)
  console.log(`  Net PnL:     $${raw1hMetrics.netPnl.toFixed(2)}`)
  console.log(`  Elapsed:     ${raw1hElapsed}s`)

  console.log('\n── RAW 1H per-coin (quality tiers: heuristic) ──')
  const rawCoinRows = computeCoinStats(raw1hTrades, baseConfig.initialCapital)
  if (rawCoinRows.length === 0) {
    console.log('  (no raw 1h trades)')
  } else {
    console.log(`  ${'coin'.padEnd(8)} | ${'trades'.padStart(6)} | ${'PF'.padStart(8)} | ${'WR'.padStart(7)} | tier`)
    console.log(`  ${'-'.repeat(56)}`)
    for (const w of rawCoinRows) {
      const tier =
        w.pf >= 1.25 && w.wr >= 0.4 ? 'A (strong)'
        : w.pf >= 1.0 ? 'B (ok)'
        : w.netPnl > 0 ? 'C+ (marginal)'
        : 'C- (losing)'
      const pfStr = formatPf(w.pf)
      console.log(
        `  ${w.coin.padEnd(8)} | ${String(w.trades).padStart(6)} | ${pfStr.padStart(8)} | ${(w.wr * 100).toFixed(1).padStart(6)}% | ${tier}`,
      )
    }
  }

  const top3Trades = raw1hTrades.filter(t => TOP3_COINS.has(t.coin))
  const restTrades = raw1hTrades.filter(t => !TOP3_COINS.has(t.coin))
  const mTop3 = top3Trades.length > 0 ? computeMetrics(top3Trades, baseConfig.initialCapital) : null
  const mRest = restTrades.length > 0 ? computeMetrics(restTrades, baseConfig.initialCapital) : null

  console.log('\n── Top-3 (BTC, ETH, SOL) vs remaining coins (raw 1h) ──')
  console.log(`  ${'tier'.padEnd(12)} | ${'trades'.padStart(6)} | ${'PF'.padStart(8)} | ${'WR'.padStart(7)} | ${'net PnL'.padStart(10)}`)
  console.log(`  ${'-'.repeat(58)}`)
  if (mTop3) {
    console.log(
      `  ${'Top-3'.padEnd(12)} | ${String(mTop3.totalTrades).padStart(6)} | ${formatPf(mTop3.profitFactor).padStart(8)} | ${(mTop3.winRate * 100).toFixed(1).padStart(6)}% | $${mTop3.netPnl.toFixed(2).padStart(9)}`,
    )
  } else {
    console.log(`  ${'Top-3'.padEnd(12)} | ${String(0).padStart(6)} | ${'N/A'.padStart(8)} | ${'N/A'.padStart(7)} | ${'N/A'.padStart(10)}`)
  }
  if (mRest) {
    console.log(
      `  ${'Rest'.padEnd(12)} | ${String(mRest.totalTrades).padStart(6)} | ${formatPf(mRest.profitFactor).padStart(8)} | ${(mRest.winRate * 100).toFixed(1).padStart(6)}% | $${mRest.netPnl.toFixed(2).padStart(9)}`,
    )
  } else {
    console.log(`  ${'Rest'.padEnd(12)} | ${String(0).padStart(6)} | ${'N/A'.padStart(8)} | ${'N/A'.padStart(7)} | ${'N/A'.padStart(10)}`)
  }

  let decisionLine = ''
  if (mTop3 && mRest) {
    if (mTop3.profitFactor > mRest.profitFactor && mTop3.netPnl > mRest.netPnl) {
      decisionLine =
        'Top-3 shows higher PF and net PnL than the rest — coin filter is a plausible experiment; validate on WF OOS before hardcoding.'
    } else if (mRest.profitFactor > mTop3.profitFactor) {
      decisionLine =
        'Non-top-3 aggregate PF exceeds Top-3 — do not restrict to BTC/ETH/SOL based on this raw run alone; use per-coin tiers.'
    } else {
      decisionLine = 'Mixed tier metrics — rely on per-coin table + WF OOS before changing universe.'
    }
  } else if (mTop3 && !mRest) {
    decisionLine = 'Only Top-3 coins have raw 1h trades in this dataset — compare WF OOS for coin selection.'
  } else {
    decisionLine = 'Insufficient data for Top-3 vs rest split.'
  }
  console.log(`\n  Decision: ${decisionLine}`)

  const top3Pf = mTop3?.profitFactor ?? 0
  const top3PfBelow1 = isFinite(top3Pf) && top3Pf < 1
  if (top3Trades.length > 0 && top3PfBelow1) {
    console.log('\n── Deep dive: Top-3 raw 1h PF < 1 — exitReason / confluenceGrade / loss streaks ──')
    printExitReasonBreakdown(top3Trades)
    printConfluenceGradeBreakdown(top3Trades)
    printMaxConsecutiveLossStreak(top3Trades)
  } else if (top3Trades.length > 0 && isFinite(top3Pf) && top3Pf >= 1) {
    console.log('\n── Deep dive: skipped (Top-3 raw 1h PF >= 1 or Inf) ──')
  }

  console.log('\n' + '='.repeat(60))
}

function computeCoinStats(
  trades: BacktestTrade[],
  initialCapital: number,
): Array<{ coin: string; trades: number; pf: number; wr: number; netPnl: number }> {
  const byCoin = new Map<string, BacktestTrade[]>()
  for (const t of trades) {
    const list = byCoin.get(t.coin) ?? []
    list.push(t)
    byCoin.set(t.coin, list)
  }
  const rows: Array<{ coin: string; trades: number; pf: number; wr: number; netPnl: number }> = []
  for (const [coin, list] of byCoin) {
    const m = computeMetrics(list, initialCapital)
    rows.push({
      coin,
      trades: list.length,
      pf: m.profitFactor,
      wr: m.winRate,
      netPnl: m.netPnl,
    })
  }
  return rows.sort((a, b) => b.netPnl - a.netPnl)
}

function formatPf(pf: number): string {
  if (pf === Infinity || pf === -Infinity) return 'Inf'
  if (!isFinite(pf)) return 'N/A'
  return pf.toFixed(3)
}

function printExitReasonBreakdown(trades: BacktestTrade[]): void {
  const m = new Map<string, { count: number; pnl: number }>()
  for (const t of trades) {
    const r = m.get(t.exitReason) ?? { count: 0, pnl: 0 }
    r.count++
    r.pnl += t.pnl
    m.set(t.exitReason, r)
  }
  console.log('  By exitReason (Top-3 raw 1h):')
  const sorted = [...m.entries()].sort((a, b) => b[1].pnl - a[1].pnl)
  for (const [reason, v] of sorted) {
    const sign = v.pnl >= 0 ? '+' : ''
    console.log(`    ${reason.padEnd(14)} | n=${String(v.count).padStart(4)} | net ${sign}$${v.pnl.toFixed(2)}`)
  }
}

function printConfluenceGradeBreakdown(trades: BacktestTrade[]): void {
  const agg = new Map<string, { count: number; pnl: number }>()
  for (const t of trades) {
    const g = t.confluenceGrade === null ? 'null' : String(t.confluenceGrade)
    const r = agg.get(g) ?? { count: 0, pnl: 0 }
    r.count++
    r.pnl += t.pnl
    agg.set(g, r)
  }
  console.log('  By confluenceGrade:')
  const sorted = [...agg.entries()].sort((a, b) => b[1].pnl - a[1].pnl)
  for (const [grade, v] of sorted) {
    const sign = v.pnl >= 0 ? '+' : ''
    console.log(`    ${grade.padEnd(8)} | n=${String(v.count).padStart(4)} | net ${sign}$${v.pnl.toFixed(2)}`)
  }
}

function printMaxConsecutiveLossStreak(trades: BacktestTrade[]): void {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime)
  let maxStreak = 0
  let cur = 0
  for (const t of sorted) {
    if (t.pnl <= 0) {
      cur++
      maxStreak = Math.max(maxStreak, cur)
    } else {
      cur = 0
    }
  }
  console.log(`  Max consecutive losing trades (pnl <= 0, exit time order): ${maxStreak}`)
}

function pct(num: number, denom: number): string {
  if (denom === 0) return 'N/A'
  return `${((num / denom) * 100).toFixed(1)}%`
}

main().catch(e => { console.error(e); process.exit(1) })
