/**
 * Metrics Repo integration tests — requires PostgreSQL + TimescaleDB.
 *
 * Migration 013: analytics derive from trade_journal exit rows (the positions
 * table has no writer). Seeds journal exits and tests the SQL patterns +
 * matviews against them.
 *
 * Skips gracefully if DB is unavailable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { runMigrations } from "../db/migrate.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://minh:minh_dev@localhost:5432/minh";
let testSql: ReturnType<typeof postgres>;
let dbAvailable = false;

/** Seed one exit journal row shaped like buildExitJournalDetails output. */
function exitDetails(overrides: Record<string, unknown>): object {
  return {
    positionId: "pos-1",
    closePrice: 51000,
    pnl: 100,
    reason: "tp_hit",
    setupId: "BTC|1h|minh|long",
    interval: "1h",
    side: "long",
    confidence: 0.7,
    pattern: "minh",
    grade: "A",
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    testSql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 });
    await testSql`SELECT 1`;
    dbAvailable = true;

    // Ensure migrations are applied (013 re-sources matviews from the journal)
    await runMigrations(testSql);

    // Clean data for test isolation
    await testSql`DELETE FROM trade_journal`;

    // Seed exit journal rows — same-day timestamps to avoid UTC day boundaries.
    // Includes the excluded shapes: pnl=0 (signal-less) and audit row (no pnl).
    await testSql`
      INSERT INTO trade_journal (ts, event_type, coin, details, agent_state)
      VALUES
        (date_trunc('day', NOW()) + INTERVAL '1 hour', 'exit', 'BTC',
          ${testSql.json(exitDetails({ pnl: 100, grade: "A" }))}, 'IDLE'),
        (date_trunc('day', NOW()) + INTERVAL '2 hours', 'exit', 'BTC',
          ${testSql.json(exitDetails({ pnl: 50, side: "short", grade: "B" }))}, 'IDLE'),
        (date_trunc('day', NOW()) + INTERVAL '3 hours', 'exit', 'ETH',
          ${testSql.json(exitDetails({ pnl: -100, pattern: "minh", grade: "A" }))}, 'IDLE'),
        (date_trunc('day', NOW()) + INTERVAL '4 hours', 'exit', 'SOL',
          ${testSql.json(exitDetails({ pnl: 0 }))}, 'IDLE'),
        (date_trunc('day', NOW()) + INTERVAL '5 hours', 'exit', 'SOL',
          ${testSql.json({ reason: "exit_complete_no_position" })}, 'IDLE'),
        (date_trunc('day', NOW()) + INTERVAL '6 hours', 'enter', 'BTC',
          ${testSql.json({ orderId: "ord-1", fillPrice: 50000 })}, 'IN_POSITION')
    `;

    // Refresh matviews so queries work
    await testSql`REFRESH MATERIALIZED VIEW daily_performance`;
    await testSql`REFRESH MATERIALIZED VIEW pattern_performance`;
    await testSql`REFRESH MATERIALIZED VIEW pnl_hourly`;
  } catch {
    // DB not available — tests will be skipped
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await testSql`DELETE FROM trade_journal`;
    await testSql.end();
  }
});

// ─── We can't import metrics-repo directly (it uses the shared connection).
//     Instead test the SQL patterns directly against testSql. ─────────────────

describe("metrics-repo queries (journal-derived)", () => {
  it("closed trades come from exit rows; pnl=0 and audit rows excluded", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    const rows = await testSql<
      {
        coin: string;
        side: string | null;
        realized_pnl: number;
        closed_at: Date;
      }[]
    >`
      SELECT coin, details->>'side' AS side,
        (details->>'pnl')::double precision AS realized_pnl, ts AS closed_at
      FROM trade_journal
      WHERE event_type = 'exit' AND coin IS NOT NULL
        AND details->>'pnl' IS NOT NULL
        AND (details->>'pnl')::double precision != 0
      ORDER BY ts ASC
    `;
    // 3 signal-bearing exits; SOL pnl=0 + SOL audit row excluded
    expect(rows.length).toBe(3);
    expect(rows[0]?.coin).toBe("BTC");
    expect(rows[0]?.realized_pnl).toBe(100);
    expect(rows[0]?.side).toBe("long");
    expect(rows[2]?.coin).toBe("ETH");
    expect(rows[2]?.realized_pnl).toBe(-100);
  });

  it("wallet stats aggregate wins/losses from exit rows", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    const rows = await testSql<
      { wins: number; losses: number; trade_count: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE (details->>'pnl')::double precision > 0)::int AS wins,
        COUNT(*) FILTER (WHERE (details->>'pnl')::double precision < 0)::int AS losses,
        COUNT(*)::int AS trade_count
      FROM trade_journal
      WHERE event_type = 'exit'
        AND details->>'pnl' IS NOT NULL
        AND (details->>'pnl')::double precision != 0
    `;
    expect(Number(rows[0]?.wins)).toBe(2);
    expect(Number(rows[0]?.losses)).toBe(1);
    expect(Number(rows[0]?.trade_count)).toBe(3);
  });

  it("daily_performance matview aggregates journal exits", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    const rows = await testSql`
      SELECT day, coin, trades, wins, losses, total_pnl
      FROM daily_performance
      ORDER BY coin
    `;
    const btc = rows.find((r: { coin: string }) => r.coin === "BTC");
    expect(btc).toBeDefined();
    expect(Number(btc?.trades)).toBe(2);
    expect(Number(btc?.wins)).toBe(2); // 100 and 50 both positive
    expect(btc?.total_pnl).toBe(150);

    const eth = rows.find((r: { coin: string }) => r.coin === "ETH");
    expect(eth).toBeDefined();
    expect(Number(eth?.trades)).toBe(1);
    expect(Number(eth?.losses)).toBe(1);
    expect(eth?.total_pnl).toBe(-100);

    // SOL only had signal-less rows — no matview entry
    const sol = rows.find((r: { coin: string }) => r.coin === "SOL");
    expect(sol).toBeUndefined();
  });

  it("pattern_performance matview groups by pattern + grade from exit rows", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    const rows = await testSql`
      SELECT pattern_type, signal_grade, trades, wins, total_pnl
      FROM pattern_performance
      ORDER BY signal_grade
    `;
    const gradeA = rows.find(
      (r: { signal_grade: string }) => r.signal_grade === "A",
    );
    expect(gradeA).toBeDefined();
    expect(gradeA?.pattern_type).toBe("minh");
    expect(Number(gradeA?.trades)).toBe(2); // BTC +100 and ETH -100
    expect(Number(gradeA?.wins)).toBe(1);

    const gradeB = rows.find(
      (r: { signal_grade: string }) => r.signal_grade === "B",
    );
    expect(gradeB).toBeDefined();
    expect(Number(gradeB?.trades)).toBe(1);
  });

  it("pnl_hourly matview buckets journal exits", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    const rows = await testSql`
      SELECT bucket, coin, trades, total_pnl FROM pnl_hourly ORDER BY bucket
    `;
    expect(rows.length).toBe(3); // one bucket per seeded signal-bearing exit
  });

  it("refreshViews pattern: CONCURRENTLY works with unique indexes", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping — DB not available");
      return;
    }

    // Should not throw — matviews have data + NULL-free unique index keys
    await testSql`REFRESH MATERIALIZED VIEW CONCURRENTLY daily_performance`;
    await testSql`REFRESH MATERIALIZED VIEW CONCURRENTLY pattern_performance`;
    await testSql`REFRESH MATERIALIZED VIEW CONCURRENTLY pnl_hourly`;
  });
});
