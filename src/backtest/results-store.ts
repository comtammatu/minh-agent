/**
 * Backtest results persistence — save, load, list, compare runs.
 * I/O boundary: all DB access here, pure comparison logic separated.
 *
 * All DB functions accept an optional `db` parameter for dependency injection
 * (used by tests with their own pool). Defaults to the shared pool.
 *
 * Sprint 3 S3.
 */

import type { JSONValue, Sql } from 'postgres'
import { sql as defaultSql } from '../db/connection.js'
import { computeMetricsDelta } from './metrics.js'
import type { MetricsDelta } from './metrics.js'
import type {
  BacktestResult,
  BacktestConfig,
  BacktestMetrics,
  BacktestTrade,
  EquityPoint,
} from './types.js'

// Re-export for convenience
export { computeMetricsDelta }
export type { MetricsDelta }

// ─── Types ──────────────────────────────────────────────────────────────────

/** Saved run summary (for list view). */
export interface BacktestRunSummary {
  id: string
  name: string | null
  config: BacktestConfig
  totalTrades: number
  netPnl: number
  winRate: number
  maxDrawdown: number
  sharpeRatio: number
  expectancy: number
  createdAt: Date
}

/** Full saved run (summary + trades + equity + full metrics). */
export interface SavedBacktestRun extends BacktestRunSummary {
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: EquityPoint[]
}

/** Comparison result between two runs. */
export interface ComparisonResult {
  runA: BacktestRunSummary
  runB: BacktestRunSummary
  metricsA: BacktestMetrics
  metricsB: BacktestMetrics
  delta: MetricsDelta
}

// ─── Save ───────────────────────────────────────────────────────────────────

const TRADE_CHUNK_SIZE = 500
const EQUITY_CHUNK_SIZE = 1000

/**
 * Persist a BacktestResult to PostgreSQL.
 * Returns the generated run UUID.
 */
export async function saveRun(
  result: BacktestResult,
  name?: string,
  db: Sql = defaultSql,
): Promise<string> {
  const { config, metrics, trades, equityCurve } = result

  // Insert run header
  const [row] = await db<{ id: string }[]>`
    INSERT INTO backtest_runs (
      name, config, metrics,
      total_trades, net_pnl, win_rate,
      max_drawdown, sharpe_ratio, expectancy
    ) VALUES (
      ${name ?? null},
      ${db.json(config as unknown as JSONValue)},
      ${db.json(metrics as unknown as JSONValue)},
      ${metrics.totalTrades},
      ${metrics.netPnl},
      ${metrics.winRate},
      ${metrics.maxDrawdown},
      ${metrics.sharpeRatio},
      ${metrics.expectancy}
    )
    RETURNING id
  `
  if (!row) throw new Error('Failed to persist backtest run header')
  const runId = row.id

  // Bulk insert trades in chunks
  for (let i = 0; i < trades.length; i += TRADE_CHUNK_SIZE) {
    const chunk = trades.slice(i, i + TRADE_CHUNK_SIZE)
    const rows = chunk.map(t => ({
      run_id: runId,
      coin: t.coin,
      interval: t.interval,
      side: t.side,
      pattern_type: t.patternType,
      confluence_grade: t.confluenceGrade,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      sl_price: t.slPrice,
      tp_price: t.tpPrice,
      size_usd: t.sizeUsd,
      entry_time: new Date(t.entryTime),
      exit_time: new Date(t.exitTime),
      holding_bars: t.holdingBars,
      pnl: t.pnl,
      pnl_pct: t.pnlPct,
      exit_reason: t.exitReason,
    }))
    await db`
      INSERT INTO backtest_trades ${db(rows)}
    `
  }

  // Bulk insert equity curve in chunks
  for (let i = 0; i < equityCurve.length; i += EQUITY_CHUNK_SIZE) {
    const chunk = equityCurve.slice(i, i + EQUITY_CHUNK_SIZE)
    const rows = chunk.map(e => ({
      run_id: runId,
      ts: new Date(e.ts),
      equity: e.equity,
    }))
    await db`
      INSERT INTO backtest_equity ${db(rows)}
    `
  }

  return runId
}

// ─── Load ───────────────────────────────────────────────────────────────────

/** Load a full backtest run by ID. Returns null if not found. */
export async function loadRun(runId: string, db: Sql = defaultSql): Promise<SavedBacktestRun | null> {
  const runs = await db<{
    id: string
    name: string | null
    config: BacktestConfig
    metrics: BacktestMetrics
    total_trades: number
    net_pnl: number
    win_rate: number
    max_drawdown: number
    sharpe_ratio: number
    expectancy: number
    created_at: Date
  }[]>`
    SELECT * FROM backtest_runs WHERE id = ${runId}
  `
  if (runs.length === 0) return null
  const run = runs[0]
  if (!run) return null

  // Load trades
  const tradeRows = await db<{
    coin: string
    interval: string
    side: string
    pattern_type: string
    confluence_grade: string | null
    entry_price: number
    exit_price: number
    sl_price: number
    tp_price: number
    size_usd: number
    entry_time: Date
    exit_time: Date
    holding_bars: number
    pnl: number
    pnl_pct: number
    exit_reason: string
  }[]>`
    SELECT coin, interval, side, pattern_type, confluence_grade,
           entry_price, exit_price, sl_price, tp_price, size_usd,
           entry_time, exit_time, holding_bars, pnl, pnl_pct, exit_reason
    FROM backtest_trades
    WHERE run_id = ${runId}
    ORDER BY entry_time ASC
  `

  // Load equity curve
  const equityRows = await db<{ ts: Date; equity: number }[]>`
    SELECT ts, equity FROM backtest_equity
    WHERE run_id = ${runId}
    ORDER BY ts ASC
  `

  return {
    id: run.id,
    name: run.name,
    config: run.config,
    metrics: run.metrics,
    totalTrades: run.total_trades,
    netPnl: run.net_pnl,
    winRate: run.win_rate,
    maxDrawdown: run.max_drawdown,
    sharpeRatio: run.sharpe_ratio,
    expectancy: run.expectancy,
    createdAt: run.created_at,
    trades: tradeRows.map(r => ({
      coin: r.coin,
      interval: r.interval as BacktestTrade['interval'],
      side: r.side as BacktestTrade['side'],
      patternType: r.pattern_type as BacktestTrade['patternType'],
      confluenceGrade: r.confluence_grade as BacktestTrade['confluenceGrade'],
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      slPrice: r.sl_price,
      tpPrice: r.tp_price,
      sizeUsd: r.size_usd,
      entryTime: r.entry_time.getTime(),
      exitTime: r.exit_time.getTime(),
      holdingBars: r.holding_bars,
      pnl: r.pnl,
      pnlPct: r.pnl_pct,
      exitReason: r.exit_reason as BacktestTrade['exitReason'],
    })),
    equityCurve: equityRows.map(r => ({
      ts: r.ts.getTime(),
      equity: r.equity,
    })),
  }
}

// ─── List ───────────────────────────────────────────────────────────────────

/** List all runs (summary only, no trades/equity). Most recent first. */
export async function listRuns(limit = 50, db: Sql = defaultSql): Promise<BacktestRunSummary[]> {
  const rows = await db<{
    id: string
    name: string | null
    config: BacktestConfig
    total_trades: number
    net_pnl: number
    win_rate: number
    max_drawdown: number
    sharpe_ratio: number
    expectancy: number
    created_at: Date
  }[]>`
    SELECT id, name, config, total_trades, net_pnl, win_rate,
           max_drawdown, sharpe_ratio, expectancy, created_at
    FROM backtest_runs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    config: r.config,
    totalTrades: r.total_trades,
    netPnl: r.net_pnl,
    winRate: r.win_rate,
    maxDrawdown: r.max_drawdown,
    sharpeRatio: r.sharpe_ratio,
    expectancy: r.expectancy,
    createdAt: r.created_at,
  }))
}

// ─── Delete ─────────────────────────────────────────────────────────────────

/** Delete a run and all its trades/equity (CASCADE). */
export async function deleteRun(runId: string, db: Sql = defaultSql): Promise<boolean> {
  const result = await db`
    DELETE FROM backtest_runs WHERE id = ${runId}
  `
  return result.count > 0
}

// ─── Compare ────────────────────────────────────────────────────────────────

/** Compare two runs. Returns null if either run not found. */
export async function compareRuns(
  runIdA: string,
  runIdB: string,
  db: Sql = defaultSql,
): Promise<ComparisonResult | null> {
  // Load both runs' header + metrics (no trades/equity needed for comparison)
  const rows = await db<{
    id: string
    name: string | null
    config: BacktestConfig
    metrics: BacktestMetrics
    total_trades: number
    net_pnl: number
    win_rate: number
    max_drawdown: number
    sharpe_ratio: number
    expectancy: number
    created_at: Date
  }[]>`
    SELECT id, name, config, metrics, total_trades, net_pnl, win_rate,
           max_drawdown, sharpe_ratio, expectancy, created_at
    FROM backtest_runs
    WHERE id IN (${runIdA}, ${runIdB})
  `

  const mapById = new Map(rows.map(r => [r.id, r]))
  const rowA = mapById.get(runIdA)
  const rowB = mapById.get(runIdB)
  if (!rowA || !rowB) return null

  const toSummary = (r: typeof rowA): BacktestRunSummary => ({
    id: r.id,
    name: r.name,
    config: r.config,
    totalTrades: r.total_trades,
    netPnl: r.net_pnl,
    winRate: r.win_rate,
    maxDrawdown: r.max_drawdown,
    sharpeRatio: r.sharpe_ratio,
    expectancy: r.expectancy,
    createdAt: r.created_at,
  })

  return {
    runA: toSummary(rowA),
    runB: toSummary(rowB),
    metricsA: rowA.metrics,
    metricsB: rowB.metrics,
    delta: computeMetricsDelta(rowA.metrics, rowB.metrics),
  }
}
