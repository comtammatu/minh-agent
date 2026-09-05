/**
 * Metrics Repository — DB queries for analytics engine.
 *
 * Closed trades are derived from trade_journal exit rows — the positions
 * table never had a writer, so it (and anything built on it) was always
 * empty. Post advisor + EXITING-stranding fixes, every position close
 * produces exactly ONE exit row carrying pnl/side/pattern/grade, making the
 * journal the canonical closed-trade record (see migration 013 +
 * docs/archive/plan/implementation-notes-advisor-v1.md).
 *
 * Row convention (matches the advisor's isWin signal-less rule): exit rows
 * with NULL pnl are audit-only; pnl = 0 rows are signal-less (legacy
 * pre-estimate data, estimate-fallback closes) — both excluded from metrics.
 *
 * Design:
 *   - All reads are simple queries against trade_journal + matviews.
 *   - refreshViews() refreshes all analytics matviews CONCURRENTLY.
 *   - Called by MetricsEngine on trade close + periodic fallback.
 */

import { sql } from "../db/connection.js";
import { log } from "../lib/logger.js";
import type { ClosedTradeRow, DailyPerfRow, PatternPerfRow } from "./types.js";

const ANALYTICS_MATVIEWS = [
  "daily_performance",
  "pattern_performance",
  "pnl_hourly",
] as const;

type AnalyticsMatviewName = (typeof ANALYTICS_MATVIEWS)[number];

/** Matviews from 003/001 are created WITH NO DATA until first refresh; CONCURRENTLY is invalid until then. */
async function refreshMatviewPlain(name: AnalyticsMatviewName): Promise<void> {
  switch (name) {
    case "daily_performance":
      await sql`REFRESH MATERIALIZED VIEW daily_performance`;
      break;
    case "pattern_performance":
      await sql`REFRESH MATERIALIZED VIEW pattern_performance`;
      break;
    case "pnl_hourly":
      await sql`REFRESH MATERIALIZED VIEW pnl_hourly`;
      break;
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
    }
  }
}

/** Avoid REFRESH CONCURRENTLY while relispopulated is false (prevents server ERROR logs). */
async function ensureAnalyticsMatviewsPopulated(): Promise<void> {
  for (const name of ANALYTICS_MATVIEWS) {
    const rows = await sql<{ populated: boolean }[]>`
      SELECT c.relispopulated AS populated
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'm' AND c.relname = ${name}
    `;
    if (rows[0] && !rows[0].populated) {
      await refreshMatviewPlain(name);
    }
  }
}

// ─── Read: Closed Trades ─────────────────────────────────────────────────────

/**
 * Load all closed trades from trade_journal exit rows, chronologically
 * ordered (oldest first). Optional `since` filter for windowed queries.
 * `side` is null for rows journaled without setup context (e.g. closes of
 * crash-recovered positions).
 */
export async function getClosedTrades(since?: Date): Promise<ClosedTradeRow[]> {
  type Row = {
    coin: string;
    side: string | null;
    realized_pnl: number;
    closed_at: Date;
  };

  const rows = since
    ? await sql<Row[]>`
        SELECT coin, details->>'side' AS side,
          (details->>'pnl')::double precision AS realized_pnl, ts AS closed_at
        FROM trade_journal
        WHERE event_type = 'exit' AND coin IS NOT NULL
          AND details->>'pnl' IS NOT NULL
          AND (details->>'pnl')::double precision != 0
          AND ts >= ${since}
        ORDER BY ts ASC
      `
    : await sql<Row[]>`
        SELECT coin, details->>'side' AS side,
          (details->>'pnl')::double precision AS realized_pnl, ts AS closed_at
        FROM trade_journal
        WHERE event_type = 'exit' AND coin IS NOT NULL
          AND details->>'pnl' IS NOT NULL
          AND (details->>'pnl')::double precision != 0
        ORDER BY ts ASC
      `;

  return rows.map((r) => ({
    coin: r.coin,
    side: r.side === "long" || r.side === "short" ? r.side : null,
    realizedPnl: r.realized_pnl,
    closedAt: r.closed_at,
  }));
}

/** Closed trades aggregated for the canonical runtime wallet (for the live TUI account panel). */
export async function getClosedTradeStatsForWallet(): Promise<
  Array<{
    walletLabel: string;
    wins: number;
    losses: number;
    tradeCount: number;
  }>
> {
  type Row = { wins: string; losses: string; trade_count: string };
  const rows = await sql<Row[]>`
    SELECT
      COUNT(*) FILTER (WHERE (details->>'pnl')::double precision > 0)::int AS wins,
      COUNT(*) FILTER (WHERE (details->>'pnl')::double precision < 0)::int AS losses,
      COUNT(*)::int AS trade_count
    FROM trade_journal
    WHERE event_type = 'exit'
      AND details->>'pnl' IS NOT NULL
      AND (details->>'pnl')::double precision != 0
  `;
  return rows.map((r) => ({
    walletLabel: "minh",
    wins: Number(r.wins),
    losses: Number(r.losses),
    tradeCount: Number(r.trade_count),
  }));
}

// ─── Read: Materialized Views ────────────────────────────────────────────────

/**
 * Read daily_performance matview. Optional date range filter.
 */
export async function getDailyPerformance(
  since?: Date,
  until?: Date,
): Promise<DailyPerfRow[]> {
  type Row = {
    day: Date;
    coin: string;
    trades: string;
    wins: string;
    losses: string;
    total_pnl: number;
    avg_pnl: number;
    best_trade: number;
    worst_trade: number;
  };

  let rows: Row[];
  if (since && until) {
    rows = await sql<Row[]>`
      SELECT day, coin, trades, wins, losses, total_pnl, avg_pnl, best_trade, worst_trade
      FROM daily_performance WHERE day >= ${since} AND day <= ${until}
      ORDER BY day DESC, coin ASC
    `;
  } else if (since) {
    rows = await sql<Row[]>`
      SELECT day, coin, trades, wins, losses, total_pnl, avg_pnl, best_trade, worst_trade
      FROM daily_performance WHERE day >= ${since}
      ORDER BY day DESC, coin ASC
    `;
  } else {
    rows = await sql<Row[]>`
      SELECT day, coin, trades, wins, losses, total_pnl, avg_pnl, best_trade, worst_trade
      FROM daily_performance
      ORDER BY day DESC, coin ASC
    `;
  }

  return rows.map((r) => ({
    day: r.day,
    coin: r.coin,
    trades: Number(r.trades),
    wins: Number(r.wins),
    losses: Number(r.losses),
    totalPnl: r.total_pnl,
    avgPnl: r.avg_pnl,
    bestTrade: r.best_trade,
    worstTrade: r.worst_trade,
  }));
}

/**
 * Read pattern_performance matview. Optional week filter.
 */
export async function getPatternPerformance(
  since?: Date,
): Promise<PatternPerfRow[]> {
  type Row = {
    week: Date;
    pattern_type: string;
    signal_grade: string;
    trades: string;
    wins: string;
    total_pnl: number;
    avg_pnl: number;
  };

  const rows = since
    ? await sql<Row[]>`
        SELECT week, pattern_type, signal_grade, trades, wins, total_pnl, avg_pnl
        FROM pattern_performance WHERE week >= ${since}
        ORDER BY week DESC, total_pnl DESC
      `
    : await sql<Row[]>`
        SELECT week, pattern_type, signal_grade, trades, wins, total_pnl, avg_pnl
        FROM pattern_performance
        ORDER BY week DESC, total_pnl DESC
      `;

  return rows.map((r) => ({
    week: r.week,
    patternType: r.pattern_type,
    signalGrade: r.signal_grade,
    trades: Number(r.trades),
    wins: Number(r.wins),
    totalPnl: r.total_pnl,
    avgPnl: r.avg_pnl,
  }));
}

// ─── Matview Refresh ─────────────────────────────────────────────────────────

/**
 * Refresh all analytics materialized views.
 * Uses CONCURRENTLY where possible (requires unique index + existing data).
 * Falls back to regular refresh on first run (WITH NO DATA → no rows yet).
 *
 * Call this:
 *   1. After each trade close (fire-and-forget)
 *   2. On periodic fallback (e.g. every hour)
 */
export async function refreshViews(): Promise<void> {
  try {
    await ensureAnalyticsMatviewsPopulated();
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY daily_performance`;
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY pattern_performance`;
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY pnl_hourly`;
    log.debug("metrics-repo", "Matviews refreshed (CONCURRENTLY)");
  } catch {
    try {
      await sql`REFRESH MATERIALIZED VIEW daily_performance`;
      await sql`REFRESH MATERIALIZED VIEW pattern_performance`;
      await sql`REFRESH MATERIALIZED VIEW pnl_hourly`;
      log.debug("metrics-repo", "Matviews refreshed (full)");
    } catch (err) {
      log.error(
        "metrics-repo",
        `Matview refresh failed: ${(err as Error).message}`,
      );
    }
  }
}
