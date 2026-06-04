import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * Integration test for migration runner.
 * Requires a running PostgreSQL+TimescaleDB instance.
 * Skips gracefully if DB is unavailable.
 *
 * Run: docker compose up -d && bun test --run
 */

const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://minh:minh_dev@localhost:5432/minh";
let sql: ReturnType<typeof postgres>;
let dbAvailable = false;

beforeAll(async () => {
  try {
    sql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 });
    await sql`SELECT 1`;
    dbAvailable = true;

    // Clear migration tracking so runMigrations() re-applies all files.
    // Uses DELETE instead of DROP TABLE to avoid AccessExclusiveLock deadlocks
    // when live app or parallel tests INSERT into candles concurrently.
    // Migrations use CREATE TABLE IF NOT EXISTS + create_hypertable(if_not_exists)
    // so re-running on existing tables is safe and idempotent.
    await sql`DELETE FROM schema_migrations`;
  } catch {
    // DB not available — tests will be skipped
  }
});

afterAll(async () => {
  if (dbAvailable) {
    // Re-run migrations to restore DB state for other parallel tests
    await runMigrations(sql);
    await sql.end();
  }
});

describe("runMigrations", () => {
  it("applies initial migration and creates tables", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping DB test — PostgreSQL not available");
      return;
    }

    const count = await runMigrations(sql);
    expect(count).toBeGreaterThanOrEqual(1); // 001_initial.sql + any subsequent migrations

    // Verify tables exist
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const names = tables.map((t) => t.tablename);
    expect(names).toContain("candles");
    expect(names).toContain("orders");
    expect(names).toContain("positions");
    expect(names).toContain("trade_journal");
    expect(names).toContain("schema_migrations");
  });

  it("is idempotent — second run applies 0 migrations", async () => {
    if (!dbAvailable) return;

    const count = await runMigrations(sql);
    expect(count).toBe(0);
  });

  it("candles is a hypertable", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT hypertable_name FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'candles'
    `;
    expect(result.length).toBe(1);
  });

  it("trade_journal is a hypertable", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT hypertable_name FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'trade_journal'
    `;
    expect(result.length).toBe(1);
  });

  it("orders table has CHECK on side (long|short) — verified via catalog, no failing INSERT", async () => {
    if (!dbAvailable) return;

    const rows = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public' AND t.relname = 'orders' AND c.contype = 'c'
    `;
    const sideCheck = rows.some(
      (r) =>
        r.def.includes("side") &&
        r.def.toLowerCase().includes("long") &&
        r.def.toLowerCase().includes("short"),
    );
    expect(sideCheck).toBe(true);
  });

  it("pnl_hourly materialized view exists", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT matviewname FROM pg_matviews
      WHERE matviewname = 'pnl_hourly'
    `;
    expect(result.length).toBe(1);
  });

  it("daily_performance materialized view exists (003)", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT matviewname FROM pg_matviews
      WHERE matviewname = 'daily_performance'
    `;
    expect(result.length).toBe(1);
  });

  it("pattern_performance materialized view exists (003)", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT matviewname FROM pg_matviews
      WHERE matviewname = 'pattern_performance'
    `;
    expect(result.length).toBe(1);
  });

  it("positions indexes exist (003)", async () => {
    if (!dbAvailable) return;

    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'positions'
        AND indexname IN ('idx_positions_closed_at', 'idx_positions_coin_status')
    `;
    expect(result.length).toBe(2);
  });
});
