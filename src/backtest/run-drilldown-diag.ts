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
import type { BacktestConfig, WalkForwardConfig } from './types.js'
import { fetchBybitCandlesBatched } from '../feed/bybit/bybit-rest.js'
import { runTrial } from './optimize.js'
import { getStrategyRegistry } from '../strategy/registry.js'
import { SmcSdStrategy } from '../strategy/strategies/smc-sd/index.js'
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

  const registry = getStrategyRegistry()
  try { registry.register(new SmcSdStrategy()) } catch { /* already registered */ }

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

  log.info('diag', 'Running 1-trial walk-forward with default params...')
  const start = Date.now()
  const result = runTrial(allCandles, baseConfig, wfConfig, defaultParams, 0)
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
  console.log(`  OOS PF:     ${result.oosPF.toFixed(3)}`)
  console.log(`  Trades:     ${result.tradeCount}`)
  console.log(`  Win rate:   ${(result.winRate * 100).toFixed(1)}%`)
  console.log(`  Max DD:     ${(result.maxDD * 100).toFixed(1)}%`)
  console.log(`  Elapsed:    ${elapsed}s`)
  if (result.tradesByMode) {
    console.log(`  By mode:    ${JSON.stringify(result.tradesByMode)}`)
  }

  console.log('\n' + '='.repeat(60))
}

function pct(num: number, denom: number): string {
  if (denom === 0) return 'N/A'
  return `${((num / denom) * 100).toFixed(1)}%`
}

main().catch(e => { console.error(e); process.exit(1) })
