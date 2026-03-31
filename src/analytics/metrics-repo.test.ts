/**
 * Metrics Repo integration tests — requires PostgreSQL + TimescaleDB.
 * Sprint 3 S5.
 *
 * Skips gracefully if DB is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { runMigrations } from '../db/migrate.js'

const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://minh:minh_dev@localhost:5432/minh'
let testSql: ReturnType<typeof postgres>
let dbAvailable = false

beforeAll(async () => {
  try {
    testSql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 })
    await testSql`SELECT 1`
    dbAvailable = true

    // Ensure migrations are applied
    await runMigrations(testSql)

    // Clean data for test isolation
    await testSql`DELETE FROM positions`
    await testSql`DELETE FROM trade_journal`

    // Seed closed positions
    await testSql`
      INSERT INTO positions (coin, side, entry_price, size, status, closed_at, close_price, realized_pnl)
      VALUES
        ('BTC', 'long', 50000, 0.1, 'closed', NOW() - INTERVAL '2 hours', 51000, 100),
        ('BTC', 'short', 52000, 0.1, 'closed', NOW() - INTERVAL '1 hour', 51500, 50),
        ('ETH', 'long', 3000, 1.0, 'closed', NOW() - INTERVAL '30 minutes', 2900, -100),
        ('SOL', 'long', 100, 10, 'open', NULL, NULL, NULL)
    `

    // Seed journal entries with position_id for pattern_performance
    const posRows = await testSql<{ id: string }[]>`
      SELECT id FROM positions WHERE status = 'closed' ORDER BY closed_at ASC LIMIT 1
    `
    const posId = posRows[0]?.id ?? 'unknown'
    await testSql`
      INSERT INTO trade_journal (event_type, coin, details, agent_state)
      VALUES
        ('enter', 'BTC', ${testSql.json({ pattern_type: 'ob', signal_grade: 'A', position_id: posId })}, 'ENTERING')
    `

    // Refresh matviews so queries work
    await testSql`REFRESH MATERIALIZED VIEW daily_performance`
    await testSql`REFRESH MATERIALIZED VIEW pattern_performance`
    await testSql`REFRESH MATERIALIZED VIEW pnl_hourly`
  } catch {
    // DB not available — tests will be skipped
  }
})

afterAll(async () => {
  if (dbAvailable) {
    await testSql`DELETE FROM trade_journal`
    await testSql`DELETE FROM positions`
    await testSql.end()
  }
})

// ─── We can't import metrics-repo directly (it uses the shared connection).
//     Instead test the SQL patterns directly against testSql. ─────────────────

describe('metrics-repo queries', () => {
  it('getClosedTrades returns correct rows', async () => {
    if (!dbAvailable) { console.log('  ⏭ Skipping — DB not available'); return }

    const rows = await testSql<{ coin: string; side: string; realized_pnl: number; closed_at: Date }[]>`
      SELECT coin, side, realized_pnl, closed_at
      FROM positions
      WHERE status = 'closed' AND closed_at IS NOT NULL
      ORDER BY closed_at ASC
    `
    expect(rows.length).toBe(3)
    expect(rows[0]!.coin).toBe('BTC')
    expect(rows[0]!.realized_pnl).toBe(100)
    expect(rows[2]!.coin).toBe('ETH')
    expect(rows[2]!.realized_pnl).toBe(-100)
  })

  it('getOpenPositionCount returns correct count', async () => {
    if (!dbAvailable) { console.log('  ⏭ Skipping — DB not available'); return }

    const rows = await testSql<{ cnt: string }[]>`
      SELECT COUNT(*) AS cnt FROM positions WHERE status IN ('open', 'closing')
    `
    expect(Number(rows[0]!.cnt)).toBe(1) // SOL is open
  })

  it('daily_performance matview returns aggregated data', async () => {
    if (!dbAvailable) { console.log('  ⏭ Skipping — DB not available'); return }

    const rows = await testSql`
      SELECT day, coin, trades, wins, losses, total_pnl
      FROM daily_performance
      ORDER BY coin
    `
    // BTC has 2 closed trades today, ETH has 1
    expect(rows.length).toBeGreaterThanOrEqual(2)

    const btc = rows.find((r: { coin: string }) => r.coin === 'BTC')
    expect(btc).toBeDefined()
    expect(Number(btc!.trades)).toBe(2)
    expect(Number(btc!.wins)).toBe(2) // 100 and 50 both positive
    expect(btc!.total_pnl).toBe(150)

    const eth = rows.find((r: { coin: string }) => r.coin === 'ETH')
    expect(eth).toBeDefined()
    expect(Number(eth!.trades)).toBe(1)
    expect(Number(eth!.losses)).toBe(1)
    expect(eth!.total_pnl).toBe(-100)
  })

  it('pattern_performance matview returns joined data', async () => {
    if (!dbAvailable) { console.log('  ⏭ Skipping — DB not available'); return }

    // Re-seed + refresh to ensure data is present (parallel tests may have cleared it)
    await testSql`DELETE FROM trade_journal`
    await testSql`DELETE FROM positions`
    await testSql`
      INSERT INTO positions (coin, side, entry_price, size, status, closed_at, close_price, realized_pnl)
      VALUES ('BTC', 'long', 50000, 0.1, 'closed', NOW() - INTERVAL '1 hour', 51000, 100)
    `
    const posRows = await testSql<{ id: string }[]>`SELECT id FROM positions WHERE status = 'closed' LIMIT 1`
    const posId = posRows[0]?.id ?? 'unknown'
    // Use sql.json() to ensure proper JSONB storage (not double-encoded string)
    await testSql`
      INSERT INTO trade_journal (event_type, coin, details, agent_state)
      VALUES ('enter', 'BTC', ${testSql.json({ pattern_type: 'ob', signal_grade: 'A', position_id: posId })}, 'ENTERING')
    `
    await testSql`REFRESH MATERIALIZED VIEW pattern_performance`

    const rows = await testSql`
      SELECT pattern_type, signal_grade, trades, total_pnl
      FROM pattern_performance
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const ob = rows.find((r: { pattern_type: string }) => r.pattern_type === 'ob')
    expect(ob).toBeDefined()
    expect(ob!.signal_grade).toBe('A')
  })

  it('refreshViews pattern: CONCURRENTLY with unique index', async () => {
    if (!dbAvailable) { console.log('  ⏭ Skipping — DB not available'); return }

    // Should not throw — matviews have data + unique indexes
    await testSql`REFRESH MATERIALIZED VIEW CONCURRENTLY daily_performance`
    await testSql`REFRESH MATERIALIZED VIEW CONCURRENTLY pattern_performance`
  })
})
