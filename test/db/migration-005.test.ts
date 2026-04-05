import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { runMigrations } from '../../src/db/migrate.js'

/**
 * Integration tests for migration 005 — strategies table + schema debt (E29).
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

describe('migration 005 — strategies + schema debt', () => {
  it('strategies table exists with correct columns', async () => {
    if (!dbAvailable) return

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'strategies' AND table_schema = 'public'
      ORDER BY ordinal_position
    `
    const names = cols.map(c => c.column_name)
    expect(names).toContain('id')
    expect(names).toContain('name')
    expect(names).toContain('enabled')
    expect(names).toContain('config')
    expect(names).toContain('wallet_address')
    expect(names).toContain('capital_allocation')
    expect(names).toContain('created_at')
  })

  it('default layered strategy is seeded', async () => {
    if (!dbAvailable) return

    const rows = await sql<{
      id: string
      name: string
      enabled: boolean
      capital_allocation: number
    }[]>`
      SELECT id, name, enabled, capital_allocation
      FROM strategies
      WHERE id = 'layered'
    `
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Layered (5-layer Wyckoff)')
    expect(rows[0].enabled).toBe(true)
    expect(rows[0].capital_allocation).toBe(1.0)
  })

  it('orders table has strategy_id with default layered', async () => {
    if (!dbAvailable) return

    // Insert without specifying strategy_id
    await sql`
      INSERT INTO orders (coin, side, type, price, size)
      VALUES ('TEST_M005', 'long', 'market', 100, 0.1)
    `

    const rows = await sql<{ strategy_id: string }[]>`
      SELECT strategy_id FROM orders WHERE coin = 'TEST_M005'
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].strategy_id).toBe('layered')
  })

  it('orders table has cloid and fill_size columns (E29)', async () => {
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

  it('positions table has strategy_id with default layered', async () => {
    if (!dbAvailable) return

    // Insert without specifying strategy_id
    await sql`
      INSERT INTO positions (coin, side, entry_price, size)
      VALUES ('TEST_M005', 'long', 100, 0.1)
    `

    const rows = await sql<{ strategy_id: string }[]>`
      SELECT strategy_id FROM positions WHERE coin = 'TEST_M005'
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].strategy_id).toBe('layered')
  })

  it('trade_journal has strategy_id column with no default', async () => {
    if (!dbAvailable) return

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'trade_journal' AND table_schema = 'public'
    `
    const names = cols.map(c => c.column_name)
    expect(names).toContain('strategy_id')

    // Verify no default — legacy entries should have NULL strategy_id
    await sql`
      INSERT INTO trade_journal (event_type, details)
      VALUES ('test_m005', '{}')
    `
    const rows = await sql<{ strategy_id: string | null }[]>`
      SELECT strategy_id FROM trade_journal
      WHERE event_type = 'test_m005'
      ORDER BY ts DESC LIMIT 1
    `
    expect(rows[0].strategy_id).toBeNull()
  })

  it('strategy indexes exist', async () => {
    if (!dbAvailable) return

    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('idx_orders_strategy', 'idx_positions_strategy')
    `
    expect(result.length).toBe(2)
  })

  it('migration is idempotent', async () => {
    if (!dbAvailable) return

    // Remove 005 from tracking so it re-applies
    await sql`DELETE FROM schema_migrations WHERE version LIKE '005%'`

    const count = await runMigrations(sql)
    expect(count).toBeGreaterThanOrEqual(1)

    // Run again — should apply 0
    const count2 = await runMigrations(sql)
    expect(count2).toBe(0)
  })
})
