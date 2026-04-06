/**
 * Script: Run quant vs layered backtest comparison.
 * Usage: bun run scripts/run-quant-backtest.ts
 *
 * Downloads 3 months of data for BTC/ETH/SOL, runs both strategies,
 * prints comparison table.
 */

import { BacktestDataManager } from '../src/backtest/data-manager.js'
import { runBacktest } from '../src/backtest/engine.js'
import { formatPipelineStats } from '../src/scanner/pipeline.js'
import type { BacktestConfig } from '../src/backtest/types.js'
import type { CandleInterval } from '../src/types.js'
import { computeHTFIntervals, computeHTFWarmupMs } from '../src/backtest/data-manager.js'
import { getStrategyRegistry } from '../src/scanner/strategy.js'
import { LayeredStrategyAdapter } from '../src/scanner/strategies/layered-adapter.js'
import { QuantStrategyAdapter } from '../src/scanner/strategies/quant-adapter.js'
import { SmcSdStrategy } from '../src/scanner/strategies/smc-sd.js'

// Configurable via CLI args: bun run scripts/run-quant-backtest.ts [months] [coins...]
const args = process.argv.slice(2)
const months = args.length > 0 ? parseInt(args[0]!, 10) || 6 : 3

const defaultCoins = ['BTC', 'ETH', 'SOL', 'DOGE', 'HYPE']
const coins = args.length > 1 ? args.slice(1) : defaultCoins

// Skip 1m: EMA(200) on 1m = 3.3h lookback (meaningless for trend), and 6-month 1m data = 260K candles/coin (too slow to download)
const timeframes: CandleInterval[] = ['5m', '15m', '1h', '4h', '1d']
const initialCapital = 10_000

async function main() {
  console.log('=== Layered vs Quant vs SMC+S&D Backtest Comparison ===')
  console.log(`Coins: ${coins.join(', ')}`)
  console.log(`Timeframes: ${timeframes.join(', ')}`)
  console.log(`Period: ${months} months`)
  console.log('')

  // Download data
  console.log('Downloading historical data...')
  const dm = new BacktestDataManager()
  const endDate = new Date()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - months)

  const extraHTFs = computeHTFIntervals(timeframes)

  for (const coin of coins) {
    for (const tf of timeframes) {
      await dm.downloadHistory(coin, tf, startDate, endDate)
    }
    for (const htf of extraHTFs) {
      const warmupMs = computeHTFWarmupMs(htf)
      const htfStart = new Date(startDate.getTime() - warmupMs)
      await dm.downloadHistory(coin, htf, htfStart, endDate)
    }
  }

  // Register strategies before running backtests
  const reg = getStrategyRegistry()
  reg.register(new LayeredStrategyAdapter())
  reg.register(new QuantStrategyAdapter())
  reg.register(new SmcSdStrategy())

  console.log('Loading candles...')
  const candles = await dm.loadForBacktest(coins, timeframes, startDate, endDate)
  console.log(`Loaded ${candles.size} candle series`)
  console.log('')

  // Run layered backtest
  console.log('--- Running LAYERED strategy ---')
  const layeredConfig: BacktestConfig = {
    coins, timeframes, initialCapital,
    slippagePct: 0.0005, commissionPct: 0.0003,
    strategy: 'layered',
  }
  const layeredResult = runBacktest(candles, layeredConfig)
  const layeredStats = layeredResult.pipelineStats
  console.log(`Trades: ${layeredResult.metrics.totalTrades}`)
  console.log(`Net PnL: $${layeredResult.metrics.netPnl.toFixed(2)}`)
  if (layeredStats) console.log(formatPipelineStats(layeredStats))
  console.log('')

  // Run quant backtest (single-exit: one SL, one TP, 100% close, SL/TP from fill price)
  console.log('--- Running QUANT strategy (single-exit) ---')
  const quantConfig: BacktestConfig = {
    coins, timeframes, initialCapital,
    slippagePct: 0.0005, commissionPct: 0.0003,
    strategy: 'quant',
    exitMode: 'single',
  }
  const quantResult = runBacktest(candles, quantConfig)
  const quantStats = quantResult.pipelineStats
  console.log(`Trades: ${quantResult.metrics.totalTrades}`)
  console.log(`Net PnL: $${quantResult.metrics.netPnl.toFixed(2)}`)
  if (quantStats) console.log(formatPipelineStats(quantStats))
  console.log('')

  // Run SMC+S&D backtest
  console.log('--- Running SMC+S&D strategy (single-exit) ---')
  const smcConfig: BacktestConfig = {
    coins, timeframes, initialCapital,
    slippagePct: 0.0005, commissionPct: 0.0003,
    strategy: 'smc-sd',
    exitMode: 'single',
  }
  const smcResult = runBacktest(candles, smcConfig)
  const smcStats = smcResult.pipelineStats
  console.log(`Trades: ${smcResult.metrics.totalTrades}`)
  console.log(`Net PnL: $${smcResult.metrics.netPnl.toFixed(2)}`)
  if (smcStats) console.log(formatPipelineStats(smcStats))
  console.log('')

  // Comparison table
  const m1 = layeredResult.metrics
  const m2 = quantResult.metrics
  const m3 = smcResult.metrics

  console.log('=== COMPARISON ===')
  console.log('+-------------------------+-----------+-----------+-----------+')
  console.log('| Metric                  | Layered   | Quant     | SMC+S&D   |')
  console.log('+-------------------------+-----------+-----------+-----------+')
  const row = (label: string, v1: string, v2: string, v3: string) =>
    console.log(`| ${label.padEnd(23)} | ${v1.padStart(9)} | ${v2.padStart(9)} | ${v3.padStart(9)} |`)

  row('Total trades', String(m1.totalTrades), String(m2.totalTrades), String(m3.totalTrades))
  row('Win rate', `${(m1.winRate * 100).toFixed(1)}%`, `${(m2.winRate * 100).toFixed(1)}%`, `${(m3.winRate * 100).toFixed(1)}%`)
  row('Net PnL', `$${m1.netPnl.toFixed(0)}`, `$${m2.netPnl.toFixed(0)}`, `$${m3.netPnl.toFixed(0)}`)
  row('Expectancy', `$${m1.expectancy.toFixed(2)}`, `$${m2.expectancy.toFixed(2)}`, `$${m3.expectancy.toFixed(2)}`)
  row('Profit Factor', m1.profitFactor.toFixed(2), m2.profitFactor.toFixed(2), m3.profitFactor.toFixed(2))
  row('Max Drawdown', `${(m1.maxDrawdown * 100).toFixed(1)}%`, `${(m2.maxDrawdown * 100).toFixed(1)}%`, `${(m3.maxDrawdown * 100).toFixed(1)}%`)
  row('Sharpe', m1.sharpeRatio.toFixed(2), m2.sharpeRatio.toFixed(2), m3.sharpeRatio.toFixed(2))
  row('Sortino', m1.sortinoRatio.toFixed(2), m2.sortinoRatio.toFixed(2), m3.sortinoRatio.toFixed(2))
  row('Avg R:R', m1.avgRR.toFixed(2), m2.avgRR.toFixed(2), m3.avgRR.toFixed(2))
  row('Avg Hold (bars)', m1.avgHoldingBars.toFixed(0), m2.avgHoldingBars.toFixed(0), m3.avgHoldingBars.toFixed(0))
  console.log('+-------------------------+-----------+-----------+-----------+')

  // Top trades from each strategy
  for (const [name, result] of [['QUANT', quantResult], ['SMC+S&D', smcResult]] as const) {
    if (result.metrics.totalTrades > 0) {
      console.log('')
      console.log(`=== ${name} TOP TRADES ===`)
      const sorted = [...result.trades].sort((a, b) => b.pnl - a.pnl)
      const top5 = sorted.slice(0, 5)
      const bot5 = sorted.slice(-5).reverse()
      console.log('Best:')
      for (const t of top5) {
        console.log(`  ${t.coin} ${t.interval} ${t.side} | pnl=$${t.pnl.toFixed(2)} | exit=${t.exitReason}`)
      }
      console.log('Worst:')
      for (const t of bot5) {
        console.log(`  ${t.coin} ${t.interval} ${t.side} | pnl=$${t.pnl.toFixed(2)} | exit=${t.exitReason}`)
      }
    }
  }

  process.exit(0)
}

main().catch(err => {
  console.error('Backtest failed:', err)
  process.exit(1)
})
