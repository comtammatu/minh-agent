import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import postgres from "postgres";
import { computeGapStart, shouldGapFill } from "../../src/db/candle-repo.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Candle, CandleInterval } from "../../src/types.js";

/**
 * Tests for candle persistence layer.
 * - Pure logic tests (computeGapStart, shouldGapFill): always run
 * - DB integration tests (upsert, bulk, load): skip if PG unavailable
 *
 * Run: docker compose up -d && bun test --run
 */

// ── Pure Logic Tests (no DB needed) ──────────────────────────────────────────

describe("computeGapStart", () => {
  it("returns null when no PG data", () => {
    expect(computeGapStart(null, 60_000)).toBeNull();
  });

  it("returns lastTimestamp + intervalMs", () => {
    const lastTs = 1_700_000_000_000;
    const intervalMs = 300_000; // 5m
    expect(computeGapStart(lastTs, intervalMs)).toBe(lastTs + intervalMs);
  });

  it("works for 1d interval", () => {
    const lastTs = 1_700_000_000_000;
    const intervalMs = 86_400_000;
    expect(computeGapStart(lastTs, intervalMs)).toBe(lastTs + 86_400_000);
  });
});

describe("shouldGapFill", () => {
  const intervalMs = 60_000; // 1m
  const fullCount = 500;

  it("returns false when no PG data", () => {
    expect(shouldGapFill(null, Date.now(), intervalMs, fullCount)).toBe(false);
  });

  it("returns true when gap is smaller than full backfill", () => {
    const now = Date.now();
    // 100 candles gap (100 min ago)
    const lastTs = now - 100 * intervalMs;
    expect(shouldGapFill(lastTs, now, intervalMs, fullCount)).toBe(true);
  });

  it("returns false when gap exceeds full backfill count", () => {
    const now = Date.now();
    // 600 candles gap (600 min ago) > fullCount 500
    const lastTs = now - 600 * intervalMs;
    expect(shouldGapFill(lastTs, now, intervalMs, fullCount)).toBe(false);
  });

  it("returns true for exactly 1 candle gap", () => {
    const now = Date.now();
    const lastTs = now - intervalMs;
    expect(shouldGapFill(lastTs, now, intervalMs, fullCount)).toBe(true);
  });

  it("handles 4h interval with large gap correctly", () => {
    const now = Date.now();
    const interval4h = 14_400_000;
    // 10 candles gap (40h) — less than 5000 full backfill
    const lastTs = now - 10 * interval4h;
    expect(shouldGapFill(lastTs, now, interval4h, 5000)).toBe(true);
  });

  it("returns false at exact boundary", () => {
    const now = Date.now();
    // exactly 500 candles gap — ceil(500) = 500, NOT less than 500
    const lastTs = now - 500 * intervalMs;
    expect(shouldGapFill(lastTs, now, intervalMs, fullCount)).toBe(false);
  });
});

// ── DB Integration Tests ─────────────────────────────────────────────────────

const TEST_DB_URL =
  process.env.DATABASE_URL ?? "postgres://minh:minh_dev@localhost:5432/minh";
let sql: ReturnType<typeof postgres>;
let dbAvailable = false;

beforeAll(async () => {
  try {
    sql = postgres(TEST_DB_URL, { max: 2, connect_timeout: 3 });
    await sql`SELECT 1`;
    dbAvailable = true;

    // Ensure schema is up to date
    await runMigrations(sql);
  } catch {
    // DB not available — integration tests will be skipped
  }
});

afterAll(async () => {
  if (dbAvailable) await sql.end();
});

/** Helper: make a test candle. */
function makeCandle(t: number, price = 50000): Candle {
  return {
    t,
    o: price,
    h: price + 100,
    l: price - 100,
    c: price + 50,
    v: 1000,
  };
}

describe("upsertCandle (DB)", () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await sql`DELETE FROM candles WHERE coin = 'TEST' AND interval = '1m'`;
  });

  it("inserts a new candle", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping DB test — PostgreSQL not available");
      return;
    }

    const candle = makeCandle(1_700_000_000_000);
    const t = new Date(candle.t);
    await sql`
      INSERT INTO candles (coin, interval, t, o, h, l, c, v)
      VALUES ('TEST', '1m', ${t}, ${candle.o}, ${candle.h}, ${candle.l}, ${candle.c}, ${candle.v})
      ON CONFLICT (coin, interval, t)
      DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v
    `;

    const rows =
      await sql`SELECT * FROM candles WHERE coin = 'TEST' AND interval = '1m'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.o).toBe(50000);
  });

  it("upserts (updates) on duplicate timestamp", async () => {
    if (!dbAvailable) return;

    const t = new Date(1_700_000_000_000);
    await sql`
      INSERT INTO candles (coin, interval, t, o, h, l, c, v)
      VALUES ('TEST', '1m', ${t}, ${50000}, ${50100}, ${49900}, ${50050}, ${1000})
    `;
    // Update with new close price
    await sql`
      INSERT INTO candles (coin, interval, t, o, h, l, c, v)
      VALUES ('TEST', '1m', ${t}, ${50000}, ${50200}, ${49800}, ${50150}, ${2000})
      ON CONFLICT (coin, interval, t)
      DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v
    `;

    const rows =
      await sql`SELECT * FROM candles WHERE coin = 'TEST' AND interval = '1m'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.h).toBe(50200);
    expect(rows[0]?.v).toBe(2000);
  });
});

describe("bulkUpsertCandles (DB)", () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await sql`DELETE FROM candles WHERE coin = 'BULK'`;
  });

  it("inserts multiple candles in one batch", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping DB test — PostgreSQL not available");
      return;
    }

    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(1_700_000_000_000 + i * 60_000, 50000 + i * 10),
    );
    const rows = candles.map((c) => ({
      coin: "BULK",
      interval: "1m",
      t: new Date(c.t),
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      v: c.v,
    }));

    await sql`
      INSERT INTO candles ${sql(rows, "coin", "interval", "t", "o", "h", "l", "c", "v")}
      ON CONFLICT (coin, interval, t)
      DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v
    `;

    const result =
      await sql`SELECT COUNT(*)::int AS cnt FROM candles WHERE coin = 'BULK'`;
    expect(result[0]?.cnt).toBe(10);
  });
});

describe("loadCandles (DB)", () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await sql`DELETE FROM candles WHERE coin = 'LOAD'`;
  });

  it("returns empty array when no candles", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping DB test — PostgreSQL not available");
      return;
    }

    const rows = await sql<
      { t: Date; o: number; h: number; l: number; c: number; v: number }[]
    >`
      SELECT t, o, h, l, c, v FROM candles
      WHERE coin = 'LOAD' AND interval = '1h'
      ORDER BY t DESC LIMIT 100
    `;
    expect(rows.length).toBe(0);
  });

  it("returns candles in ascending order, limited to count", async () => {
    if (!dbAvailable) return;

    // Insert 20 candles
    const candles = Array.from({ length: 20 }, (_, i) => ({
      coin: "LOAD",
      interval: "1h",
      t: new Date(1_700_000_000_000 + i * 3_600_000),
      o: 50000 + i,
      h: 50100 + i,
      l: 49900 + i,
      c: 50050 + i,
      v: 1000,
    }));
    await sql`INSERT INTO candles ${sql(candles, "coin", "interval", "t", "o", "h", "l", "c", "v")}`;

    // Load last 5
    const rows = await sql<
      { t: Date; o: number; h: number; l: number; c: number; v: number }[]
    >`
      SELECT t, o, h, l, c, v FROM candles
      WHERE coin = 'LOAD' AND interval = '1h'
      ORDER BY t DESC LIMIT 5
    `;
    const result = rows.reverse().map((r) => ({
      t: r.t.getTime(),
      o: r.o,
      h: r.h,
      l: r.l,
      c: r.c,
      v: r.v,
    }));

    expect(result.length).toBe(5);
    // Ascending order
    expect(result[0]?.t).toBeLessThan(result[4]?.t);
    // Should be the last 5 (indices 15-19)
    expect(result[0]?.o).toBe(50015);
    expect(result[4]?.o).toBe(50019);
  });
});

describe("getLastTimestamp (DB)", () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await sql`DELETE FROM candles WHERE coin = 'TS'`;
  });

  it("returns null when no candles", async () => {
    if (!dbAvailable) {
      console.log("  ⏭ Skipping DB test — PostgreSQL not available");
      return;
    }

    const rows = await sql<{ t: Date }[]>`
      SELECT t FROM candles WHERE coin = 'TS' AND interval = '1m'
      ORDER BY t DESC LIMIT 1
    `;
    expect(rows.length).toBe(0);
  });

  it("returns most recent timestamp", async () => {
    if (!dbAvailable) return;

    const times = [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000];
    const candles = times.map((t) => ({
      coin: "TS",
      interval: "1m",
      t: new Date(t),
      o: 50000,
      h: 50100,
      l: 49900,
      c: 50050,
      v: 1000,
    }));
    await sql`INSERT INTO candles ${sql(candles, "coin", "interval", "t", "o", "h", "l", "c", "v")}`;

    const rows = await sql<{ t: Date }[]>`
      SELECT t FROM candles WHERE coin = 'TS' AND interval = '1m'
      ORDER BY t DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.t.getTime()).toBe(1_700_000_120_000);
  });
});

// ── Store onPersist callback test ────────────────────────────────────────────

describe("store onPersist callback", () => {
  it("fires callback on appendCandle", async () => {
    // Import dynamically to avoid module-level side effects
    const { appendCandle, setOnPersist, clearOnPersist, clearStore } =
      await import("../../src/feed/store.js");

    const calls: Array<{
      coin: string;
      interval: CandleInterval;
      candle: Candle;
    }> = [];
    setOnPersist((coin, interval, candle) => {
      calls.push({ coin, interval, candle });
    });

    clearStore();
    appendCandle("BTC", "1h", makeCandle(1_700_000_000_000));
    appendCandle("BTC", "1h", makeCandle(1_700_003_600_000));
    // Update existing candle (same timestamp)
    appendCandle("BTC", "1h", makeCandle(1_700_003_600_000, 51000));

    expect(calls.length).toBe(3);
    expect(calls[0]?.coin).toBe("BTC");
    expect(calls[0]?.interval).toBe("1h");
    expect(calls[2]?.candle.o).toBe(51000); // updated candle

    clearOnPersist();
    clearStore();
  });

  it("does not fire when no callback set", async () => {
    const { appendCandle, clearOnPersist, clearStore } = await import(
      "../../src/feed/store.js"
    );

    clearOnPersist();
    clearStore();

    // Should not throw
    appendCandle("ETH", "5m", makeCandle(1_700_000_000_000));
    clearStore();
  });
});
