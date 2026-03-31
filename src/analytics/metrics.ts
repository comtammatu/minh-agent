/**
 * Analytics Metrics Engine — pure functions, zero I/O.
 *
 * Sprint 3 S5: Compute live performance metrics from closed trade data.
 * Consumes DB rows (ClosedTradeRow[], DailyPerfRow[], PatternPerfRow[]),
 * returns LiveMetrics for dashboard/API.
 *
 * Reuses math concepts from backtest/metrics.ts but operates on DB row shapes
 * (timestamps as Date, no holdingBars, no equity curve).
 */

import type {
  ClosedTradeRow,
  DailyPerfRow,
  PatternPerfRow,
  LiveMetrics,
  PatternMetric,
  CoinMetric,
} from './types.js'

// ─── Time-windowed summary ──────────────────────────────────────────────────

/** Compute win rate from a set of trades. Returns 0 for empty array. */
export function computeWinRate(trades: ClosedTradeRow[]): number {
  if (trades.length === 0) return 0
  const wins = trades.filter(t => t.realizedPnl > 0).length
  return wins / trades.length
}

/** Sum PnL from a set of trades. */
export function computeTotalPnl(trades: ClosedTradeRow[]): number {
  return trades.reduce((sum, t) => sum + t.realizedPnl, 0)
}

/** Filter trades that closed within [since, now). */
export function filterTradesSince(trades: ClosedTradeRow[], since: Date): ClosedTradeRow[] {
  const sinceMs = since.getTime()
  return trades.filter(t => t.closedAt.getTime() >= sinceMs)
}

// ─── Time window helpers ────────────────────────────────────────────────────

/** Get start-of-day (UTC) for a given date. */
export function startOfDayUTC(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** Get N days ago from now (UTC). */
export function daysAgo(n: number, now: Date = new Date()): Date {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - n)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

// ─── Per-coin aggregation ───────────────────────────────────────────────────

/** Aggregate trades by coin. */
export function aggregateByCoin(trades: ClosedTradeRow[]): CoinMetric[] {
  const map = new Map<string, { trades: number; wins: number; totalPnl: number }>()

  for (const t of trades) {
    const entry = map.get(t.coin) ?? { trades: 0, wins: 0, totalPnl: 0 }
    entry.trades++
    if (t.realizedPnl > 0) entry.wins++
    entry.totalPnl += t.realizedPnl
    map.set(t.coin, entry)
  }

  return Array.from(map.entries())
    .map(([coin, v]) => ({
      coin,
      trades: v.trades,
      wins: v.wins,
      winRate: v.trades > 0 ? v.wins / v.trades : 0,
      totalPnl: v.totalPnl,
      avgPnl: v.trades > 0 ? v.totalPnl / v.trades : 0,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl)
}

// ─── Pattern aggregation (from matview rows) ────────────────────────────────

/** Convert PatternPerfRows to PatternMetric[]. */
export function aggregatePatterns(rows: PatternPerfRow[]): PatternMetric[] {
  return rows.map(r => ({
    patternType: r.patternType,
    signalGrade: r.signalGrade,
    trades: r.trades,
    wins: r.wins,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
    totalPnl: r.totalPnl,
    avgPnl: r.avgPnl,
  })).sort((a, b) => b.totalPnl - a.totalPnl)
}

// ─── Drawdown (from chronological trades) ───────────────────────────────────

/**
 * Compute current + max drawdown from chronologically ordered trades.
 * Returns fractions (0–1). Requires initialCapital > 0.
 */
export function computeDrawdown(
  trades: ClosedTradeRow[],
  initialCapital: number,
): { currentDrawdown: number; maxDrawdown: number } {
  if (trades.length === 0 || initialCapital <= 0) {
    return { currentDrawdown: 0, maxDrawdown: 0 }
  }

  let equity = initialCapital
  let peak = initialCapital
  let maxDD = 0

  for (const t of trades) {
    equity += t.realizedPnl
    if (equity > peak) {
      peak = equity
    }
    const dd = peak > 0 ? (peak - equity) / peak : 0
    if (dd > maxDD) maxDD = dd
  }

  const currentDD = peak > 0 ? (peak - equity) / peak : 0
  return { currentDrawdown: Math.max(0, currentDD), maxDrawdown: maxDD }
}

// ─── Build LiveMetrics (main entry point) ───────────────────────────────────

export interface BuildMetricsInput {
  /** All closed trades, chronologically ordered (oldest first). */
  allTrades: ClosedTradeRow[]
  /** Pattern performance rows from matview. */
  patternRows: PatternPerfRow[]
  /** Initial account capital for drawdown calculation. */
  initialCapital: number
  /** Number of currently open positions. */
  openPositionCount: number
  /** Reference time for window calculations. Default: now. */
  now?: Date
}

/**
 * Build complete LiveMetrics from DB data. Pure function.
 */
export function buildLiveMetrics(input: BuildMetricsInput): LiveMetrics {
  const {
    allTrades,
    patternRows,
    initialCapital,
    openPositionCount,
    now = new Date(),
  } = input

  const dailyTrades = filterTradesSince(allTrades, daysAgo(1, now))
  const weeklyTrades = filterTradesSince(allTrades, daysAgo(7, now))
  const monthlyTrades = filterTradesSince(allTrades, daysAgo(30, now))

  const { currentDrawdown, maxDrawdown } = computeDrawdown(allTrades, initialCapital)

  return {
    winRate: {
      daily: computeWinRate(dailyTrades),
      weekly: computeWinRate(weeklyTrades),
      monthly: computeWinRate(monthlyTrades),
      allTime: computeWinRate(allTrades),
    },
    pnl: {
      daily: computeTotalPnl(dailyTrades),
      weekly: computeTotalPnl(weeklyTrades),
      monthly: computeTotalPnl(monthlyTrades),
      allTime: computeTotalPnl(allTrades),
    },
    trades: {
      daily: dailyTrades.length,
      weekly: weeklyTrades.length,
      monthly: monthlyTrades.length,
      allTime: allTrades.length,
    },
    patternMetrics: aggregatePatterns(patternRows),
    coinMetrics: aggregateByCoin(allTrades),
    currentDrawdown,
    maxDrawdown,
    openPositionCount,
  }
}
