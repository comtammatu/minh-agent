import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { runMigrations } from '../../src/db/migrate.js'

const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgres://minh:minh_dev@localhost:5432/minh'
let sql: ReturnType<typeof postgres>
let dbAvailable = false

beforeAll(async () => {
  try {
    sql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 })
    await sql`SELECT 1`
    dbAvailable = true
    await sql`DELETE FROM schema_migrations`
    await runMigrations(sql)
  } catch {
    // DB not available — tests will be skipped.
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await sql`DELETE FROM orders WHERE coin IN ('TEST_M011_HL', 'TEST_M011_BB')`
  await runMigrations(sql)
  await sql.end()
})

describe('migration 011 — orders cloid recovery', () => {
  it('backfills cloid from exchange_order_id only for HL cloid-like IDs', async () => {
    if (!dbAvailable) return

    const hlCloid = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const bbOrderId = 'be411c88-1111-2222-3333-444444444444'

    await sql`
      INSERT INTO orders (coin, side, type, price, size, exchange, exchange_order_id, cloid)
      VALUES ('TEST_M011_HL', 'long', 'limit', 100, 0.1, 'HL', ${hlCloid}, NULL)
    `
    await sql`
      INSERT INTO orders (coin, side, type, price, size, exchange, exchange_order_id, cloid)
      VALUES ('TEST_M011_BB', 'long', 'limit', 100, 0.1, 'BB', ${bbOrderId}, NULL)
    `

    // Re-run 011 only to verify idempotent backfill behavior.
    await sql`DELETE FROM schema_migrations WHERE version = '011_orders_cloid_recovery'`
    await runMigrations(sql)

    const rows = await sql<{ coin: string; cloid: string | null }[]>`
      SELECT coin, cloid FROM orders
      WHERE coin IN ('TEST_M011_HL', 'TEST_M011_BB')
    `
    const byCoin = new Map(rows.map(r => [r.coin, r.cloid]))
    expect(byCoin.get('TEST_M011_HL')).toBe(hlCloid)
    expect(byCoin.get('TEST_M011_BB')).not.toBe(bbOrderId)
  })

  it('creates cloid recovery index', async () => {
    if (!dbAvailable) return

    const result = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'idx_orders_exchange_coin_cloid'
    `
    expect(result).toHaveLength(1)
  })
})
