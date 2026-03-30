import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { runMigrations } from '../../src/db/migrate.js'

/**
 * Integration test for migration runner.
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

    // Clean slate: drop all tables so migration runs fresh
    await sql.unsafe(`
      DROP MATERIALIZED VIEW IF EXISTS pnl_hourly CASCADE;
      DROP TABLE IF EXISTS candles CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS positions CASCADE;
      DROP TABLE IF EXISTS trade_journal CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `)
  } catch {
    // DB not available — tests will be skipped
  }
})

afterAll(async () => {
  if (dbAvailable) {
    // Re-run migrations to restore DB state for other parallel tests
    await runMigrations(sql)
    await sql.end()
  }
})

describe('runMigrations', () => {
  it('applies initial migration and creates tables', async () => {
    if (!dbAvailable) {
      console.log('  ⏭ Skipping DB test — PostgreSQL not available')
      return
    }

    const count = await runMigrations(sql)
    expect(count).toBeGreaterThanOrEqual(1) // 001_initial.sql + any subsequent migrations

    // Verify tables exist
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      ORDER BY tablename
    `
    const names = tables.map(t => t.tablename)
    expect(names).toContain('candles')
    expect(names).toContain('orders')
    expect(names).toContain('positions')
    expect(names).toContain('trade_journal')
    expect(names).toContain('schema_migrations')
  })

  it('is idempotent — second run applies 0 migrations', async () => {
    if (!dbAvailable) return

    const count = await runMigrations(sql)
    expect(count).toBe(0)
  })

  it('candles is a hypertable', async () => {
    if (!dbAvailable) return

    const result = await sql`
      SELECT hypertable_name FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'candles'
    `
    expect(result.length).toBe(1)
  })

  it('trade_journal is a hypertable', async () => {
    if (!dbAvailable) return

    const result = await sql`
      SELECT hypertable_name FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'trade_journal'
    `
    expect(result.length).toBe(1)
  })

  it('orders table has correct constraints', async () => {
    if (!dbAvailable) return

    // Insert valid order
    await sql`
      INSERT INTO orders (coin, side, type, price, size)
      VALUES ('BTC', 'long', 'market', 50000, 0.1)
    `

    // Invalid side should fail
    let threw = false
    try {
      await sql`
        INSERT INTO orders (coin, side, type, price, size)
        VALUES ('BTC', 'invalid', 'market', 50000, 0.1)
      `
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('pnl_hourly materialized view exists', async () => {
    if (!dbAvailable) return

    const result = await sql`
      SELECT matviewname FROM pg_matviews
      WHERE matviewname = 'pnl_hourly'
    `
    expect(result.length).toBe(1)
  })
})
