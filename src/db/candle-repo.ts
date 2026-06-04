/**
 * Candle persistence layer — PostgreSQL write-through + gap-fill queries.
 * R14: Sync write-through (await each insert).
 * Lives in src/db/ (I/O boundary).
 */

import type { Candle, CandleInterval } from "../types.js";
import { sql } from "./connection.js";

// ─── Write Operations ─────────────────────────────────────────────────────

/**
 * Upsert a single candle (used for WS write-through).
 * ON CONFLICT → update OHLCV (WS may send updated current bar).
 * Retries once on deadlock (concurrent upserts for same coin across TFs).
 */
export async function upsertCandle(
  coin: string,
  interval: CandleInterval,
  candle: Candle,
): Promise<void> {
  const t = new Date(candle.t);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sql`
        INSERT INTO candles (coin, interval, t, o, h, l, c, v)
        VALUES (${coin}, ${interval}, ${t}, ${candle.o}, ${candle.h}, ${candle.l}, ${candle.c}, ${candle.v})
        ON CONFLICT (coin, interval, t)
        DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v
      `;
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("deadlock") && attempt === 0) {
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Bulk upsert candles (used for REST backfill persist).
 * Batches in chunks of 500 to avoid oversized SQL statements.
 */
export async function bulkUpsertCandles(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
): Promise<number> {
  if (candles.length === 0) return 0;

  const CHUNK_SIZE = 500;
  let persisted = 0;

  for (let i = 0; i < candles.length; i += CHUNK_SIZE) {
    const chunk = candles.slice(i, i + CHUNK_SIZE);
    const rows = chunk.map((c) => ({
      coin,
      interval,
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
    persisted += chunk.length;
  }

  return persisted;
}

// ─── Read Operations ──────────────────────────────────────────────────────

/**
 * Get the most recent candle timestamp from PG for a coin/interval.
 * Returns epoch ms, or null if no candles exist.
 */
export async function getLastTimestamp(
  coin: string,
  interval: CandleInterval,
): Promise<number | null> {
  const rows = await sql<{ t: Date }[]>`
    SELECT t FROM candles
    WHERE coin = ${coin} AND interval = ${interval}
    ORDER BY t DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0]!.t.getTime();
}

/**
 * Load candles from PG for a coin/interval.
 * Returns sorted ascending by timestamp, limited to `count` most recent.
 */
export async function loadCandles(
  coin: string,
  interval: CandleInterval,
  count: number,
): Promise<Candle[]> {
  const rows = await sql<
    { t: Date; o: number; h: number; l: number; c: number; v: number }[]
  >`
    SELECT t, o, h, l, c, v FROM candles
    WHERE coin = ${coin} AND interval = ${interval}
    ORDER BY t DESC
    LIMIT ${count}
  `;
  // Reverse to ascending order, convert Date → epoch ms
  return rows.reverse().map((r) => ({
    t: r.t.getTime(),
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
    v: r.v,
  }));
}

/**
 * Load candles ending before `beforeMs` (exclusive), newest-first query, ascending return.
 * Used by the dashboard chart history route to satisfy TradingView `countBack`.
 */
export async function loadCandlesBefore(
  coin: string,
  interval: CandleInterval,
  beforeMs: number,
  count: number,
): Promise<Candle[]> {
  const rows = await sql<
    { t: Date; o: number; h: number; l: number; c: number; v: number }[]
  >`
    SELECT t, o, h, l, c, v FROM candles
    WHERE coin = ${coin} AND interval = ${interval} AND t < ${new Date(beforeMs)}
    ORDER BY t DESC
    LIMIT ${count}
  `;

  return rows.reverse().map((r) => ({
    t: r.t.getTime(),
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
    v: r.v,
  }));
}

/** Load the most recent persisted candle for a coin/interval, or null if absent. */
export async function loadLatestCandle(
  coin: string,
  interval: CandleInterval,
): Promise<Candle | null> {
  const rows = await sql<
    { t: Date; o: number; h: number; l: number; c: number; v: number }[]
  >`
    SELECT t, o, h, l, c, v FROM candles
    WHERE coin = ${coin} AND interval = ${interval}
    ORDER BY t DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    t: row.t.getTime(),
    o: row.o,
    h: row.h,
    l: row.l,
    c: row.c,
    v: row.v,
  };
}

/**
 * Get last timestamps for all coin/interval pairs in one query.
 * Used during startup to compute gap-fill ranges efficiently.
 */
export async function getAllLastTimestamps(): Promise<Map<string, number>> {
  const rows = await sql<{ coin: string; interval: string; last_t: Date }[]>`
    SELECT coin, interval, MAX(t) AS last_t
    FROM candles
    GROUP BY coin, interval
  `;
  const result = new Map<string, number>();
  for (const r of rows) {
    result.set(`${r.coin}|${r.interval}`, r.last_t.getTime());
  }
  return result;
}

// ─── Gap-Fill Helpers (pure logic) ────────────────────────────────────────

/**
 * Compute the gap-fill start time for a coin/interval.
 * Returns startTime for REST fetch, or null if no gap (PG is empty → full backfill).
 *
 * Pure function — no I/O.
 */
export function computeGapStart(
  lastPgTimestamp: number | null,
  intervalMs: number,
): number | null {
  if (lastPgTimestamp === null) return null;
  // Start from next candle after last PG candle
  return lastPgTimestamp + intervalMs;
}

/**
 * Determine if gap-fill is needed (vs full backfill).
 * Gap-fill is worthwhile if the gap is less than the full backfill count.
 *
 * Pure function — no I/O.
 */
export function shouldGapFill(
  lastPgTimestamp: number | null,
  now: number,
  intervalMs: number,
  fullBackfillCount: number,
): boolean {
  if (lastPgTimestamp === null) return false;
  const gapCandles = Math.ceil((now - lastPgTimestamp) / intervalMs);
  // If gap is smaller than full backfill, gap-fill is faster
  return gapCandles < fullBackfillCount;
}
