/**
 * Memory types — structured trade memory for advisor context.
 *
 * Sprint 6: Structured-first approach. No embeddings, no vector search.
 * Trading data has known dimensions (coin, TF, pattern, regime, side, PnL).
 * SQL WHERE clauses beat nearest-neighbor search for structured data.
 */

import type { CandleInterval, MarketRegime, SignalSide } from '../types.js'

// ─── Memory Categories ──────────────────────────────────────────────────────

export type MemoryCategory =
  | 'trade_outcome'       // Closed trade with full context
  | 'pattern_insight'     // "OBs fail in SIDEWAYS regime — 38% win rate"
  | 'strategy_insight'    // Config/parameter decision: "Raised MIN_CONFIDENCE to 0.58"
  | 'error_lesson'        // Circuit breaker, cascade failure, feed outage
  | 'regime_transition'   // "BTC BULL→SIDEWAYS at 2026-03-15"

// ─── Memory Entry ────────────────────────────────────────────────────────────

export interface TradeMemory {
  id: number
  category: MemoryCategory
  coin: string | null
  timeframe: CandleInterval | null
  pattern: string | null
  regime: MarketRegime | null
  side: SignalSide | null
  pnlR: number | null
  confidence: number | null
  content: string
  metadata: Record<string, unknown>
  importance: number
  accessCount: number
  createdAt: Date
  lastAccessedAt: Date
}

// ─── Input for storing new memories ──────────────────────────────────────────

export interface NewTradeMemory {
  category: MemoryCategory
  coin?: string | null
  timeframe?: CandleInterval | null
  pattern?: string | null
  regime?: MarketRegime | null
  side?: SignalSide | null
  pnlR?: number | null
  confidence?: number | null
  content: string
  metadata?: Record<string, unknown>
  importance?: number
}

// ─── Query interface ─────────────────────────────────────────────────────────

export interface MemoryQuery {
  /** Filter by category. */
  category?: MemoryCategory
  /** Filter by coin. */
  coin?: string
  /** Filter by pattern type. */
  pattern?: string
  /** Filter by regime. */
  regime?: MarketRegime
  /** Filter by side. */
  side?: SignalSide
  /** Full-text search query. */
  text?: string
  /** Only memories after this date. */
  since?: Date
  /** Max results. */
  limit?: number
}

// ─── Scored result from retrieval ────────────────────────────────────────────

export interface ScoredMemory extends TradeMemory {
  /** Combined score: recency + importance + relevance. */
  score: number
}
