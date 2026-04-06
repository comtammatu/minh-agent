import { BacktestDataManager, computeHTFIntervals, computeHTFWarmupMs } from '../src/backtest/data-manager.js'
import { runBacktest } from '../src/backtest/engine.js'
import type { BacktestConfig } from '../src/backtest/types.js'
import type { CandleInterval } from '../src/types.js'
import { getStrategyRegistry } from '../src/scanner/strategy.js'
import { QuantStrategyAdapter } from '../src/scanner/strategies/quant-adapter.js'

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
      const htfStart = new Date(startDate.getTime() - computeHTFWarmupMs(htf))
      await dm.downloadHistory(coin, htf, htfStart, endDate)
    }
  }
  
  const reg = getStrategyRegistry()
  reg.register(new QuantStrategyAdapter())
  
  const candles = await dm.loadForBacktest(coins, timeframes, startDate, endDate)
  
  const config: BacktestConfig = {
    coins, timeframes, initialCapital: 10_000,
    slippagePct: 0.0005, commissionPct: 0.0003,
    strategy: 'quant', exitMode: 'single',
  }
  const result = runBacktest(candles, config)
  
  // Distribution by TF
  const byTf = new Map<string, {wins: number, losses: number, pnl: number}>()
  for (const t of result.trades) {
    const k = t.interval
    const e = byTf.get(k) ?? {wins:0, losses:0, pnl:0}
    if (t.pnl > 0) e.wins++; else e.losses++
    e.pnl += t.pnl
    byTf.set(k, e)
  }
  console.log('\n=== BY TIMEFRAME ===')
  for (const [tf, s] of [...byTf.entries()].sort()) {
    const total = s.wins + s.losses
    console.log(`${tf}: ${total} trades, WR ${(s.wins/total*100).toFixed(1)}%, PnL $${s.pnl.toFixed(0)}`)
  }
  
  // Distribution by coin
  const byCoin = new Map<string, {wins: number, losses: number, pnl: number}>()
  for (const t of result.trades) {
    const k = t.coin
    const e = byCoin.get(k) ?? {wins:0, losses:0, pnl:0}
    if (t.pnl > 0) e.wins++; else e.losses++
    e.pnl += t.pnl
    byCoin.set(k, e)
  }
  console.log('\n=== BY COIN ===')
  for (const [coin, s] of [...byCoin.entries()].sort((a,b) => b[1].pnl - a[1].pnl)) {
    const total = s.wins + s.losses
    console.log(`${coin}: ${total} trades, WR ${(s.wins/total*100).toFixed(1)}%, PnL $${s.pnl.toFixed(0)}`)
  }
  
  // Distribution by side
  const bySide = new Map<string, {wins: number, losses: number, pnl: number}>()
  for (const t of result.trades) {
    const k = t.side
    const e = bySide.get(k) ?? {wins:0, losses:0, pnl:0}
    if (t.pnl > 0) e.wins++; else e.losses++
    e.pnl += t.pnl
    bySide.set(k, e)
  }
  console.log('\n=== BY SIDE ===')
  for (const [side, s] of bySide) {
    const total = s.wins + s.losses
    console.log(`${side}: ${total} trades, WR ${(s.wins/total*100).toFixed(1)}%, PnL $${s.pnl.toFixed(0)}`)
  }
  
  // Losing streaks
  let maxStreak = 0, curStreak = 0
  for (const t of result.trades) {
    if (t.pnl < 0) { curStreak++; maxStreak = Math.max(maxStreak, curStreak) }
    else curStreak = 0
  }
  console.log(`\nMax losing streak: ${maxStreak}`)
  console.log(`Total trades: ${result.trades.length}`)
  console.log(`Winners avg: $${(result.trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / result.trades.filter(t=>t.pnl>0).length).toFixed(0)}`)
  console.log(`Losers avg: $${(result.trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0) / result.trades.filter(t=>t.pnl<0).length).toFixed(0)}`)
  
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
