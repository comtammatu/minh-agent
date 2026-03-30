/**
 * Backtest metrics computation — pure functions, zero I/O.
 *
 * Takes an array of BacktestTrades + initial capital,
 * returns BacktestMetrics with expectancy, Sharpe, drawdown, etc.
 */

import type { BacktestTrade, BacktestMetrics, EquityPoint } from './types.js'

/** Assumed trading days per year for annualization. */
const TRADING_DAYS_PER_YEAR = 365

/**
 * Compute all backtest metrics from trade results.
 * Returns default (zero) metrics if no trades.
 */
export function computeMetrics(
  trades: BacktestTrade[],
  initialCapital: number,
): BacktestMetrics {
  if (trades.length === 0) {
    return zeroMetrics()
  }

  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const winRate = wins.length / trades.length

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0)
  const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0)
  const netPnl = grossProfit + grossLoss
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? Infinity : 0)
    : grossProfit / Math.abs(grossLoss)

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(grossLoss) / losses.length : 0
  const avgPnl = netPnl / trades.length
  const avgHoldingBars = trades.reduce((sum, t) => sum + t.holdingBars, 0) / trades.length

  // Average realized R:R = avgWin / avgLoss
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0)

  // Expectancy = (winRate × avgWin) - (lossRate × avgLoss)
  const lossRate = 1 - winRate
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss)

  // Drawdown
  const { maxDrawdown, maxDrawdownDuration } = computeDrawdown(trades, initialCapital)

  // Sharpe & Sortino (annualized from daily returns)
  const dailyReturns = computeDailyReturns(trades, initialCapital)
  const sharpeRatio = computeSharpe(dailyReturns)
  const sortinoRatio = computeSortino(dailyReturns)

  // Calmar = annual return / max drawdown
  const totalReturn = netPnl / initialCapital
  const tradingDays = dailyReturns.length || 1
  const annualReturn = totalReturn * (TRADING_DAYS_PER_YEAR / tradingDays)
  const calmarRatio = maxDrawdown > 0 ? annualReturn / maxDrawdown : (annualReturn > 0 ? Infinity : 0)

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor,
    avgWin,
    avgLoss,
    avgPnl,
    avgRR,
    avgHoldingBars,
    expectancy,
    maxDrawdown,
    maxDrawdownDuration,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
  }
}

/**
 * Build equity curve from trades.
 * Each point = account value after a trade closes.
 */
export function buildEquityCurve(
  trades: BacktestTrade[],
  initialCapital: number,
): EquityPoint[] {
  const curve: EquityPoint[] = [{ ts: trades[0]?.entryTime ?? 0, equity: initialCapital }]
  let equity = initialCapital

  for (const trade of trades) {
    equity += trade.pnl
    curve.push({ ts: trade.exitTime, equity })
  }

  return curve
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function computeDrawdown(
  trades: BacktestTrade[],
  initialCapital: number,
): { maxDrawdown: number; maxDrawdownDuration: number } {
  let peak = initialCapital
  let equity = initialCapital
  let maxDD = 0
  let maxDDDuration = 0
  let currentDDStart = -1

  for (let i = 0; i < trades.length; i++) {
    equity += trades[i]!.pnl
    if (equity > peak) {
      peak = equity
      currentDDStart = -1
    } else {
      const dd = (peak - equity) / peak
      if (dd > maxDD) {
        maxDD = dd
      }
      if (currentDDStart === -1) {
        currentDDStart = i
      }
      const duration = i - currentDDStart + 1
      if (duration > maxDDDuration) {
        maxDDDuration = duration
      }
    }
  }

  return { maxDrawdown: maxDD, maxDrawdownDuration: maxDDDuration }
}

/**
 * Aggregate trade PnL into daily returns (fraction of capital at start of day).
 * Groups trades by exit date (UTC day).
 */
function computeDailyReturns(
  trades: BacktestTrade[],
  initialCapital: number,
): number[] {
  if (trades.length === 0) return []

  // Group PnL by UTC day
  const dailyPnl = new Map<string, number>()
  for (const trade of trades) {
    const day = new Date(trade.exitTime).toISOString().slice(0, 10)
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + trade.pnl)
  }

  // Convert to returns (as fraction of running capital)
  const returns: number[] = []
  let capital = initialCapital
  const sortedDays = Array.from(dailyPnl.keys()).sort()

  for (const day of sortedDays) {
    const pnl = dailyPnl.get(day)!
    if (capital > 0) {
      returns.push(pnl / capital)
    }
    capital += pnl
  }

  return returns
}

/** Sharpe ratio: mean(returns) / std(returns) × sqrt(365). */
function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR)
}

/** Sortino ratio: mean(returns) / downside_std(returns) × sqrt(365). */
function computeSortino(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
  const negReturns = dailyReturns.filter(r => r < 0)
  if (negReturns.length === 0) return mean > 0 ? Infinity : 0
  const downsideVariance = negReturns.reduce((s, r) => s + r ** 2, 0) / negReturns.length
  const downsideStd = Math.sqrt(downsideVariance)
  if (downsideStd === 0) return 0
  return (mean / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
}

function zeroMetrics(): BacktestMetrics {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    netPnl: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    avgPnl: 0,
    avgRR: 0,
    avgHoldingBars: 0,
    expectancy: 0,
    maxDrawdown: 0,
    maxDrawdownDuration: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
  }
}
