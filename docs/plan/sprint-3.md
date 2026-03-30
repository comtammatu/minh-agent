# Minh (明) — Sprint 3: Validate + Visualize + Scale + Learn

## Goal

Add a **Backtesting Engine** to validate strategy, **Performance Analytics** to understand what works, and a **Web Dashboard MVP** for visibility. Nothing more.

**Sprint 3 = VALIDATE. Confirm the strategy has positive expectancy before building anything else.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine (pipeline, indicators, structure)
Sprint 2: ACT        🔲 → Agent execution (state machine, orders, risk, safety)
Sprint 3: VALIDATE   🔲 → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     🔲 → Telegram + Dashboard extensions
Sprint 5: ADVISE     🔲 → Basic LLM Advisor (gate: ≥ 100 trades)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning Loop)
```

### Why Sprint 3 is scoped to 3 phases only

```
LLM Advisor → Sprint 5:
  Needs ≥ 100 live trades. Analyzing 20 trades = noise, not signal.
  Needs backtest engine (Sprint 3) for suggestion evaluation.
  Needs validated strategy to be worth optimizing.

Memory/RAG/Graph → Sprint 6–7:
  Requires LLM Advisor as foundation (Sprint 5).
  Requires months of episodic memories to be meaningful.
```

### Core Principle

```
LLM = Advisor, NEVER Executor

Rule-Based Agent (real-time, 2-5ms)     LLM Meta-Layer (async, seconds)
├── Pipeline → Signal                    ├── Read trade journal (100+ trades)
├── State Machine → Decision             ├── Analyze patterns
├── Execute → Order                      ├── Suggest config changes
├── Monitor → Trail/Exit                 ├── Summarize performance
└── DETERMINISTIC                        └── ADVISORY ONLY
                                              ↓
                                         Owner approves → Config updated
```

---

## Architecture Overview

```
Sprint 3 additions:

┌──────────────────────────────────────────────────────┐
│  Agent   │ Backtest  │ Dashboard                      │
│  (S2)    │ Engine    │ (Web UI)                       │
│          │ [3A]      │ [3C]                           │
│ State    │ Historical│ Elysia SSE                     │
│ Machine  │ Replay    │ + React                        │
│ Orders   │ PnL Calc  │ Charts                         │
│ Positions│ Metrics   │ Zones                          │
├──────────┴───────────┴────────────────────────────────┤
│         Performance Analytics [3B] — always-on metrics │
├──────────────────────────────────────────────────────┤
│                 PostgreSQL + TimescaleDB               │
│  candles │ orders │ positions │ journal │ backtest     │
└──────────────────────────────────────────────────────┘
```

### Tech Stack Additions

| Component | Technology | Rationale |
|---|---|---|
| Backtest | Custom (pure TS functions) | Reuse Sprint 1+2 pipeline, no external dep |
| Analytics | TimescaleDB continuous aggregates | Already in DB, zero extra infra |
| Dashboard Frontend | React + Lightweight Charts | SSE from Elysia, real-time updates |

---

## Phase 3A: Backtesting Engine

**Why first**: Validate the strategy has positive expectancy before building everything else on top. If expectancy is negative, fix strategy before proceeding.

**Gate**: If backtest shows expectancy ≤ 0 → STOP Sprint 3, fix Sprint 1/2 pipeline first.

### 3A-1. Historical Replay Engine

```typescript
// src/backtest/engine.ts

interface BacktestConfig {
  coins: string[]
  timeframes: CandleInterval[]
  startDate: Date
  endDate: Date
  initialCapital: number
  agentConfig: typeof CONFIG       // override specific config values for comparison
}

interface BacktestResult {
  metrics: BacktestMetrics
  trades: BacktestTrade[]          // every trade taken
  equityCurve: { ts: Date; equity: number }[]
  drawdownCurve: { ts: Date; drawdown: number }[]
}

interface BacktestMetrics {
  totalTrades: number
  winRate: number
  profitFactor: number             // gross profit / gross loss
  sharpeRatio: number
  sortinoRatio: number             // downside-only volatility
  maxDrawdown: number              // peak-to-trough %
  maxDrawdownDuration: number      // bars
  avgWin: number
  avgLoss: number
  avgRR: number                    // average reward:risk realized
  avgHoldingPeriod: number         // bars
  expectancy: number               // (winRate × avgWin) - (lossRate × avgLoss)
  calmarRatio: number              // annual return / max drawdown
}

class BacktestEngine {
  // Replay candles through Sprint 1+2 pipeline — same code path
  async run(config: BacktestConfig): Promise<BacktestResult>

  // Compare two configs — used by LLM Advisor later (Phase 3E)
  async compare(
    configA: BacktestConfig,
    configB: BacktestConfig
  ): Promise<{ a: BacktestResult; b: BacktestResult; delta: Partial<BacktestMetrics> }>

  // Walk-forward: avoid overfitting to single period
  async walkForward(
    config: BacktestConfig,
    windowSize: number,      // train on N days
    stepSize: number         // step forward M days
  ): Promise<WalkForwardResult>
}
```

**Design constraints**:
- Reuses Sprint 1 pipeline (indicators + layers) — ZERO duplicate logic
- Reuses Sprint 2 agent (state machine + risk) — exact same code path
- Only difference: mock execution (no real orders) + simulated fills
- Candles from PostgreSQL (historical) — no REST calls during backtest
- Slippage model: configurable (default 0.05% for liquid pairs)

---

### 3A-2. Backtest Data Manager

```typescript
// src/backtest/data-manager.ts

class BacktestDataManager {
  // Download historical candles — HL REST max 5000/request, paginate
  async downloadHistory(
    coin: string,
    interval: CandleInterval,
    startDate: Date,
    endDate: Date
  ): Promise<number>  // returns count saved

  // Check completeness, find gaps
  async checkGaps(coin: string, interval: CandleInterval): Promise<Gap[]>
  async fillGaps(coin: string, interval: CandleInterval): Promise<number>
}
```

---

### 3A-3. Backtest Results Storage

```sql
CREATE TABLE backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,                          -- "baseline_v1", "confluence_min_4"
  config JSONB NOT NULL,              -- full config snapshot
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL,             -- BacktestMetrics
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE backtest_trades (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID REFERENCES backtest_runs(id),
  coin TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  size DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  entry_time TIMESTAMPTZ,
  exit_time TIMESTAMPTZ,
  signal_grade TEXT,
  pattern_type TEXT,
  exit_reason TEXT
);

CREATE TABLE backtest_equity (
  run_id UUID REFERENCES backtest_runs(id),
  ts TIMESTAMPTZ NOT NULL,
  equity DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (run_id, ts)
);
SELECT create_hypertable('backtest_equity', 'ts');
```

---

## Phase 3B: Performance Analytics

**Why second**: Understand live performance in real-time. Required by Dashboard (3C) and LLM Advisor (3E).

### 3B-1. Real-Time Metrics Engine

```typescript
// src/analytics/metrics.ts

interface LiveMetrics {
  winRate: { daily: number; weekly: number; monthly: number }
  pnl: { daily: number; weekly: number; monthly: number }
  sharpe: { weekly: number; monthly: number }

  // Per-pattern performance — which setups actually work?
  patternMetrics: Map<string, {
    trades: number
    winRate: number
    avgPnl: number
    bestSetup: string
    worstSetup: string
  }>

  coinMetrics: Map<string, {
    trades: number
    pnl: number
    winRate: number
  }>

  currentDrawdown: number
  maxDrawdown: number
  currentExposure: number
  correlationScore: number
}

class MetricsEngine {
  async updateMetrics(): Promise<LiveMetrics>
  async onTradeClose(trade: ClosedTrade): Promise<void>
}
```

---

### 3B-2. Performance Continuous Aggregates

```sql
-- Daily performance (auto-refreshed by TimescaleDB)
CREATE MATERIALIZED VIEW daily_performance
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', closed_at) AS day,
  coin,
  COUNT(*) AS trades,
  COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
  SUM(realized_pnl) AS total_pnl,
  AVG(realized_pnl) AS avg_pnl,
  MAX(realized_pnl) AS best_trade,
  MIN(realized_pnl) AS worst_trade
FROM positions
WHERE status = 'closed'
GROUP BY day, coin;

SELECT add_continuous_aggregate_policy('daily_performance',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);

-- Pattern performance — which setup type wins?
CREATE MATERIALIZED VIEW pattern_performance
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('7 days', j.ts) AS week,
  j.details->>'pattern_type' AS pattern_type,
  j.details->>'signal_grade' AS signal_grade,
  COUNT(*) AS signals,
  COUNT(*) FILTER (WHERE p.realized_pnl > 0) AS wins,
  AVG(p.realized_pnl) AS avg_pnl
FROM trade_journal j
LEFT JOIN positions p ON p.id::text = j.details->>'position_id'
WHERE j.event_type = 'enter'
GROUP BY week, pattern_type, signal_grade;
```

---

## Phase 3C: Web Dashboard

**Why third**: Visibility. Once analytics is running, expose it. Chart overlay = best debug tool for signal quality.

### 3C-1. Real-Time Data Stream (SSE)

```typescript
// src/server/sse.ts (extend Elysia from Sprint 2)

app.get('/api/stream/status', ({ set }) => {
  set.headers['Content-Type'] = 'text/event-stream'
  set.headers['Cache-Control'] = 'no-cache'
  // Push: agent state, positions, PnL every 5s
})

app.get('/api/stream/signals', ({ set }) => {
  // Push: new signals as they fire
})

app.get('/api/stream/trades', ({ set }) => {
  // Push: order fills, position changes
})
```

---

### 3C-2. Dashboard Pages

```
/                       → Overview: agent state, positions, daily PnL, active signals
/chart/:coin/:tf        → Price chart with zones, structure, setups overlaid
/positions              → Open positions with live PnL, trail stop visualization
/journal                → Trade journal with filters (date, coin, pattern, outcome)
/backtest               → Run backtests, compare results, equity curves
/config                 → View/edit agent config
/advisor                → LLM insights: daily/weekly reviews, suggestions queue [Phase 3E]
/exchanges              → Multi-exchange status: connected, latency, data freshness [Phase 3D]
```

---

### 3C-3. Chart Overlays

```
Chart layers:
├── Candles (OHLCV)
├── Market Structure (HH/HL/LH/LL swing points)
├── Bias arrows (Layer 1 output)
├── Demand/Supply zones (Layer 3, colored by origin: OB/FVG/swing)
├── Entry signals (Layer 5 triggers, with grade badge)
├── Active positions (entry line, SL line, TP line, trail)
├── Regime indicator (background color: green/red/gray)
├── Volume Profile (sidebar)
└── Order flow delta (bottom panel)
```

Tech: Lightweight Charts (`lightweight-charts`) — TradingView open-source, financial-grade.

---

### 3C-4. Frontend Stack

| Component | Choice | Rationale |
|---|---|---|
| Framework | React 19 | Component model, SSE support |
| Build | Vite | Fast, Bun-compatible |
| Charts | Lightweight Charts | TradingView open-source, financial-grade |
| Styling | Tailwind CSS | Utility-first, dark theme |
| State | Zustand | Minimal, SSE-friendly |
| Deployment | Same Bun process (Elysia serves static) | Single deployment unit |

---

## Phase 3D: LLM Advisor Layer (DEFERRED → Sprint 5)

**Why last**: Requires (1) trade journal with 100+ live trades, (2) strategy validated via backtest, (3) backtest engine for evaluating suggestions. All three are built in Phases 3A–3D.

**Prerequisite gate**: Do NOT start 3E until trade journal has ≥ 100 closed trades.

### 3E-1. Trade Journal Analyzer

```typescript
// src/advisor/journal-analyzer.ts

interface JournalAnalysis {
  period: { from: Date; to: Date }
  totalTrades: number
  winRate: number
  avgRR: number
  insights: string[]                    // LLM-generated observations
  suggestions: ConfigSuggestion[]       // actionable config changes
}

interface ConfigSuggestion {
  field: string                          // e.g. "CONFLUENCE_MIN"
  currentValue: number
  suggestedValue: number
  reason: string                         // LLM explanation
  confidence: 'high' | 'medium' | 'low'
  backtestedImprovement?: number         // % improvement from Phase 3A engine
}

class JournalAnalyzer {
  async dailyReview(): Promise<JournalAnalysis>
  async weeklyReview(): Promise<JournalAnalysis>
  async analyzePattern(patternType: string): Promise<JournalAnalysis>
}
```

**LLM Prompt Strategy**:
```
System: You are a trading performance analyst. Analyze structured trade journal
data. Be quantitative. Suggest specific config parameter changes with reasons.

Input: Last 7 days of trade journal (JSON) — timestamp, coin, side, pnl,
signal_grade, pattern_type, regime_at_entry, exit_reason

Output (structured):
  - Win rate by: pattern_type, coin, timeframe, regime
  - Which setups consistently underperform?
  - Specific config suggestions (field + value + reason)
  - Risk observations: sizing, correlation exposure
```

**Guardrails**:
- Suggestions logged, NEVER auto-applied
- Owner reviews via Dashboard `/advisor` page → approves/rejects
- Every suggestion triggers a backtest comparison via Phase 3A engine before display
- Rate limit: max 1 daily review, 1 weekly review (cost control ~$5–15/month)

---

### 3E-2. Anomaly Explainer

```typescript
// src/advisor/anomaly-explainer.ts

class AnomalyExplainer {
  // Called when circuit breaker trips
  async explainCircuitBreak(context: CircuitBreakEvent): Promise<string>
  // → "3 consecutive losses from counter-trend OB entries during regime
  //    transition BULL→SIDEWAYS. Regime detector lagged Wyckoff signal ~4h."

  async explainAnomaly(context: AnomalyEvent): Promise<string>
}
```

---

### 3E-3. Config Auto-Tuner

Depends on Phase 3A Backtest Engine.

```typescript
// src/advisor/config-tuner.ts

class ConfigTuner {
  // 1. LLM suggests: "increase CONFLUENCE_MIN from 3 to 4"
  // 2. Auto-backtest: replay last 30 days, current vs suggested config
  // 3. Compare metrics: win rate, PnL, drawdown, trade count
  // 4. Present diff to owner with data

  async evaluateSuggestion(suggestion: ConfigSuggestion): Promise<TuningResult>
}

interface TuningResult {
  suggestion: ConfigSuggestion
  backtest: {
    current: BacktestMetrics
    proposed: BacktestMetrics
    improvement: number           // % PnL delta
    tradeCountChange: number
  }
  recommendation: 'apply' | 'reject' | 'needs_more_data'
  reason: string
}
```

---

### 3E-4. Telegram Control (Preset Commands — No LLM Parsing)

Simple preset commands cover 90% of use cases at zero API cost. LLM parsing is overkill for a solo operator.

```typescript
// src/advisor/telegram-control.ts

// Preset commands (parsed deterministically, no LLM)
const COMMANDS = {
  '/pause':          () => agent.pause('manual'),
  '/resume':         () => agent.resume(),
  '/status':         () => formatStatusMessage(agent.ctx),
  '/positions':      () => formatPositions(agent.ctx.positions),
  '/pnl':            () => formatPnlSummary(journal),
  '/closeall':       () => agent.closeAll(),           // requires /confirm within 30s
  '/risk 0.5':       (pct) => agent.setRisk(pct),      // temporary override
  '/pause BTC 4h':   (coin, dur) => agent.pauseCoin(coin, dur),
  '/report':         () => journalAnalyzer.dailyReview(), // triggers LLM review
}

// LLM natural language parsing: NOT implemented
// Reason: adds latency, API cost, and error surface for non-critical path
// Revisit if preset commands prove insufficient after 3 months of operation
```

---

## Sprint 3 Priority Order

```
Phase 3A: Backtesting Engine          ← validate strategy first
  1. Historical Replay Engine              reuses Sprint 1+2 pipeline
  2. Backtest Data Manager                 bulk download + gap-fill
  3. Backtest Results Storage              compare runs

  ▶ GATE: expectancy > 0 required to proceed

Phase 3B: Performance Analytics       ← understand live performance
  4. Real-time Metrics Engine              continuous aggregation
  5. Performance Continuous Aggregates     TimescaleDB views

Phase 3C: Web Dashboard MVP           ← visibility, debug tool
  6. SSE data stream                       real-time push
  7. Overview + positions pages            agent state at a glance
  8. Chart page (Lightweight Charts)       visualize zones + signals
  9. Journal + config pages               audit trail + thresholds
  10. Backtest results page               equity curves + metric diff

→ Telegram + Dashboard ext: Sprint 4
→ LLM Advisor:             Sprint 5 (needs ≥ 100 trades)
→ Memory/RAG:              Sprint 6–7
```

---

## Session Roadmap

### Phase 3A: Backtesting (Sessions 1–4)

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S1 | Backtest engine: historical replay via Sprint 1+2 pipeline | 40–50 min | Sprint 2 pipeline |
| S2 | Data manager: bulk download + gap detection | 30–40 min | Sprint 2 PostgreSQL |
| S3 | Results storage + comparison (current vs proposed config) | 25–35 min | S1, S2 |
| S4 | Walk-forward validation + expectancy report | 30–40 min | S1 |

> **After S4**: Review expectancy. If ≤ 0, open new session to fix pipeline. Do not proceed.

### Phase 3B: Analytics (Sessions 5–6)

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S5 | Metrics engine + continuous aggregates SQL | 30–40 min | Sprint 2 PostgreSQL |
| S6 | Integration: metrics → agent loop (update on trade close) | 20–30 min | S5 |

### Phase 3C: Dashboard MVP (Sessions 7–10)

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S7 | Elysia SSE endpoints + React/Vite scaffold | 35–45 min | Sprint 2 Elysia |
| S8 | Overview + positions pages | 30–40 min | S7, S5 |
| S9 | Chart page (Lightweight Charts + zone/structure overlays) | 40–50 min | S7 |
| S10 | Journal + config + backtest pages | 30–40 min | S7, S3 |

**Total: 10 sessions, ~6–7 hours**

→ Telegram + Dashboard ext → **Sprint 4**
→ LLM Advisor (basic) → **Sprint 5** (gate: ≥ 100 trades)
→ Memory / RAG / Graph → **Sprint 6–7**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | NOT STARTED | — | Blocked by Sprint 2 completion |

---

## Definition of Done

Sprint 3 is complete when:

**Phase 3A — Backtest**
- [ ] Replay 6 months of BTC history through Sprint 1+2 pipeline
- [ ] Expectancy, Sharpe, max drawdown computed correctly
- [ ] Walk-forward result shows no significant out-of-sample degradation
- [ ] Compare two configs (e.g. confluence_min 3 vs 4) → clear metric delta

**Phase 3B — Analytics**
- [ ] Daily/weekly/monthly metrics auto-computed via TimescaleDB continuous aggregates
- [ ] Per-pattern win rate breakdown available via API
- [ ] Metrics update within 5s of trade close

**Phase 3C — Dashboard**
- [ ] Real-time overview page updates via SSE
- [ ] Chart renders candles with zones, structure, and signals overlaid
- [ ] Journal page filterable by coin, pattern, grade, outcome
- [ ] Backtest page: run and compare results in-browser

**Always**
- [ ] All Sprint 1 + Sprint 2 tests still pass
- [ ] New tests for backtest engine, analytics, dashboard API
- [ ] Agent continues autonomous operation during Sprint 3 deployment

---

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Expectancy ≤ 0 on backtest | **Critical** | Fix pipeline before proceeding. Hard gate after S4. |
| Look-ahead bias in backtest | High | Strict candle replay: only candles up to current bar visible |
| Overfitting to backtest period | High | Walk-forward validation required. Min 3 out-of-sample periods |
| Backtest vs live divergence | Medium | Track live vs backtest metrics. Alert if delta > 20% |
| Dashboard scope creep | High | MVP only: overview + chart + journal + config. Extras = Sprint 4 |
