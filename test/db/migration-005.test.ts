import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { runMigrations } from '../../src/db/migrate.js'

/**
 * Integration tests for migration 005 — single-strategy cleanup.
 * Requires a running PostgreSQL+TimescaleDB instance.
 * Skips gracefully if DB is unavailable.
 *
 * Run: docker compose up -d && bun test --run
 */

const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://minh:minh_dev@localhost:5432/minh'
let sql: ReturnType<typeof postgres>
let dbAvailable = false

beforeAll(async () => {
  try {
    sql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 })
    await sql`SELECT 1`
    dbAvailable = true

    // Clear migration tracking so runMigrations() re-applies all files.
    await sql`DELETE FROM schema_migrations`
    await runMigrations(sql)
  } catch {
    // DB not available — tests will be skipped
  }
})

afterAll(async () => {
  if (dbAvailable) {
    // Clean up test rows inserted by tests
    await sql`DELETE FROM orders WHERE coin = 'TEST_M005'`
    await sql`DELETE FROM positions WHERE coin = 'TEST_M005'`
    await sql`DELETE FROM trade_journal WHERE event_type = 'test_m005'`
    // Re-run migrations to restore DB state for other parallel tests
    await runMigrations(sql)
    await sql.end()
  }
})

describe('migration 005 — single-strategy cleanup', () => {
  it('fresh schema does not include the legacy strategies table', async () => {
    if (!dbAvailable) return

    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'strategies' AND table_schema = 'public'
      ) AS exists
    `
    expect(rows[0]?.exists).toBe(false)
  })

  it('orders table keeps cloid and fill_size columns', async () => {
    if (!dbAvailable) return

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders' AND table_schema = 'public'
    `
    const names = cols.map(c => c.column_name)
    expect(names).toContain('cloid')
    expect(names).toContain('fill_size')
  })

  it('fresh schema does not expose strategy_id columns', async () => {
    if (!dbAvailable) return

    const orderCols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'orders' AND table_schema = 'public'
    `
    const positionCols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'positions' AND table_schema = 'public'
    `
    const journalCols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'trade_journal' AND table_schema = 'public'
    `
    expect(orderCols.map(c => c.column_name)).not.toContain('strategy_id')
    expect(positionCols.map(c => c.column_name)).not.toContain('strategy_id')
    expect(journalCols.map(c => c.column_name)).not.toContain('strategy_id')
  })

  it('removes legacy strategy artifacts when they are reintroduced', async () => {
    if (!dbAvailable) return

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS strategy_id TEXT DEFAULT 'legacy';
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy_id TEXT DEFAULT 'legacy';
      ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS strategy_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders (strategy_id);
      CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions (strategy_id);
    `)

    await sql`DELETE FROM schema_migrations WHERE version = '005_strategies'`
    await runMigrations(sql)

    const strategyTable = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'strategies' AND table_schema = 'public'
      ) AS exists
    `
    const strategyColumns = await sql<{ table_name: string; count: number }[]>`
      SELECT table_name, COUNT(*)::INT AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'strategy_id'
        AND table_name IN ('orders', 'positions', 'trade_journal')
      GROUP BY table_name
    `
    const strategyIndexes = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE indexname IN ('idx_orders_strategy', 'idx_positions_strategy')
    `
    expect(strategyTable[0]?.exists).toBe(false)
    expect(strategyColumns).toHaveLength(0)
    expect(strategyIndexes).toHaveLength(0)
  })

  it('migration is idempotent', async () => {
    if (!dbAvailable) return

    await sql`DELETE FROM schema_migrations WHERE version LIKE '005%'`

    const count = await runMigrations(sql)
    expect(count).toBeGreaterThanOrEqual(1)

    // Run again — should apply 0
    const count2 = await runMigrations(sql)
    expect(count2).toBe(0)
  })
})
