# Minh (明) — Sprint 6: REMEMBER I — Memory Foundation

> Roadmap note (2026-04-15): this sprint remains a design draft on the current branch. There is no `src/memory/` implementation or advisor-memory subsystem in the repo today.

## Goal

Upgrade the Sprint 5 stateless LLM Advisor into a **memory-augmented system** by adding: layered memory architecture (working → episodic → semantic), contextual trade preprocessing, and hybrid retrieval (pgvector + BM25 + RRF). The advisor stops starting from zero on every query.

**Sprint 6 = REMEMBER I. Give the advisor persistent memory. Foundation only — no graph, no HyDE yet.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine
Sprint 2: ACT        ✅ → Agent execution
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     ✅ → Telegram + Dashboard extensions
Sprint 5: ADVISE     ✅ → Basic LLM Advisor (stateless)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning)
```

### Research Foundation

This sprint implements two proven techniques:

**1. Anthropic Contextual Retrieval** (https://www.anthropic.com/engineering/contextual-retrieval)

Prepend 50–100 token context to each trade chunk before embedding. Without this, "Entry at 43250, PnL +2.1%" has no context. With it:

```
BEFORE: "Entry at 43250, SL at 42800, exit at 44100, PnL +2.1%"
AFTER:  "[BTC 4H OB Long | BULL regime ADX=31 | London session | Spring confirmed]
         Entry at 43250, SL at 42800, exit at 44100, PnL +2.1%"
```

Measured improvement: Contextual Embeddings + BM25 Hybrid → **49% fewer retrieval failures**.

**2. FinMem Layered Memory** (https://arxiv.org/abs/2311.13743)

Three-tier hierarchy with decay scoring:
```
score = α·novelty + β·relevance + γ·importance
novelty    = exp(-λ · time_gap)    ← recency-weighted decay
relevance  = embedding_similarity  ← semantic match
importance = LLM-assigned at store ← trade significance
```

---

## Phase 6A: Layered Memory Architecture

### 6A-1. Memory Types

```typescript
// src/memory/types.ts

type MemoryLayer = 'working' | 'episodic' | 'semantic'

type MemoryType =
  | 'trade_outcome'       // Closed trade with full context
  | 'pattern_insight'     // "OBs fail in SIDEWAYS regime — 38% win rate"
  | 'config_decision'     // "Raised CONFLUENCE_MIN to 4 on 2026-03-28"
  | 'anomaly_event'       // "Circuit breaker: 3 consecutive losses, London open"
  | 'regime_transition'   // "BTC BULL→SIDEWAYS at 2026-03-15T08:00Z"
  | 'performance_summary' // "Week Mar 24: BTC 71% win, ETH 43% win"
  | 'advisor_suggestion'  // "Backtest: raise ADX threshold to 28"

interface Memory {
  id: string
  type: MemoryType
  layer: MemoryLayer
  content: string                     // Human-readable, contextual summary
  data: Record<string, unknown>       // Structured payload
  context: TradeContext               // Market context at storage time

  // FinMem scoring
  importance: number                  // 0–1, LLM-assigned at store time
  accessCount: number                 // auto-increments on retrieval
  storedAt: Date
  lastAccessedAt: Date
}

interface TradeContext {
  coin: string
  timeframe: string
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'
  atr: number           // normalized ATR
  adx: number
  session: 'asian' | 'london' | 'ny' | 'overlap'
  timestamp: Date
}
```

---

### 6A-2. Memory Store

```typescript
// src/memory/store.ts

class MemoryStore {
  // Working: in-process Map (zero latency, 24h TTL)
  private working: Map<string, Memory> = new Map()

  // Episodic + Semantic: PostgreSQL with TimescaleDB

  async store(memory: NewMemory): Promise<string>

  // FinMem scoring for retrieval ranking
  score(memory: Memory, relevance: number): number {
    const timeGapDays = (Date.now() - memory.lastAccessedAt.getTime()) / 86_400_000
    const novelty = Math.exp(-MEMORY_CONFIG.DECAY_LAMBDA * timeGapDays)
    return MEMORY_CONFIG.WEIGHTS.novelty    * novelty
         + MEMORY_CONFIG.WEIGHTS.relevance  * relevance
         + MEMORY_CONFIG.WEIGHTS.importance * memory.importance
  }

  // Promotion: episodic accessed 3+ times → semantic
  async maybePromote(memory: Memory): Promise<void>

  // Expiry: episodic older than 30 days with accessCount < 2 → archive
  async runDecay(): Promise<void>
}
```

---

### 6A-3. Database Schema

```sql
-- src/db/migrations/006_memory_layer.sql

-- Main memories table (episodic + semantic)
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'episodic',
  content TEXT NOT NULL,
  data JSONB NOT NULL,
  context JSONB NOT NULL,
  importance DOUBLE PRECISION DEFAULT 0.5,
  access_count INT DEFAULT 0,
  stored_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Full-text search (BM25 approximation via PostgreSQL FTS)
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      content || ' ' ||
      COALESCE(data->>'coin', '') || ' ' ||
      COALESCE(data->>'pattern_type', '') || ' ' ||
      type
    )
  ) STORED
);

-- pgvector for semantic similarity
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memories ADD COLUMN embedding vector(1024);  -- Voyage Finance-2 dim

-- Indexes
CREATE INDEX mem_layer_idx ON memories (layer, stored_at DESC);
CREATE INDEX mem_type_idx ON memories (type);
CREATE INDEX mem_fts_idx ON memories USING GIN (search_vector);
CREATE INDEX mem_vec_idx ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- TimescaleDB hypertable for episodic layer time-series queries
SELECT create_hypertable('memories', 'stored_at', if_not_exists => true);

-- Retention: auto-archive episodic memories older than 90 days
SELECT add_retention_policy('memories', INTERVAL '90 days');
```

---

## Phase 6B: Contextual Trade Preprocessor

Implements Anthropic Contextual Retrieval technique.

```typescript
// src/memory/contextual-preprocessor.ts

class ContextualPreprocessor {
  // Step 1: Generate 50–100 token context prefix per trade chunk
  // Uses Claude Haiku with prompt caching (cheap, fast)
  async generateContext(
    trade: ClosedTrade,
    recentTrades: ClosedTrade[]   // last 3 for temporal context
  ): Promise<string> {
    // Cached system prompt (no cost on repeat calls):
    // "Generate a 1-2 sentence context prefix for this trade.
    //  Include: coin, timeframe, regime, session, setup type,
    //  and any notable recent market behavior. Under 100 tokens."
    //
    // Example output:
    // "[BTC 4H OB Long | BULL regime ADX=31 | London session |
    //  Spring confirmed 2 bars prior | Prev 3 trades same setup: 2W 1L]"
  }

  // Step 2: Prepend context + store with embedding
  async processAndStore(trade: ClosedTrade): Promise<string> {
    const context = await this.generateContext(trade, getRecent(3))
    const contextualContent = `${context}\n${serializeTrade(trade)}`

    const embedding = await this.embed(contextualContent)
    const importance = this.scoreImportance(trade)

    return memoryStore.store({
      type: 'trade_outcome',
      layer: 'episodic',
      content: contextualContent,
      data: trade,
      context: extractContext(trade),
      importance,
      // embedding stored async — does not block agent
    })
  }

  // Importance scoring (no LLM — rule-based for cost)
  private scoreImportance(trade: ClosedTrade): number {
    let score = 0.3  // baseline
    if (Math.abs(trade.pnlR) > 2.5)           score += 0.2  // large PnL
    if (trade.pnl < 0 && trade.grade === 'A') score += 0.3  // A-grade loss
    if (trade.exitReason === 'circuit_breaker') score += 0.2  // risk event
    return Math.min(score, 1.0)
  }
}
```

---

## Phase 6C: Hybrid Retrieval Engine (Dense + Sparse + RRF)

```typescript
// src/memory/retrieval-engine.ts

class RetrievalEngine {
  // Dense: pgvector cosine similarity
  async denseSearch(query: string, topK = 75): Promise<RankedMemory[]> {
    const embedding = await embed(query)
    const rows = await db.query(`
      SELECT id, content, data, context, importance, access_count,
             1 - (embedding <=> $1::vector) AS score
      FROM memories
      WHERE layer IN ('episodic', 'semantic') AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [embedding, topK])
    return rows.map((r, i) => ({ ...r, rank: i + 1 }))
  }

  // Sparse: PostgreSQL FTS (BM25 approximation)
  async sparseSearch(query: string, topK = 75): Promise<RankedMemory[]> {
    const rows = await db.query(`
      SELECT id, content, data, context, importance, access_count,
             ts_rank(search_vector, plainto_tsquery('english', $1)) AS score
      FROM memories
      WHERE layer IN ('episodic', 'semantic')
        AND search_vector @@ plainto_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT $2
    `, [query, topK])
    return rows.map((r, i) => ({ ...r, rank: i + 1 }))
  }

  // RRF: merge ranked lists without score calibration
  reciprocalRankFusion(lists: RankedMemory[][], k = 60): RankedMemory[] {
    const scores = new Map<string, number>()
    const docs   = new Map<string, RankedMemory>()
    for (const list of lists) {
      for (const doc of list) {
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + 1 / (k + doc.rank))
        docs.set(doc.id, doc)
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => docs.get(id)!)
  }

  // FinMem re-scoring: apply novelty + importance on top of RRF
  rescore(candidates: RankedMemory[], query: string): RankedMemory[] {
    return candidates
      .map(m => ({ ...m, finalScore: memoryStore.score(m, m.score) }))
      .sort((a, b) => b.finalScore - a.finalScore)
  }

  // Full pipeline: dense + sparse → RRF → rescore → top-K
  async retrieve(query: string, topK = 10): Promise<RankedMemory[]> {
    const [dense, sparse] = await Promise.all([
      this.denseSearch(query),
      this.sparseSearch(query),
    ])
    const fused   = this.reciprocalRankFusion([dense, sparse])
    const rescored = this.rescore(fused.slice(0, 30), query)
    return rescored.slice(0, topK)
  }
}
```

---

## Phase 6D: Upgrade JournalAnalyzer to use RAG

Replace Sprint 5's naive full-journal dump with retrieval-augmented context.

```typescript
// src/advisor/journal-analyzer.ts — Sprint 6 upgrade

class JournalAnalyzer {
  async dailyReview(): Promise<JournalAnalysis> {
    // Sprint 5 (naive):   query last 24h trades → dump all to Claude
    // Sprint 6 (RAG):     query last 24h trades → for each trade, retrieve
    //                     top-5 similar historical trades → augmented context

    const recentTrades = await getRecentTrades(24)

    // Build analysis query from today's patterns
    const analysisQuery = buildAnalysisQuery(recentTrades)
    // e.g. "recent OB long losses in SIDEWAYS regime, London session"

    // Retrieve relevant historical memories
    const relevant = await retrieval.retrieve(analysisQuery, 10)

    // Claude now has: today's trades + historical context
    return claude.analyze({
      recentTrades,
      historicalContext: relevant.map(m => m.content),
      currentConfig: getRelevantConfig(),
    })
  }
}
```

---

## Phase 6E: Memory Health Dashboard Widget

Small addition to the Sprint 3 Dashboard overview page.

```typescript
interface MemoryHealth {
  working:  number   // active memories in working layer
  episodic: number   // memories in episodic (last 30 days)
  semantic: number   // durable facts in semantic layer
  coverageScore: number      // % of pattern types with ≥ 5 memories
  retrievalLatencyP99: number  // ms
}
```

Dashboard display:
```
Memory Health [B]
  Working: 12 | Episodic: 847 | Semantic: 34
  Coverage: 72% | Retrieval P99: 45ms
```

---

## Sprint 6 Priority Order

```
Phase 6A: Memory Foundation           (3 sessions)
  1. Memory types + MemoryStore + DB schema (+ pgvector extension)
  2. Embedding service (Voyage Finance-2 or OpenAI ada-002)
  3. Working memory integration with live agent (on trade close)

Phase 6B: Contextual Preprocessor     (2 sessions)
  4. Context generation (Haiku + caching) + processAndStore()
  5. Importance scoring + async embedding pipeline

Phase 6C: Hybrid Retrieval            (2 sessions)
  6. Dense + sparse search + RRF fusion
  7. FinMem rescoring + end-to-end retrieval tests

Phase 6D: JournalAnalyzer Upgrade     (1 session)
  8. Replace naive dump with retrieve() → augmented context

Phase 6E: Memory Health Widget        (1 session)
  9. Health metrics + dashboard overview widget
```

---

## Session Roadmap

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S1 | Memory types + MemoryStore + DB schema + pgvector | 35–45 min | Sprint 3 PostgreSQL |
| S2 | Embedding service (Voyage/OpenAI) + async pipeline | 30–40 min | S1 |
| S3 | Working memory: wire to agent trade close event | 25–35 min | S1, Sprint 2 agent |
| S4 | ContextualPreprocessor: context gen + processAndStore | 35–45 min | S2 |
| S5 | Importance scoring + retry on embed failure | 20–30 min | S4 |
| S6 | RetrievalEngine: dense + sparse + RRF fusion | 35–45 min | S2 |
| S7 | FinMem rescoring + retrieval integration tests | 25–35 min | S6 |
| S8 | JournalAnalyzer upgrade: naive → RAG-augmented | 30–40 min | S6, Sprint 5 analyzer |
| S9 | Memory health widget on dashboard + all tests | 25–35 min | S1, Sprint 3 dashboard |

**Total: 9 sessions, ~5–6 hours**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | NOT STARTED | — | Blocked by Sprint 5 completion |

---

## Infrastructure Changes

**pgvector installation**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- Requires PostgreSQL 14+ with pgvector
-- Docker: use pgvector/pgvector image
```

**Config additions (`src/config.ts`)**:
```typescript
export const MEMORY_CONFIG = {
  WORKING_TTL_HOURS: 24,
  EPISODIC_RETENTION_DAYS: 90,
  DECAY_LAMBDA: 0.1,           // novelty decay rate
  WEIGHTS: { novelty: 0.3, relevance: 0.5, importance: 0.2 },

  DENSE_TOP_K: 75,
  SPARSE_TOP_K: 75,
  RRF_K: 60,
  RETRIEVE_TOP_K: 10,

  PROMOTE_ACCESS_COUNT: 3,     // episodic → semantic threshold

  // Embedding model (switchable without migration)
  EMBEDDING_PROVIDER: 'voyage' as 'voyage' | 'openai',
  EMBEDDING_DIM: 1024,         // Voyage Finance-2 | use 1536 for OpenAI

  // Cost controls
  MAX_EMBED_CALLS_PER_HOUR: 200,
  MAX_CONTEXT_GEN_PER_HOUR: 100,
} as const
```

**Embedding model selection**:

| Model | Dim | Cost/1M tokens | Quality | Recommendation |
|---|---|---|---|---|
| Voyage Finance-2 | 1024 | $0.12 | Best for finance text | **Primary** |
| OpenAI ada-002 | 1536 | $0.10 | Good general | Fallback |
| Nomic-embed-text | 768 | $0 (self-host) | Good | Dev/test only |

---

## Definition of Done

- [ ] pgvector extension installed and vector index warm on startup
- [ ] Memory store: trade close → contextual chunk generated → embedded → stored < 2s
- [ ] Dense search: semantic similarity working, returns ranked results
- [ ] Sparse search: FTS working, returns BM25-ranked results
- [ ] RRF fusion: merged ranking outperforms either alone (measured on test set)
- [ ] FinMem rescoring: novelty decay applied, importance factored
- [ ] JournalAnalyzer: upgraded to retrieve() instead of full journal dump
- [ ] Advisor output quality: retrieving relevant historical context (manual spot-check)
- [ ] Memory health widget visible on dashboard overview
- [ ] Embedding failure: fallback to sparse-only (dense unavailable → system still works)
- [ ] All Sprint 1–5 tests still pass
- [ ] New tests: MemoryStore store/retrieve, RRF fusion correctness, contextual preprocessor, embedding pipeline

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| pgvector cold start (full table scan) | High | IVFFlat index, lists=100. Warm on startup with dummy query. |
| Embedding API down | Medium | Fallback to sparse-only retrieval — system degrades gracefully |
| Memory poisoning (bad data in semantic) | High | Require accessCount ≥ 3 before promoting to semantic |
| Embedding cost runaway | Medium | Cap: 200 calls/hour. Alert if daily spend > $5 |
| Context gen adds latency to trade close | Low | Async, non-blocking. Agent not affected. |
| pgvector not available on current PG | Medium | Check version. Docker: use pgvector/pgvector:pg16 image |

## Upgrade Path to Sprint 7

Sprint 6 ends with: hybrid retrieval working, advisor using RAG context.

Sprint 7 adds on top:
- **Pattern Knowledge Graph** — causal reasoning between memories
- **Multi-Query (RAG-Fusion)** — 5 sub-queries per analysis question
- **HyDE** — find historical trade analogs for active setups
- **Continuous Learning Loop** — auto-extract insights, weekly synthesis
- **Memory Dashboard** — timeline view, graph visualization
