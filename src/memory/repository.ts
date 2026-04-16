/**
 * Memory Repository — CRUD + scored retrieval for trade memories.
 *
 * Sprint 6: Structured queries + FTS. No embeddings.
 * Scoring: recency (exponential decay) + importance + FTS rank.
 */

import { sql } from '../db/connection.js'
import type { JSONValue } from 'postgres'
import { log } from '../lib/logger.js'
import { MEMORY_DECAY_HALF_LIFE_DAYS, MEMORY_WEIGHTS } from '../config.js'
import type {
  TradeMemory,
  NewTradeMemory,
  MemoryQuery,
  ScoredMemory,
} from './types.js'

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface MemoryRow {
  id: number
  category: string
  coin: string | null
  timeframe: string | null
  pattern: string | null
  regime: string | null
  side: string | null
  pnl_r: number | null
  confidence: number | null
  content: string
  metadata: Record<string, unknown>
  importance: number
  access_count: number
  created_at: Date
  last_accessed_at: Date
}

function rowToMemory(r: MemoryRow): TradeMemory {
  return {
    id: r.id,
    category: r.category as TradeMemory['category'],
    coin: r.coin,
    timeframe: r.timeframe as TradeMemory['timeframe'],
    pattern: r.pattern,
    regime: r.regime as TradeMemory['regime'],
    side: r.side as TradeMemory['side'],
    pnlR: r.pnl_r,
    confidence: r.confidence,
    content: r.content,
    metadata: r.metadata,
    importance: r.importance,
    accessCount: r.access_count,
    createdAt: r.created_at,
    lastAccessedAt: r.last_accessed_at,
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Store a new memory. Fire-and-forget safe — catches errors internally.
 * Returns the inserted ID, or -1 on failure.
 */
export async function insertMemory(mem: NewTradeMemory): Promise<number> {
  try {
    const rows = await sql<{ id: number }[]>`
      INSERT INTO trade_memory (category, coin, timeframe, pattern, regime, side, pnl_r, confidence, content, metadata, importance)
      VALUES (
        ${mem.category},
        ${mem.coin ?? null},
        ${mem.timeframe ?? null},
        ${mem.pattern ?? null},
        ${mem.regime ?? null},
        ${mem.side ?? null},
        ${mem.pnlR ?? null},
        ${mem.confidence ?? null},
        ${mem.content},
        ${sql.json((mem.metadata ?? {}) as JSONValue)},
        ${mem.importance ?? 0.5}
      )
      RETURNING id
    `
    return rows[0]!.id
  } catch (err) {
    log.error('memory', `Failed to insert memory: ${(err as Error).message}`)
    return -1
  }
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** Get a single memory by ID. Bumps access_count. */
export async function getMemory(id: number): Promise<TradeMemory | null> {
  const rows = await sql<MemoryRow[]>`
    UPDATE trade_memory
    SET access_count = access_count + 1, last_accessed_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `
  return rows.length > 0 ? rowToMemory(rows[0]!) : null
}

/** Count all memories, optionally filtered by category. */
export async function countMemories(category?: string): Promise<number> {
  if (category) {
    const rows = await sql<{ cnt: string }[]>`
      SELECT COUNT(*)::text AS cnt FROM trade_memory WHERE category = ${category}
    `
    return Number(rows[0]!.cnt)
  }
  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM trade_memory
  `
  return Number(rows[0]!.cnt)
}

// ─── Scored Retrieval ────────────────────────────────────────────────────────

/**
 * Retrieve memories with combined scoring: recency + importance + FTS relevance.
 *
 * Recency: exp(-λ * days_old), where λ = ln(2) / halfLifeDays
 * FTS relevance: ts_rank when text query provided, else 0
 * Final score: w_recency * recency + w_importance * importance + w_relevance * fts_rank
 */
export async function queryMemories(query: MemoryQuery): Promise<ScoredMemory[]> {
  const limit = Math.min(Math.max(1, query.limit ?? 10), 100)
  const lambda = Math.LN2 / MEMORY_DECAY_HALF_LIFE_DAYS
  const { recency: wR, importance: wI, relevance: wRel } = MEMORY_WEIGHTS

  // Build WHERE conditions
  const conditions: ReturnType<typeof sql>[] = []
  if (query.category) conditions.push(sql`category = ${query.category}`)
  if (query.coin) conditions.push(sql`coin = ${query.coin}`)
  if (query.pattern) conditions.push(sql`pattern = ${query.pattern}`)
  if (query.regime) conditions.push(sql`regime = ${query.regime}`)
  if (query.side) conditions.push(sql`side = ${query.side}`)
  if (query.since) conditions.push(sql`created_at >= ${query.since}`)
  if (query.text) conditions.push(sql`search_vec @@ plainto_tsquery('english', ${query.text})`)

  const where = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
    : sql``

  // FTS rank expression (0 when no text query)
  const ftsRank = query.text
    ? sql`ts_rank(search_vec, plainto_tsquery('english', ${query.text}))`
    : sql`0`

  const rows = await sql<(MemoryRow & { score: number })[]>`
    SELECT *,
      (
        ${wR} * EXP(-${lambda} * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0)
        + ${wI} * importance
        + ${wRel} * ${ftsRank}
      ) AS score
    FROM trade_memory
    ${where}
    ORDER BY score DESC
    LIMIT ${limit}
  `

  // Bump access counts for retrieved memories
  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    sql`
      UPDATE trade_memory
      SET access_count = access_count + 1, last_accessed_at = NOW()
      WHERE id = ANY(${ids})
    `.catch(err => log.error('memory', `Failed to bump access: ${(err as Error).message}`))
  }

  return rows.map(r => ({ ...rowToMemory(r), score: r.score }))
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

/**
 * Decay old memories: delete low-importance, rarely-accessed memories older than retentionDays.
 * Returns number of deleted rows.
 */
export async function pruneMemories(retentionDays: number = 90): Promise<number> {
  const rows = await sql<{ cnt: string }[]>`
    WITH deleted AS (
      DELETE FROM trade_memory
      WHERE created_at < NOW() - INTERVAL '1 day' * ${retentionDays}
        AND access_count < 2
        AND importance < 0.4
        AND category NOT IN ('strategy_insight', 'pattern_insight')
      RETURNING id
    )
    SELECT COUNT(*)::text AS cnt FROM deleted
  `
  const count = Number(rows[0]!.cnt)
  if (count > 0) {
    log.info('memory', `Pruned ${count} stale memories (>${retentionDays}d, low importance)`)
  }
  return count
}
