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

import { sql } from '../db/connection.js'
import type { JSONValue } from 'postgres'
import { log } from '../lib/logger.js'
import type {
  AgentAction,
  JournalEntry,
  JournalFilter,
  DailySummary,
} from './types.js'
import type { ExchangeId } from '../types.js'

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist a journal entry. Fire-and-forget — never throws.
 */
export async function logJournalEntry(
  eventType: string,
  coin: string | null,
  details: Record<string, unknown>,
  agentState?: string | null,
  strategyId?: string | null,
  exchange: ExchangeId = 'HL',
): Promise<void> {
  try {
    await sql`
      INSERT INTO trade_journal (event_type, coin, details, agent_state, strategy_id, exchange)
      VALUES (${eventType}, ${coin}, ${sql.json(details as JSONValue)}, ${agentState ?? null}, ${strategyId ?? 'smc-sd'}, ${exchange})
    `
  } catch (err) {
    log.error('journal', `Failed to write entry: ${eventType} ${coin ?? ''} — ${(err as Error).message}`)
  }
}

/**
 * Handle a log_journal action from the agent state machine.
 * Extracts fields and delegates to logJournalEntry.
 */
export function handleJournalAction(action: AgentAction, agentState?: string): void {
  if (action.type !== 'log_journal') return
  // Extract strategyId from details if present (Sprint 4.5)
  const strategyId = (action.details.strategyId as string) ?? null
  // Fire-and-forget — no await needed at call site
  logJournalEntry(action.eventType, action.coin, action.details, agentState ?? null, strategyId)
}

/**
 * Log an operator audit entry (remote operator action from Telegram / API).
 * Fire-and-forget — never throws.
 */
export async function logOperatorAuditEntry(
  action: string,
  target: string,
  status: 'submitted' | 'failed',
  context: {
    coin?: string
    strategyId?: string
    source?: string
    details?: Record<string, unknown>
  } = {},
): Promise<void> {
  await logJournalEntry(
    'operator',
    context.coin ?? null,
    {
      action,
      target,
      status,
      operatorSource: context.source ?? null,
      ...(context.details ?? {}),
    },
    null,
    context.strategyId ?? null,
  )
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Query journal entries with optional filters.
 * Uses explicit query branches to keep SQL testable with simple mocks.
 */
export async function getJournalEntries(filter: JournalFilter = {}): Promise<JournalEntry[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 500)
  const { coin, eventType, since, until, exchange } = filter

  type Row = {
    id: number; ts: Date; event_type: string
    coin: string | null; details: Record<string, unknown>
    agent_state: string | null; exchange: string
  }

  let rows: Row[]

  if (coin && eventType) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE coin = ${coin} AND event_type = ${eventType}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (coin) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE coin = ${coin}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (eventType) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE event_type = ${eventType}
      ${since ? sql`AND ts >= ${since}` : sql``}
      ${until ? sql`AND ts <= ${until}` : sql``}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (since && until) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts >= ${since} AND ts <= ${until}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (since) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts >= ${since}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (until) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE ts <= ${until}
      ${exchange ? sql`AND exchange = ${exchange}` : sql``}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else if (exchange) {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      WHERE exchange = ${exchange}
      ORDER BY ts DESC LIMIT ${limit}
    `
  } else {
    rows = await sql<Row[]>`
      SELECT id, ts, event_type, coin, details, agent_state, exchange FROM trade_journal
      ORDER BY ts DESC LIMIT ${limit}
    `
  }

  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    eventType: r.event_type as JournalEntry['eventType'],
    coin: r.coin,
    details: r.details,
    agentState: r.agent_state,
    exchange: (r.exchange ?? 'HL') as ExchangeId,
  }))
}

/**
 * Get aggregate PnL summary for a given date (UTC day).
 * Looks at 'exit' events that have a numeric `pnl` in details.
 */
export async function getDailySummary(date: Date): Promise<DailySummary> {
  const dayStr = date.toISOString().slice(0, 10)  // YYYY-MM-DD
  const dayStart = new Date(`${dayStr}T00:00:00Z`)
  const dayEnd = new Date(`${dayStr}T23:59:59.999Z`)

  // Exit events with PnL for win/loss stats
  const exitRows = await sql<{
    pnl: number
  }[]>`
    SELECT (details->>'pnl')::double precision AS pnl
    FROM trade_journal
    WHERE event_type = 'exit'
      AND ts >= ${dayStart}
      AND ts <= ${dayEnd}
      AND details->>'pnl' IS NOT NULL
  `

  // Total entry count for the day
  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM trade_journal
    WHERE ts >= ${dayStart} AND ts <= ${dayEnd}
  `
  const entryCount = Number(countRows[0]?.cnt ?? 0)

  const pnls = exitRows.map(r => r.pnl)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0)

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
  }
}

/**
 * Same as {@link getDailySummary} but for a calendar date in an IANA timezone (e.g. Asia/Ho_Chi_Minh).
 * `dateYmd` must be `YYYY-MM-DD`. Used for Telegram morning/evening reports.
 */
export async function getDailySummaryForLocalDate(dateYmd: string, timeZone: string): Promise<DailySummary> {
  const exitRows = await sql<{
    pnl: number
  }[]>`
    SELECT (details->>'pnl')::double precision AS pnl
    FROM trade_journal
    WHERE event_type = 'exit'
      AND (ts AT TIME ZONE ${timeZone})::date = ${dateYmd}::date
      AND details->>'pnl' IS NOT NULL
  `

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt
    FROM trade_journal
    WHERE (ts AT TIME ZONE ${timeZone})::date = ${dateYmd}::date
  `
  const entryCount = Number(countRows[0]?.cnt ?? 0)

  const pnls = exitRows.map(r => r.pnl)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const totalPnl = pnls.reduce((sum, p) => sum + p, 0)

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
  }
}
