import { BacktestDataManager, computeHTFIntervals, computeHTFWarmupMs } from '../src/backtest/data-manager.js'
import { runBacktest } from '../src/backtest/engine.js'
import type { BacktestConfig } from '../src/backtest/types.js'
import type { CandleInterval } from '../src/types.js'
import { getStrategyRegistry } from '../src/scanner/strategy.js'
import { SmcSdStrategy } from '../src/scanner/strategies/smc-sd/index.js'

const coins = ['BTC','ETH','SOL','DOGE','HYPE','XRP','ADA','AVAX','LINK','DOT','NEAR','SUI','ARB','OP','PEPE']
const timeframes: CandleInterval[] = ['5m','15m','1h','4h','1d']

async function main() {
  const dm = new BacktestDataManager()
  const endDate = new Date()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - 5)
  const extraHTFs = computeHTFIntervals(timeframes)
  for (const coin of coins) {
    for (const tf of timeframes) await dm.downloadHistory(coin, tf, startDate, endDate)
    for (const htf of extraHTFs) {
      await dm.downloadHistory(coin, htf, new Date(startDate.getTime() - computeHTFWarmupMs(htf)), endDate)
    }
  }
  const reg = getStrategyRegistry()
  reg.register(new SmcSdStrategy())
  const candles = await dm.loadForBacktest(coins, timeframes, startDate, endDate)

  const config: BacktestConfig = {
    coins, timeframes, initialCapital: 10_000,
    slippagePct: 0.0005, commissionPct: 0.0003,
    strategy: 'smc-sd', exitMode: 'single',
  }
  const result = runBacktest(candles, config)
  const trades = result.trades

  // By exit reason
  const byExit = new Map<string, {count:number, pnl:number}>()
  for (const t of trades) {
    const e = byExit.get(t.exitReason) ?? {count:0, pnl:0}
    e.count++; e.pnl += t.pnl
    byExit.set(t.exitReason, e)
  }
  console.log('\n=== BY EXIT REASON ===')
  for (const [r, s] of byExit) console.log(`${r}: ${s.count} trades, PnL $${s.pnl.toFixed(0)}`)

  // By TF
  const byTf = new Map<string, {wins:number, losses:number, pnl:number}>()
  for (const t of trades) {
    const e = byTf.get(t.interval) ?? {wins:0, losses:0, pnl:0}
    if (t.pnl > 0) e.wins++; else e.losses++; e.pnl += t.pnl
    byTf.set(t.interval, e)
  }
  console.log('\n=== BY TIMEFRAME ===')
  for (const [tf, s] of [...byTf.entries()].sort()) {
    const total = s.wins + s.losses
    console.log(`${tf}: ${total} trades, WR ${(s.wins/total*100).toFixed(1)}%, PnL $${s.pnl.toFixed(0)}`)
  }

  // By side
  const bySide = new Map<string, {wins:number, losses:number, pnl:number}>()
  for (const t of trades) {
    const e = bySide.get(t.side) ?? {wins:0, losses:0, pnl:0}
    if (t.pnl > 0) e.wins++; else e.losses++; e.pnl += t.pnl
    bySide.set(t.side, e)
  }
  console.log('\n=== BY SIDE ===')
  for (const [side, s] of bySide) {
    const total = s.wins + s.losses
    console.log(`${side}: ${total} trades, WR ${(s.wins/total*100).toFixed(1)}%, PnL $${s.pnl.toFixed(0)}`)
  }

  // Hold time distribution
  const holds = trades.map(t => t.holdingBars)
  holds.sort((a,b) => a-b)
  const p25 = holds[Math.floor(holds.length*0.25)]
  const p50 = holds[Math.floor(holds.length*0.50)]
  const p75 = holds[Math.floor(holds.length*0.75)]
  const p90 = holds[Math.floor(holds.length*0.90)]
  console.log(`\n=== HOLD TIME (bars) ===`)
  console.log(`P25: ${p25}, P50: ${p50}, P75: ${p75}, P90: ${p90}, Max: ${holds[holds.length-1]}`)

  // R:R distribution
  const winners = trades.filter(t => t.pnl > 0)
  const losers = trades.filter(t => t.pnl < 0)
  console.log(`\n=== PNL DISTRIBUTION ===`)
  console.log(`Winners: ${winners.length}, avg $${(winners.reduce((s,t)=>s+t.pnl,0)/winners.length).toFixed(0)}`)
  console.log(`Losers: ${losers.length}, avg $${(losers.reduce((s,t)=>s+t.pnl,0)/losers.length).toFixed(0)}`)

  // end_of_data trades analysis
  const eodTrades = trades.filter(t => t.exitReason === 'end_of_data')
  if (eodTrades.length > 0) {
    const eodWins = eodTrades.filter(t => t.pnl > 0).length
    const eodAvgHold = eodTrades.reduce((s,t) => s+t.holdingBars, 0) / eodTrades.length
    console.log(`\n=== END_OF_DATA TRADES ===`)
    console.log(`Count: ${eodTrades.length}, WR: ${(eodWins/eodTrades.length*100).toFixed(1)}%, Avg hold: ${eodAvgHold.toFixed(0)} bars`)
    console.log(`PnL: $${eodTrades.reduce((s,t)=>s+t.pnl,0).toFixed(0)}`)
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
