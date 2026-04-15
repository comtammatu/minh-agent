# Minh (明) — Sprint 7: REMEMBER II — Memory Intelligence

> Roadmap note (2026-04-15): this sprint remains a forward-looking design doc. The current branch does not contain the `src/memory/`, `src/advisor/`, or memory-dashboard modules referenced below.

## Goal

Complete the memory system with **causal reasoning** (Pattern Knowledge Graph), **multi-angle retrieval** (RAG-Fusion + HyDE), and a **continuous learning loop** that auto-extracts insights and promotes durable facts over time. The advisor becomes genuinely smarter with every trade.

**Sprint 7 = REMEMBER II. Intelligence on top of the Sprint 6 memory foundation.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine
Sprint 2: ACT        ✅ → Agent execution
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     ✅ → Telegram + Dashboard extensions
Sprint 5: ADVISE     ✅ → Basic LLM Advisor (stateless)
Sprint 6: REMEMBER I ✅ → Memory foundation (Layered memory + RAG retrieval)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning Loop)
```

### What Sprint 6 gives us, what Sprint 7 adds

```
Sprint 6 (foundation):
  ✓ Memories stored with context + embeddings
  ✓ Hybrid retrieval: dense + sparse + RRF
  ✓ JournalAnalyzer uses top-10 retrieved memories
  ✓ FinMem scoring: novelty + relevance + importance

Sprint 7 (intelligence):
  + Pattern Knowledge Graph: WHY did this happen? (causal chains)
  + RAG-Fusion: 5 sub-queries per question → richer coverage
  + HyDE: "show me historical trades similar to this current setup"
  + Continuous Learning: auto-extract insights every 10 trades
  + Weekly synthesis: episodic memories → durable semantic facts
  + Memory Dashboard: timeline view, graph visualization
```

---

## Phase 7A: Pattern Knowledge Graph

**Why**: Retrieval finds similar past situations. The graph answers *why* things happened — causal chains, contradictions, confirmations.

### 7A-1. Graph Engine

```typescript
// src/memory/pattern-graph.ts

type RelationshipType =
  | 'CAUSED_BY'        // "OB loss ← CAUSED_BY ← SIDEWAYS regime"
  | 'CONFIRMED_BY'     // "OB win ← CONFIRMED_BY ← Spring 2 bars prior"
  | 'CONTRADICTS'      // "New data contradicts old pattern insight"
  | 'LEADS_TO'         // "Wyckoff Accumulation → LEADS_TO → Spring"
  | 'SIMILAR_TO'       // "This trade is similar to Dec-15 trade"
  | 'PREVENTS'         // "High ADX filter PREVENTS false breakout entry"
  | 'FOLLOWS_FROM'     // "Trail stop FOLLOWS_FROM initial SL placement"
  | 'PRECEDES'         // "Volume spike PRECEDES regime transition"

interface MemoryRelationship {
  sourceId: string
  targetId: string
  type: RelationshipType
  strength: number      // 0–1
  createdAt: Date
}

class PatternGraph {
  async relate(
    sourceId: string,
    targetId: string,
    type: RelationshipType,
    strength: number = 0.5
  ): Promise<void>

  // Spreading activation: traverse from a node, follow edges
  // depth 1 = full strength, depth 2 = ×0.7, depth 3 = ×0.49
  async spreadingActivation(
    startId: string,
    maxDepth = 3,
    decayFactor = 0.7
  ): Promise<ActivatedNode[]>

  // Root cause analysis: follow CAUSED_BY edges backwards
  async findCauses(memoryId: string, depth = 3): Promise<CausalChain[]>
  // "OB loss ← CAUSED_BY ← SIDEWAYS_REGIME ← INDICATED_BY ← ADX < 20"

  // Community detection: find strongly connected pattern clusters
  async detectCommunities(): Promise<PatternCommunity[]>
  // Used for: "What cluster of patterns is underperforming?"
}
```

---

### 7A-2. Auto-Relationship Detection (On Trade Close)

```typescript
// src/memory/auto-relate.ts

// Called after ContextualPreprocessor.processAndStore()
async function autoRelateOnClose(tradeMemId: string, trade: ClosedTrade): Promise<void> {

  // 1. SIMILAR_TO: find past trades with similar context
  const similar = await retrieval.retrieve(
    `${trade.coin} ${trade.patternType} ${trade.regime} ${trade.side}`, 5
  )
  for (const s of similar) {
    await graph.relate(tradeMemId, s.id, 'SIMILAR_TO', s.score)
  }

  // 2. CAUSED_BY / CONFIRMED_BY: link to regime memory
  const regimeMem = await findRecentRegimeMemory(trade.coin, trade.entryTime)
  if (regimeMem) {
    const type = trade.pnl < 0 ? 'CAUSED_BY' : 'CONFIRMED_BY'
    await graph.relate(tradeMemId, regimeMem.id, type, 0.7)
  }

  // 3. CONTRADICTS: does outcome contradict existing semantic pattern fact?
  const patternFact = await findSemanticFact(trade.patternType, trade.regime)
  if (patternFact && contradicts(trade, patternFact)) {
    await graph.relate(tradeMemId, patternFact.id, 'CONTRADICTS', 0.9)
    // Flag for LLM review: emerging contradiction in semantic layer
  }
}
```

---

### 7A-3. Database Schema (Graph Edges)

```sql
-- src/db/migrations/007_memory_graph.sql

CREATE TABLE memory_relationships (
  id BIGSERIAL PRIMARY KEY,
  source_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  strength DOUBLE PRECISION DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_id, target_id, relationship_type)
);

CREATE INDEX mem_rel_source_idx ON memory_relationships (source_id);
CREATE INDEX mem_rel_target_idx ON memory_relationships (target_id);
CREATE INDEX mem_rel_type_idx   ON memory_relationships (relationship_type);
```

---

## Phase 7B: Multi-Query Advisor (RAG-Fusion)

**Why**: One question → one retrieval → one perspective. Five sub-queries → five retrievals → RRF merge → much broader coverage.

```typescript
// src/advisor/rag-advisor.ts

class RAGAdvisor {
  // Generate N specific retrieval queries from one analysis question
  private async generateSubQueries(question: string, n = 5): Promise<string[]> {
    // Claude Haiku (cached system prompt):
    // "Generate {n} specific retrieval queries that together cover all
    //  aspects of this trading analysis question. Each query should target
    //  a different angle: patterns, regime, coin, time-of-day, exit reason."
    //
    // Example:
    // Q: "Why did win rate drop this week?"
    // →  Q1: "Which patterns had worst performance last 7 days?"
    //    Q2: "What was the dominant regime last week?"
    //    Q3: "Which coins had highest loss rate recently?"
    //    Q4: "What exit reasons dominated losing trades?"
    //    Q5: "Did confluence score correlate with outcome this week?"
  }

  // Full RAG-Fusion pipeline
  async analyze(question: string): Promise<AdvisorResponse> {
    // 1. Generate 5 sub-queries
    const subQueries = await this.generateSubQueries(question)

    // 2. Retrieve for each sub-query in parallel
    const results = await Promise.all(
      subQueries.map(q => retrieval.retrieve(q, 15))
    )

    // 3. RRF merge across all 5 result sets
    const fused = retrieval.reciprocalRankFusion(results)
    const topMemories = fused.slice(0, 15)

    // 4. Pattern graph community summary (global view)
    const communities = await graph.detectCommunities()
    const graphInsights = communities.slice(0, 3).map(c => c.summary)

    // 5. Claude Sonnet synthesis with full context
    return claude.analyze({
      question,
      subQueries,           // show transparency: "I searched for..."
      relevantTrades: topMemories,
      patternInsights: graphInsights,
      workingMemory: memoryStore.getWorking()
    })
  }
}
```

---

## Phase 7C: HyDE Pattern Finder

**Why**: Before entering a trade, find historical analogs — trades with similar conditions that won. Anchors pre-trade decisions to real past outcomes.

```typescript
// src/advisor/hyde-finder.ts

class HyDEPatternFinder {
  // Called when A/A+ setup detected by scanner
  async findAnalogs(setup: ScanResult): Promise<HistoricalAnalog[]> {
    // 1. Generate hypothetical winning trade description (not the question)
    const hypothetical = await claude.haiku(`
      Describe a historically winning trade that matches this setup in 2–3 sentences.
      Include typical hold time, R:R achieved, and key confirming conditions.
      Setup: ${setup.coin} ${setup.timeframe} ${setup.patternType} ${setup.side}
             Regime: ${setup.regime} | ADX: ${setup.adx} | Grade: ${setup.grade}
    `)

    // 2. Embed the HYPOTHETICAL (not the original question)
    const hydeEmbedding = await embed(hypothetical)

    // 3. Search episodic memory using hypothetical embedding
    const analogs = await db.query(`
      SELECT id, content, data,
             1 - (embedding <=> $1::vector) AS similarity
      FROM memories
      WHERE type = 'trade_outcome'
        AND (data->>'side') = $2
        AND (data->>'pnl')::float > 0          -- winning trades only
        AND (data->>'coin') = $3
      ORDER BY embedding <=> $1::vector
      LIMIT 5
    `, [hydeEmbedding, setup.side, setup.coin])

    // 4. Return for SETUP alert log + dashboard display
    return analogs.rows.map(a => ({
      similarity: a.similarity,
      date: a.data.entryTime,
      outcome: `+${a.data.pnlR.toFixed(1)}R in ${a.data.holdBars} bars`,
      summary: a.content,
    }))
  }
}

// Example output in SETUP alert:
// [14:32:05] SETUP | BTC 4H | LONG OB | grade:A (5/7) | conf:0.72
//   Historical analogs: Dec-15 (+2.1R, 8 bars), Mar-02 (+3.4R, 14 bars)
```

---

## Phase 7D: Continuous Learning Loop

**Why**: Agent accumulates wisdom over time. Episodic memories → semantic facts. No manual review needed.

### 7D-1. Incremental Insight Extraction

```typescript
// src/memory/insight-extractor.ts

class InsightExtractor {
  // Called after every 10 trade closes (not every trade — cost control)
  async extractIncremental(): Promise<void> {
    const recent = await getRecentClosedTrades(10)
    const groups = groupBy(recent, t => `${t.patternType}_${t.regime}`)

    for (const [key, trades] of Object.entries(groups)) {
      if (trades.length < 3) continue   // not enough signal

      const winRate = trades.filter(t => t.pnl > 0).length / trades.length
      const existing = await findSemanticFact(key)

      if (!existing) {
        // New pattern insight → straight to semantic layer
        await memoryStore.store({
          type: 'pattern_insight',
          layer: 'semantic',
          content: `${key}: ${(winRate * 100).toFixed(0)}% win rate (${trades.length} trades)`,
          data: { key, winRate, tradeCount: trades.length, avgRR: avgRR(trades) },
          importance: 0.8,
        })
      } else if (Math.abs(existing.data.winRate - winRate) > 0.10) {
        // Significant shift — update + flag contradiction
        await memoryStore.update(existing.id, { winRate, tradeCount: trades.length })
        const newId = await memoryStore.store({ /* updated fact */ })
        await graph.relate(newId, existing.id, 'CONTRADICTS', 0.85)
        // Queued for next LLM review: "emerging contradiction"
      }
    }
  }

  // Called every Sunday: episodic → semantic synthesis
  async weeklyConsolidate(): Promise<void> {
    const weeklyEpisodic = await getEpisodicMemories(7)
    if (weeklyEpisodic.length < 10) return  // not enough data

    const facts = await claude.sonnet(`
      Analyze these ${weeklyEpisodic.length} trade memories from the past week.
      Extract 3–5 durable facts about which patterns work, fail, and why.
      Output JSON: [{ fact: string, confidence: 'high'|'medium'|'low' }]
    `, weeklyEpisodic.map(m => m.content))

    for (const f of facts) {
      await memoryStore.store({
        type: 'causal_fact',
        layer: 'semantic',
        content: f.fact,
        data: { confidence: f.confidence, synthesizedFromN: weeklyEpisodic.length },
        importance: f.confidence === 'high' ? 0.9 : 0.6,
      })
    }
  }
}
```

---

### 7D-2. Regime Transition Memory

```typescript
// src/memory/regime-memory.ts

// Called by scanner when regime changes (BULL → SIDEWAYS etc.)
async function onRegimeChange(
  coin: string,
  from: RegimeType,
  to: RegimeType,
  indicators: RegimeIndicators
): Promise<void> {
  const memId = await memoryStore.store({
    type: 'regime_transition',
    layer: 'episodic',
    content: `${coin}: ${from} → ${to} | ADX ${indicators.adx.toFixed(1)} | ATR ${indicators.atrRatio.toFixed(2)}x`,
    data: { coin, from, to, indicators, timestamp: new Date() },
    importance: 0.7,
    context: { coin, regime: to, adx: indicators.adx, ... }
  })

  // Link open positions to this regime change
  // Creates: position → PRECEDED_BY → regime_change
  // Useful later for "why did this position lose?" root cause analysis
  const openPositions = getOpenPositionsForCoin(coin)
  for (const pos of openPositions) {
    const tradeMem = await findTradeMemory(pos.id)
    if (tradeMem) {
      await graph.relate(tradeMem.id, memId, 'PRECEDES', 0.8)
    }
  }
}
```

---

## Phase 7E: Memory Dashboard

Full memory visibility for the owner.

### 7E-1. New Dashboard Pages

```
/memory                         → Memory Explorer
  ├── Timeline                  → Episodic memories, sorted by time, filterable
  ├── Semantic Facts            → Durable pattern knowledge, confidence badges
  ├── Contradictions            → Active CONTRADICTS edges needing resolution
  └── Search                   → Hybrid search across all memory layers

/advisor/session                → Live Advisor (RAG-Fusion powered)
  ├── Ask a question            → Full RAG-Fusion pipeline, results shown transparently
  ├── Sub-queries generated     → "I searched for: [5 sub-queries displayed]"
  ├── Retrieved context         → Which memories were surfaced and why
  └── Root cause analysis       → Causal chain visualization for any trade
```

### 7E-2. Memory Health Scoring

```typescript
interface MemoryHealth {
  layers: { working: number; episodic: number; semantic: number }
  coverageScore: number          // % of pattern×regime combos with ≥ 5 memories
  graphDensity: number           // avg relationships per node
  contradictionCount: number     // CONTRADICTS edges unresolved
  promotionRate: number          // episodic → semantic per week
  retrievalLatencyP99: number    // ms
  grade: 'A' | 'B' | 'C' | 'D'
  suggestions: string[]          // "Add more ETH data", "Resolve 3 contradictions"
}
```

---

## Sprint 7 Priority Order

```
Phase 7A: Pattern Knowledge Graph     (3 sessions)
  1. PatternGraph: relate() + spreading activation
  2. Auto-relate: wired to agent trade close event
  3. Root cause API + contradiction detection

Phase 7B: RAG-Fusion Advisor          (2 sessions)
  4. RAGAdvisor: sub-query generation + multi-retrieve + RRF merge
  5. Community summary integration + upgrade JournalAnalyzer to use RAG-Fusion

Phase 7C: HyDE Pattern Finder         (2 sessions)
  6. HyDE: hypothetical generation + embedding search
  7. Integration: SETUP alert log + /advisor dashboard display

Phase 7D: Continuous Learning Loop    (3 sessions)
  8. InsightExtractor: incremental (every 10 trades) + weekly synthesis
  9. Regime transition memory → graph linking
  10. Weekly consolidation scheduler (cron via Bun)

Phase 7E: Memory Dashboard            (2 sessions)
  11. Memory explorer page: timeline + semantic facts + contradictions
  12. Live advisor session page + memory health widget
```

---

## Session Roadmap

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S1 | PatternGraph: relate() + spreading activation traversal | 35–45 min | Sprint 6 MemoryStore |
| S2 | Auto-relate: wire to agent trade close + CAUSED_BY / SIMILAR_TO | 30–40 min | S1, Sprint 2 agent |
| S3 | Root cause API + CONTRADICTS detection | 25–35 min | S1, S2 |
| S4 | RAGAdvisor: sub-query gen (Haiku) + 5× parallel retrieve + RRF | 35–45 min | Sprint 6 retrieval |
| S5 | Community summary + upgrade JournalAnalyzer to RAG-Fusion | 25–35 min | S4, Sprint 5 analyzer |
| S6 | HyDE: hypothetical generation + embedding search + analog ranking | 35–45 min | Sprint 6 embed, S4 |
| S7 | HyDE integration: SETUP alert display + /advisor page | 20–30 min | S6, Sprint 3 dashboard |
| S8 | InsightExtractor: incremental insight + contradiction flagging | 35–45 min | S1, S3 |
| S9 | Regime transition memory → graph linking | 25–35 min | S1, Sprint 2 regime |
| S10 | Weekly consolidation: cron scheduler + Sonnet synthesis | 25–35 min | S8 |
| S11 | Memory explorer page: timeline + facts + contradictions UI | 35–45 min | Sprint 3 dashboard |
| S12 | Live advisor session + memory health widget + all integration tests | 35–45 min | S4, S11 |

**Total: 12 sessions, ~7–8 hours**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | NOT STARTED | — | Blocked by Sprint 6 completion |

---

## Definition of Done

**Phase 7A — Graph**
- [ ] relate() stores edge in DB, spreadingActivation() traverses correctly
- [ ] Trade close: auto-relate fires within 5s, SIMILAR_TO / CAUSED_BY / CONFIRMED_BY edges created
- [ ] Root cause chain visible for any losing trade via API
- [ ] CONTRADICTS edges flagged when semantic fact shifts > 10%

**Phase 7B — RAG-Fusion**
- [ ] 5 sub-queries generated for any analysis question
- [ ] All 5 retrieves run in parallel, RRF merges correctly
- [ ] JournalAnalyzer uses RAG-Fusion instead of single-query retrieval
- [ ] Advisor response shows sub-queries + retrieved context (transparency)

**Phase 7C — HyDE**
- [ ] HyDE finds ≥ 3 historical analogs for any A-grade setup with sufficient history
- [ ] Analogs shown in SETUP terminal alert and /advisor dashboard
- [ ] Falls back gracefully when < 5 similar trades exist in memory

**Phase 7D — Learning Loop**
- [ ] InsightExtractor: fires after every 10 trade closes
- [ ] New pattern facts promoted to semantic layer automatically
- [ ] Weekly consolidation runs every Sunday, generates ≥ 2 durable facts
- [ ] Regime transition memory created and linked to open positions on regime change

**Phase 7E — Dashboard**
- [ ] /memory: timeline, semantic facts, contradictions all functional
- [ ] Live advisor session: shows sub-queries + retrieved chunks transparently
- [ ] Memory health grade calculated and visible on overview page

**Always**
- [ ] All Sprint 1–6 tests still pass
- [ ] New tests: graph traversal, RRF correctness, HyDE pipeline, insight extractor, weekly scheduler
- [ ] LLM never touches execution path (agent state machine unchanged)
- [ ] Total Sprint 7 API cost < $10/month estimated

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Memory poisoning (bad semantic facts) | High | Require 3+ confirming trades. Contradiction detection flags anomalies. |
| Context window overflow in RAG-Fusion | Medium | Hard cap: top-15 after RRF. Never send raw episodic bulk. |
| Graph traversal performance | Low | Max depth 3. Index on source/target/type. |
| Contradiction storms (cascade) | Low | Max 3 CONTRADICTS per node. Resolve via weekly LLM synthesis. |
| HyDE hallucination (bad hypothetical) | Medium | Embed hypothetical, search real memories — hallucination in query, not result. |
| Weekly synthesis cost spike | Low | Claude Sonnet, ~2000 tokens/week. Cap at $1/synthesis. |
| Sprint 6 not complete (no memory foundation) | Critical | Hard dependency. Do not start Sprint 7 without Sprint 6 complete. |

## Full System View After Sprint 7

```
Minh (明) — Complete Architecture

Market Data (Hyperliquid)
  → Feed Layer
    → In-memory Store → Scanner Pipeline (Sprint 1)
      → Agent State Machine (Sprint 2)
        → Orders / Positions / Risk / Circuit Breakers (Sprint 2)
          → Trade Journal → PostgreSQL (Sprint 2)

Backtest Engine (Sprint 3) ← validates strategy
Performance Analytics (Sprint 3) ← tracks live metrics
Web Dashboard (Sprint 3–4–7) ← visualization
Telegram Control (Sprint 4) ← owner remote control

Memory Layer (Sprint 6–7):
  Working (24h) → Episodic (30d) → Semantic (∞)
    ↕ Contextual Preprocessor (Sprint 6)
    ↕ Hybrid Retrieval: Dense + Sparse + RRF (Sprint 6)
    ↕ Pattern Knowledge Graph (Sprint 7)

LLM Advisor Layer:
  Sprint 5: Naive → Journal → Claude → Suggestion → Backtest → Owner
  Sprint 6: RAG → Retrieve → Augment → Claude → Better suggestion
  Sprint 7: RAG-Fusion + HyDE + Graph → Claude → Best suggestion
    ↕ Continuous Learning Loop (Sprint 7)
      → Auto-extract insights → Promote to semantic
      → Weekly synthesis → Durable facts

Agent execution: ALWAYS deterministic, 2–5ms/tick
LLM: ALWAYS advisory only, NEVER touches execution
```
