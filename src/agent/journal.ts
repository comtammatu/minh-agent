/**
 * Trade Journal — persists every agent decision to PostgreSQL.
 *
 * S9: Audit trail for signal/enter/exit/skip/invalidate/circuit_break/error events.
 *
 * Design:
 *   - log() is fire-and-forget: errors are caught + logged, never bubble up.
 *   - getEntries() and dailySummary() are read queries for API/dashboard.
 *   - Wired to TradingAgent.onAction() — every log_journal action gets persisted.
 */

import type { JSONValue } from "postgres";
import { sql } from "../db/connection.js";
import { log } from "../lib/logger.js";
import { insertMemory } from "../memory/index.js";
import type {
  CandleInterval,
  ExchangeId,
  MarketRegime,
  SignalSide,
} from "../types.js";
import type {
  AgentAction,
  DailySummary,
  JournalEntry,
  JournalFilter,
} from "./types.js";

const CANDLE_INTERVALS: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
];
const MARKET_REGIMES: readonly MarketRegime[] = [
  "BULL",
  "BEAR",
  "SIDEWAYS",
  "VOLATILE",
];
const SIGNAL_SIDES: readonly SignalSide[] = ["long", "short"];
const BASE_EXIT_MEMORY_IMPORTANCE = 0.5;
const HIGH_R_EXIT_IMPORTANCE = 0.9;

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function candleIntervalValue(value: unknown): CandleInterval | null {
  return typeof value === "string" &&
    CANDLE_INTERVALS.includes(value as CandleInterval)
    ? (value as CandleInterval)
    : null;
}

function marketRegimeValue(value: unknown): MarketRegime | null {
  return typeof value === "string" &&
    MARKET_REGIMES.includes(value as MarketRegime)
    ? (value as MarketRegime)
    : null;
}

function signalSideValue(value: unknown): SignalSide | null {
  return typeof value === "string" && SIGNAL_SIDES.includes(value as SignalSide)
    ? (value as SignalSide)
    : null;
}

function exitMemoryImportance(pnl: number, pnlR: number | null): number {
  if (pnlR !== null) {
    return Math.min(HIGH_R_EXIT_IMPORTANCE, Math.abs(pnlR) / 5);
  }
  return pnl === 0 ? BASE_EXIT_MEMORY_IMPORTANCE : 0.6;
}

function maybeWriteExitMemory(
  eventType: string,
  coin: string | null,
  details: Record<string, unknown>,
): void {
  const pnl = numericValue(details.pnl);
  if (eventType !== "exit" || pnl === null) return;

  const pnlR = numericValue(details.pnlR) ?? numericValue(details.realizedPnlR);
  const side = signalSideValue(details.side);
  const timeframe = candleIntervalValue(details.interval ?? details.timeframe);
  const regime = marketRegimeValue(details.regime);
  const confidence = numericValue(details.confidence);
  const setupId = stringValue(details.setupId);
  const exitReason = stringValue(details.reason ?? details.exitReason);
  const pattern = stringValue(details.pattern ?? details.type);
  const sideText = side ? ` ${side}` : "";
  const reasonText = exitReason ? ` via ${exitReason}` : "";
  const rText = pnlR !== null ? ` (${pnlR}R)` : "";

  insertMemory({
    category: "trade_outcome",
    coin,
    timeframe,
    pattern,
    regime,
    side,
    pnlR,
    confidence,
    content: `Closed ${coin ?? "unknown"}${sideText} pnl=${pnl}${rText}${reasonText}`,
    metadata: {
      eventType,
      coin,
      ...details,
      pnl,
      ...(pnlR !== null ? { pnlR } : {}),
      ...(setupId ? { setupId } : {}),
      ...(exitReason ? { exitReason } : {}),
      ...(confidence !== null ? { confidence } : {}),
      ...(regime ? { regime } : {}),
    },
    importance: exitMemoryImportance(pnl, pnlR),
  }).catch(() => {});
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist a journal entry. Fire-and-forget — never throws.
 */
export async function logJournalEntry(
  eventType: string,
  coin: string | null,
  details: Record<string, unknown>,
  agentState?: string | null,
  exchange: ExchangeId = "HL",
): Promise<void> {
  try {
    await sql`
      INSERT INTO trade_journal (event_type, coin, details, agent_state, exchange)
      VALUES (${eventType}, ${coin}, ${sql.json(details as JSONValue)}, ${agentState ?? null}, ${exchange})
    `;

    maybeWriteExitMemory(eventType, coin, details);
  } catch (err) {
    log.error(
      "journal",
      `Failed to write entry: ${eventType} ${coin ?? ""} — ${(err as Error).message}`,
    );
  }
}

/**
 * Handle a log_journal action from the agent state machine.
 * Extracts fields and delegates to logJournalEntry.
 */
export function handleJournalAction(
  action: AgentAction,
  agentState?: string,
): void {
  if (action.type !== "log_journal") return;
  // Fire-and-forget — no await needed at call site
  logJournalEntry(
    action.eventType,
    action.coin,
    action.details,
    agentState ?? null,
  );
}

/**
 * Log an operator audit entry (remote operator action from Telegram / API).
 * Fire-and-forget — never throws.
 */
export async function logOperatorAuditEntry(
  action: string,
  target: string,
  status: "submitted" | "failed",
  context: {
    coin?: string;
    source?: string;
    details?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await logJournalEntry(
    "operator",
    context.coin ?? null,
    {
      action,
      target,
      status,
      operatorSource: context.source ?? null,
      ...(context.details ?? {}),
    },
    null,
  );
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Query journal entries with optional filters.
 * Uses explicit query branches to keep SQL testable with simple mocks.
 */
export async function getJournalEntries(
  filter: JournalFilter = {},
): Promise<JournalEntry[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 500);
  const { coin, eventType, since, until, exchange } = filter;

  type Row = {
    id: number;
    ts: Date;
    event_type: string;
    coin: string | null;
    details: Record<string, unknown>;
    agent_state: string | null;
    exchange: string;
  };

  let rows: Row[];

  if (coin && eventType) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE coin = ${coin} AND event_type = ${eventType}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (coin) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE coin = ${coin}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (eventType) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE event_type = ${eventType}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (since && until) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts >= ${since} AND ts <= ${until}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (since) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts >= ${since}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (until) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts <= ${until}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else if (exchange) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE exchange = ${exchange}
      ORDER BY ts DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      ORDER BY ts DESC LIMIT ${limit}
    `;
  }

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    eventType: r.event_type as JournalEntry["eventType"],
    coin: r.coin,
    details: r.details,
    agentState: r.agent_state,
    exchange: (r.exchange ?? "HL") as ExchangeId,
  }));
}

/**
 * Get aggregate PnL summary for a given date (UTC day).
 * Looks at 'exit' events that have a numeric `pnl` in details.
 */
export async function getDailySummary(date: Date): Promise<DailySummary> {
  const dayStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const dayStart = new Date(`${dayStr}T00:00:00Z`);
  const dayEnd = new Date(`${dayStr}T23:59:59.999Z`);

  // Exit events with PnL for win/loss stats
  const exitRows = await sql<
    {
      pnl: number;
    }[]
  >`
    SELECT (details->>'pnl')::double precision AS pnl
    FROM trade_journal
    WHERE event_type = 'exit'
      AND ts >= ${dayStart}
      AND ts <= ${dayEnd}
      AND details->>'pnl' IS NOT NULL
  `;

  // Total entry count for the day
  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM trade_journal
    WHERE ts >= ${dayStart} AND ts <= ${dayEnd}
  `;
  const entryCount = Number(countRows[0]?.cnt ?? 0);

  const pnls = exitRows.map((r) => r.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0);

  return {
    date: dayStr,
    totalTrades: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: pnls.length > 0 ? wins.length / pnls.length : 0,
    totalPnl,
    avgPnl: pnls.length > 0 ? totalPnl / pnls.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    entryCount,
  };
}

/**
 * Same as {@link getDailySummary} but for a calendar date in an IANA timezone (e.g. Asia/Ho_Chi_Minh).
 * `dateYmd` must be `YYYY-MM-DD`. Used for Telegram morning/evening reports.
 */
export async function getDailySummaryForLocalDate(
  dateYmd: string,
  timeZone: string,
): Promise<DailySummary> {
  const exitRows = await sql<
    {
      pnl: number;
    }[]
  >`
    SELECT (details->>'pnl')::double precision AS pnl
    FROM trade_journal
    WHERE event_type = 'exit'
      AND (ts AT TIME ZONE ${timeZone})::date = ${dateYmd}::date
      AND details->>'pnl' IS NOT NULL
  `;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt
    FROM trade_journal
    WHERE (ts AT TIME ZONE ${timeZone})::date = ${dateYmd}::date
  `;
  const entryCount = Number(countRows[0]?.cnt ?? 0);

  const pnls = exitRows.map((r) => r.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0);

  return {
    date: dateYmd,
    totalTrades: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: pnls.length > 0 ? wins.length / pnls.length : 0,
    totalPnl,
    avgPnl: pnls.length > 0 ? totalPnl / pnls.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    entryCount,
  };
}
