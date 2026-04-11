/**
 * Backtest results-store tests.
 *
 * Part 1: Pure function tests (computeMetricsDelta) — always run.
 * Part 2: Integration tests (save/load/list/compare/delete) — require PostgreSQL+TimescaleDB.
 *         Skip gracefully if DB is unavailable.
 *
 * Run: docker compose up -d && bun test --run
 */

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test'

// Migration can be slow (creates hypertables, compression policies)
setDefaultTimeout(30_000)
import postgres from 'postgres'
import { runMigrations } from '../../src/db/migrate.js'
import { computeMetricsDelta } from '../../src/backtest/metrics.js'
import type {
  BacktestResult,
  BacktestMetrics,
  BacktestTrade,
  BacktestConfig,
  EquityPoint,
} from '../../src/backtest/types.js'

// I/O functions loaded dynamically to avoid importing connection.ts at module level
// (which would create a pool with 10s connect_timeout and block bun test's 5s hook timeout).
type ResultsStore = typeof import('../../src/backtest/results-store.js')
let store: ResultsStore

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    totalTrades: 20,
    wins: 12,
    losses: 8,
    winRate: 0.6,
    grossProfit: 5000,
    grossLoss: -2000,
    netPnl: 3000,
    profitFactor: 2.5,
    avgWin: 416.67,
    avgLoss: -250,
    avgPnl: 150,
    avgRR: 1.67,
    avgHoldingBars: 8,
    expectancy: 50,
    maxDrawdown: 0.08,
    maxDrawdownDuration: 12,
    sharpeRatio: 1.5,
    sortinoRatio: 2.0,
    calmarRatio: 3.0,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    coins: ['BTC', 'ETH'],
    timeframes: ['1h', '4h'],
    initialCapital: 10000,
    slippagePct: 0.0005,
    commissionPct: 0.0003,
    ...overrides,
  }
}

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    coin: 'BTC',
    interval: '1h',
    side: 'long',
    patternType: 'smc-sd',
    confluenceGrade: 'B',
    entryPrice: 50000,
    exitPrice: 51000,
    slPrice: 49000,
    tpPrice: 52000,
    sizeUsd: 500,
    entryTime: Date.now() - 3600_000,
    exitTime: Date.now(),
    holdingBars: 5,
    pnl: 10,
    pnlPct: 0.02,
    exitReason: 'tp_hit',
    ...overrides,
  }
}

function makeEquityPoint(ts: number, equity: number): EquityPoint {
  return { ts, equity }
}

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  const baseTime = new Date('2025-01-01T00:00:00Z').getTime()
  return {
    config: makeConfig(),
    metrics: makeMetrics(),
    trades: [
      makeTrade({ entryTime: baseTime, exitTime: baseTime + 3600_000 }),
      makeTrade({
        coin: 'ETH',
        side: 'short',
        patternType: 'smc-sd',
        confluenceGrade: 'A',
        entryPrice: 3000,
        exitPrice: 2900,
        slPrice: 3100,
        tpPrice: 2800,
        sizeUsd: 300,
        entryTime: baseTime + 7200_000,
        exitTime: baseTime + 10800_000,
        holdingBars: 3,
        pnl: 10,
        pnlPct: 0.033,
        exitReason: 'sl_hit',
      }),
    ],
    equityCurve: [
      makeEquityPoint(baseTime, 10000),
      makeEquityPoint(baseTime + 3600_000, 10010),
      makeEquityPoint(baseTime + 7200_000, 10020),
    ],
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 1: Pure Function Tests (always run)
// ═══════════════════════════════════════════════════════════════════════════

describe('computeMetricsDelta (pure)', () => {
  test('computes positive delta when B is better', () => {
    const a = makeMetrics({ winRate: 0.5, netPnl: 1000, sharpeRatio: 1.0 })
    const b = makeMetrics({ winRate: 0.7, netPnl: 3000, sharpeRatio: 2.0 })
    const delta = computeMetricsDelta(a, b)

    expect(delta.winRate).toBeCloseTo(0.2)
    expect(delta.netPnl).toBeCloseTo(2000)
    expect(delta.sharpeRatio).toBeCloseTo(1.0)
  })

  test('computes negative delta when B is worse', () => {
    const a = makeMetrics({ expectancy: 100, maxDrawdown: 0.05 })
    const b = makeMetrics({ expectancy: 50, maxDrawdown: 0.15 })
    const delta = computeMetricsDelta(a, b)

    expect(delta.expectancy).toBeCloseTo(-50)
    expect(delta.maxDrawdown).toBeCloseTo(0.10)
  })

  test('delta is zero for identical metrics', () => {
    const m = makeMetrics()
    const delta = computeMetricsDelta(m, m)

    expect(delta.totalTrades).toBe(0)
    expect(delta.winRate).toBe(0)
    expect(delta.netPnl).toBe(0)
    expect(delta.profitFactor).toBe(0)
    expect(delta.expectancy).toBe(0)
    expect(delta.maxDrawdown).toBe(0)
    expect(delta.sharpeRatio).toBe(0)
    expect(delta.sortinoRatio).toBe(0)
    expect(delta.calmarRatio).toBe(0)
    expect(delta.avgRR).toBe(0)
    expect(delta.avgHoldingBars).toBe(0)
  })

  test('all metric fields present in delta', () => {
    const delta = computeMetricsDelta(makeMetrics(), makeMetrics())
    const keys = Object.keys(delta)
    expect(keys).toContain('totalTrades')
    expect(keys).toContain('winRate')
    expect(keys).toContain('netPnl')
    expect(keys).toContain('profitFactor')
    expect(keys).toContain('expectancy')
    expect(keys).toContain('maxDrawdown')
    expect(keys).toContain('sharpeRatio')
    expect(keys).toContain('sortinoRatio')
    expect(keys).toContain('calmarRatio')
    expect(keys).toContain('avgRR')
    expect(keys).toContain('avgHoldingBars')
    expect(keys.length).toBe(11)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Part 2: Integration Tests (require PostgreSQL+TimescaleDB)
// Uses own connection pool to avoid interference with parallel test files.
// ═══════════════════════════════════════════════════════════════════════════

const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://minh:minh_dev@localhost:5432/minh'
let db: ReturnType<typeof postgres>
let dbAvailable = false

beforeAll(async () => {
  try {
    db = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 })
    await db`SELECT 1`
    dbAvailable = true

    // Dynamic import — avoids loading connection.ts at module level
    store = await import('../../src/backtest/results-store.js')

    // Ensure all migrations applied (idempotent)
    await runMigrations(db)

    // Clean test data from previous runs
    await db`DELETE FROM backtest_equity`
    await db`DELETE FROM backtest_trades`
    await db`DELETE FROM backtest_runs`
  } catch {
    // DB not available — integration tests will skip
  }
})

afterAll(async () => {
  if (dbAvailable) {
    await db`DELETE FROM backtest_equity`
    await db`DELETE FROM backtest_trades`
    await db`DELETE FROM backtest_runs`
    await db.end()
  }
})

describe('results-store integration', () => {
  test('saveRun returns UUID', async () => {
    if (!dbAvailable) return

    const result = makeResult()
    const id = await store.saveRun(result, 'test_run_1', db)

    expect(id).toBeDefined()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(36)
  })

  test('loadRun returns full result matching saved data', async () => {
    if (!dbAvailable) return

    const result = makeResult()
    const id = await store.saveRun(result, 'load_test', db)
    const loaded = await store.loadRun(id, db)

    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(id)
    expect(loaded!.name).toBe('load_test')

    // Config roundtrip
    expect(loaded!.config.coins).toEqual(result.config.coins)
    expect(loaded!.config.timeframes).toEqual(result.config.timeframes)
    expect(loaded!.config.initialCapital).toBe(result.config.initialCapital)

    // Summary metrics
    expect(loaded!.totalTrades).toBe(result.metrics.totalTrades)
    expect(loaded!.netPnl).toBe(result.metrics.netPnl)
    expect(loaded!.winRate).toBe(result.metrics.winRate)
    expect(loaded!.sharpeRatio).toBe(result.metrics.sharpeRatio)

    // Full metrics roundtrip
    expect(loaded!.metrics.totalTrades).toBe(result.metrics.totalTrades)
    expect(loaded!.metrics.profitFactor).toBe(result.metrics.profitFactor)
    expect(loaded!.metrics.expectancy).toBe(result.metrics.expectancy)

    // Trades roundtrip
    expect(loaded!.trades.length).toBe(result.trades.length)
    expect(loaded!.trades[0].coin).toBe('BTC')
    expect(loaded!.trades[0].side).toBe('long')
    expect(loaded!.trades[0].patternType).toBe('smc-sd')
    expect(loaded!.trades[0].entryPrice).toBe(50000)
    expect(loaded!.trades[0].exitReason).toBe('tp_hit')
    expect(loaded!.trades[1].coin).toBe('ETH')
    expect(loaded!.trades[1].confluenceGrade).toBe('A')

    // Equity curve roundtrip
    expect(loaded!.equityCurve.length).toBe(result.equityCurve.length)
    expect(loaded!.equityCurve[0].equity).toBe(10000)
    expect(loaded!.equityCurve[2].equity).toBe(10020)
  })

  test('loadRun returns null for non-existent ID', async () => {
    if (!dbAvailable) return

    const loaded = await store.loadRun('00000000-0000-0000-0000-000000000000', db)
    expect(loaded).toBeNull()
  })

  test('listRuns returns summaries ordered by created_at DESC', async () => {
    if (!dbAvailable) return

    const id1 = await store.saveRun(makeResult(), 'list_first', db)
    await new Promise(resolve => setTimeout(resolve, 50))
    const id2 = await store.saveRun(makeResult(), 'list_second', db)

    const runs = await store.listRuns(50, db)
    expect(runs.length).toBeGreaterThanOrEqual(2)

    const idx1 = runs.findIndex(r => r.id === id1)
    const idx2 = runs.findIndex(r => r.id === id2)
    expect(idx2).toBeLessThan(idx1) // newer first
  })

  test('listRuns respects limit', async () => {
    if (!dbAvailable) return

    const runs = await store.listRuns(1, db)
    expect(runs.length).toBe(1)
  })

  test('deleteRun removes run and cascades to trades/equity', async () => {
    if (!dbAvailable) return

    const id = await store.saveRun(makeResult(), 'to_delete', db)
    expect(await store.loadRun(id, db)).not.toBeNull()

    const deleted = await store.deleteRun(id, db)
    expect(deleted).toBe(true)
    expect(await store.loadRun(id, db)).toBeNull()

    // Cascaded: trades and equity should be gone
    const trades = await db`SELECT COUNT(*) as cnt FROM backtest_trades WHERE run_id = ${id}`
    expect(Number(trades[0].cnt)).toBe(0)
    const equity = await db`SELECT COUNT(*) as cnt FROM backtest_equity WHERE run_id = ${id}`
    expect(Number(equity[0].cnt)).toBe(0)
  })

  test('deleteRun returns false for non-existent ID', async () => {
    if (!dbAvailable) return

    const deleted = await store.deleteRun('00000000-0000-0000-0000-000000000000', db)
    expect(deleted).toBe(false)
  })

  test('compareRuns returns delta between two runs', async () => {
    if (!dbAvailable) return

    const resultA = makeResult({
      metrics: makeMetrics({ winRate: 0.5, netPnl: 1000, sharpeRatio: 1.0 }),
    })
    const resultB = makeResult({
      metrics: makeMetrics({ winRate: 0.7, netPnl: 3000, sharpeRatio: 2.0 }),
    })

    const idA = await store.saveRun(resultA, 'compare_A', db)
    const idB = await store.saveRun(resultB, 'compare_B', db)

    const comparison = await store.compareRuns(idA, idB, db)
    expect(comparison).not.toBeNull()
    expect(comparison!.runA.id).toBe(idA)
    expect(comparison!.runB.id).toBe(idB)
    expect(comparison!.delta.winRate).toBeCloseTo(0.2)
    expect(comparison!.delta.netPnl).toBeCloseTo(2000)
    expect(comparison!.delta.sharpeRatio).toBeCloseTo(1.0)
    expect(comparison!.metricsA.winRate).toBe(0.5)
    expect(comparison!.metricsB.winRate).toBe(0.7)
  })

  test('compareRuns returns null if one run missing', async () => {
    if (!dbAvailable) return

    const id = await store.saveRun(makeResult(), 'compare_solo', db)
    const result = await store.compareRuns(id, '00000000-0000-0000-0000-000000000000', db)
    expect(result).toBeNull()
  })

  test('saveRun with no name stores null', async () => {
    if (!dbAvailable) return

    const id = await store.saveRun(makeResult(), undefined, db)
    const loaded = await store.loadRun(id, db)
    expect(loaded!.name).toBeNull()
  })

  test('saveRun with empty trades and equity', async () => {
    if (!dbAvailable) return

    const result = makeResult({
      trades: [],
      equityCurve: [],
      metrics: makeMetrics({ totalTrades: 0 }),
    })
    const id = await store.saveRun(result, 'empty_run', db)
    const loaded = await store.loadRun(id, db)

    expect(loaded!.trades.length).toBe(0)
    expect(loaded!.equityCurve.length).toBe(0)
  })
})
