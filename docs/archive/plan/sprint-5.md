# Minh (明) — Sprint 5: ADVISE — Basic LLM Advisor

> Roadmap note (2026-04-15): this sprint was never landed on the current branch. There is no `src/advisor/` implementation in the repo today. Treat this file as a future-design draft, not current project status.

## Goal

Build the **Basic LLM Advisor Layer** — a stateless (naive) but useful Claude-powered analysis on top of the trade journal. Daily/weekly review, anomaly explanation, and config suggestions backed by the Sprint 3 backtest engine.

**Sprint 5 = ADVISE. First intelligence layer. Simple, useful, no memory yet.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine
Sprint 2: ACT        ✅ → Agent execution
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     ✅ → Telegram + Dashboard extensions
Sprint 4.5: ISOLATE  ✅ → Multi-Strategy + Agent Wallets
Sprint 5: ADVISE     🔲 → Basic LLM Advisor (gate: ≥ 100 trades)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning)
```

### Hard Prerequisite Gate

```
▶ DO NOT START Sprint 5 until trade journal has ≥ 100 closed trades.

Reason: LLM analysis on < 100 trades = noise, not signal.
  Win rate on 30 trades has ±18% margin of error (95% CI).
  Win rate on 100 trades has ±10% margin of error.
  Win rate on 200 trades has ±7% margin of error.

What to do while waiting:
  → Monitor live agent (Sprint 2)
  → Run backtest comparisons (Sprint 3)
  → Add exchanges (Sprint 4)
  → Collect trade data
```

### What "Basic" means here

Sprint 5 is intentionally **stateless** — each analysis starts from zero context. No memory, no embeddings, no graph. This is the foundation that Sprint 6–7 upgrades.

```
Sprint 5 (Naive):   Journal JSON (per-strategy filtered) → Claude prompt → Analysis output
Sprint 6–7 (Smart): Journal chunks → Context + Embeddings → RAG retrieval → Graph → Claude
```

Build the simple version first. Validate it provides useful signal. Then upgrade.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                LLM Advisor (Sprint 5)                │
│                                                      │
│  JournalAnalyzer                                     │
│    dailyReview()   → PostgreSQL journal query        │
│    weeklyReview()  → last 7 days, filtered           │
│    analyzePattern() → specific setup type            │
│         ↓                                            │
│    Claude Sonnet → structured JSON output            │
│         ↓                                            │
│    ConfigSuggestion → ConfigAutoTuner                │
│         ↓                                            │
│    BacktestEngine (Sprint 3) → TuningResult          │
│         ↓                                            │
│    Owner reviews on /advisor dashboard page          │
│         ↓                                            │
│    Owner approves → config.ts updated manually       │
│                                                      │
│  AnomalyExplainer                                    │
│    onCircuitBreak() → why did this happen?           │
│    onAnomaly()     → unusual market behavior         │
│         ↓                                            │
│    Claude Haiku → plain English explanation          │
│         ↓                                            │
│    Telegram alert + Dashboard /advisor page          │
└─────────────────────────────────────────────────────┘
                 ↕ async, non-blocking
┌─────────────────────────────────────────────────────┐
│  Rule-Based Agent (Sprint 2) — unchanged, no regression │
│  LLM NEVER touches execution path                   │
│  Multi-strategy (Sprint 4.5): queries filter by      │
│  strategy_id — analyze strategies independently      │
└─────────────────────────────────────────────────────┘
```

---

## Phase 5A: Anthropic SDK Setup

```typescript
// src/advisor/client.ts
import Anthropic from '@anthropic-ai/sdk'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Two model tiers — cost control
export const ADVISOR_MODELS = {
  analysis: 'claude-sonnet-4-6',   // weekly review, config suggestions
  explain:  'claude-haiku-4-5-20251001',  // anomaly explain, quick queries
} as const

// Rate limiter (cost protection)
export const RATE_LIMITS = {
  dailyReview:  1,    // max 1 per day
  weeklyReview: 1,    // max 1 per week
  anomalyExplain: 20, // max 20 per day
} as const
```

---

## Phase 5B: Journal Analyzer

```typescript
// src/advisor/journal-analyzer.ts

interface JournalAnalysis {
  period: { from: Date; to: Date }
  totalTrades: number
  winRate: number
  avgRR: number
  profitFactor: number
  insights: string[]              // LLM-generated observations
  suggestions: ConfigSuggestion[] // actionable, each backed by backtest
}

interface ConfigSuggestion {
  field: string                   // e.g. "CONFLUENCE_MIN"
  currentValue: number
  suggestedValue: number
  reason: string                  // LLM explanation
  confidence: 'high' | 'medium' | 'low'
  backtestedImprovement?: number  // % PnL delta from Sprint 3 engine
}

class JournalAnalyzer {
  async dailyReview(): Promise<JournalAnalysis>
  async weeklyReview(): Promise<JournalAnalysis>
  async analyzePattern(patternType: string): Promise<JournalAnalysis>
}
```

**Prompt strategy** (quantitative, not vague):

```
System (cached — cost reduction):
  You are a trading performance analyst for an algorithmic agent.
  Analyze structured trade journal data. Be quantitative.
  Suggest specific config parameter changes with measured reasons.
  Output ONLY valid JSON matching the JournalAnalysis schema.

User input:
  Period: [date range]
  Strategy: [strategy_id — 'layered' | 'quant' | 'all'] (Sprint 4.5)
  Trades: [JSON array — coin, side, pnl, signal_grade, pattern_type,
           regime_at_entry, exit_reason, hold_bars, rr_achieved, strategy_id]
  Current config: [relevant thresholds from config.ts]

Expected output structure:
  - Win rate breakdown: by pattern_type, coin, timeframe, regime, strategy_id
  - Which setups consistently underperform (< 40% win rate)?
  - Specific config suggestions: field + value + reason + confidence
  - Risk observations: position sizing patterns, correlated losses
```

**What to send** (context window management):
- Last 7 days for daily review → typically 20–50 trades
- Last 30 days for weekly review → typically 100–200 trades
- If > 200 trades, summarize oldest 50% before sending (pre-aggregate)

---

## Phase 5C: Config Auto-Tuner

Uses the **Sprint 3 Backtest Engine** to validate every LLM suggestion before showing it to the owner.

```typescript
// src/advisor/config-tuner.ts

class ConfigAutoTuner {
  // For each LLM suggestion:
  //   1. Run Sprint 3 BacktestEngine with current config (baseline)
  //   2. Run Sprint 3 BacktestEngine with suggested config (proposed)
  //   3. Compare metrics
  //   4. Attach result to suggestion before presenting to owner

  async evaluateSuggestion(suggestion: ConfigSuggestion): Promise<TuningResult>
}

interface TuningResult {
  suggestion: ConfigSuggestion
  backtest: {
    current: BacktestMetrics    // from Sprint 3
    proposed: BacktestMetrics   // from Sprint 3 with modified config
    improvement: number         // % PnL delta
    tradeCountChange: number    // more or fewer trades
    maxDrawdownDelta: number    // risk impact
  }
  recommendation: 'apply' | 'reject' | 'needs_more_data'
  reason: string
}
```

**Auto-tuner flow**:
```
LLM suggests: "Increase CONFLUENCE_MIN from 3 to 4"
↓
Backtest baseline:  win 58%, PnL +12.3%, drawdown 8.1%, 142 trades
Backtest proposed:  win 63%, PnL +14.8%, drawdown 6.2%, 98 trades
↓
Recommendation: APPLY
Reason: "Higher confluence filter improves win rate +5%, drawdown -24%,
         at cost of 31% fewer signals. Still 2.8 trades/week average."
↓
Owner sees diff on /advisor dashboard → approves or rejects
→ If approved: owner manually updates config.ts (not auto-applied)
```

**Safety**: LLM suggestions are NEVER auto-applied to live config. Owner always reviews.

---

## Phase 5D: Anomaly Explainer

```typescript
// src/advisor/anomaly-explainer.ts

class AnomalyExplainer {
  // Called when circuit breaker trips
  async explainCircuitBreak(context: CircuitBreakEvent): Promise<string>
  // Output example:
  // "3 consecutive losses occurred between 08:00–10:00 UTC (London open).
  //  All were counter-trend OB entries during a regime transition from BULL
  //  to SIDEWAYS. Wyckoff showed Distribution 4 bars before the losses, but
  //  the regime detector lagged ~3 hours. Consider: (1) increase regime lag
  //  sensitivity, or (2) skip entries during regime uncertainty."

  // Called on unusual market behavior detected by agent
  async explainAnomaly(context: AnomalyEvent): Promise<string>
  // Output example:
  // "BTC volume 4.2x average with <0.3% price movement suggests institutional
  //  accumulation or large stop hunt. VSA shows 'no supply' on next bar.
  //  Historical analog: Mar 15 2024 — preceded 8% move within 48h."
}
```

---

## Phase 5E: Dashboard Advisor Page

Extend Sprint 3 Dashboard with `/advisor` page.

```
/advisor
  ├── Review History
  │     Last 30 days of LLM analyses (daily + weekly)
  │     Sortable: date, win_rate_delta, trade_count
  │
  ├── Active Suggestions (pending owner review)
  │     Card: CONFLUENCE_MIN 3 → 4
  │     Backtest: Win rate +5%, Drawdown -24%, Trades -31%
  │     [Approve] [Reject] [Run more backtest]
  │
  ├── Anomaly Log
  │     Circuit break: 2026-03-28 09:14 — "London session OB losses, regime lag"
  │     Anomaly: 2026-03-25 14:32 — "BTC volume spike 4.2x"
  │
  └── Run Analysis (manual trigger)
          [Daily review] [Weekly review] [Pattern: OrderBlock]
```

---

## Sprint 5 Priority Order

```
Phase 5A: SDK Setup + Rate Limiter    (1 session)
  1. Anthropic client, model config, rate limiting, cost controls

Phase 5B: Journal Analyzer            (3 sessions)
  2. Daily review: query → prompt → parse → store result
  3. Weekly review + pattern-specific analysis
  4. Tests: mock API response, schema validation, rate limit enforcement

Phase 5C: Config Auto-Tuner           (2 sessions)
  5. evaluateSuggestion() → calls Sprint 3 BacktestEngine
  6. TuningResult storage + presentation formatting

Phase 5D: Anomaly Explainer           (1 session)
  7. explainCircuitBreak() + explainAnomaly() + Telegram integration

Phase 5E: Dashboard Advisor Page      (2 sessions)
  8. Advisor page: review history + active suggestions + anomaly log
  9. Manual trigger UI + approve/reject flow
```

---

## Session Roadmap

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S1 | Anthropic SDK client + rate limiter + cost controls | 20–30 min | API key in .env |
| S2 | JournalAnalyzer: daily review pipeline + structured output | 35–45 min | Sprint 2 journal, S1 |
| S3 | JournalAnalyzer: weekly + pattern analysis + tests | 30–40 min | S2 |
| S4 | ConfigAutoTuner: evaluateSuggestion → Sprint 3 backtest | 35–45 min | S2, Sprint 3 engine |
| S5 | TuningResult storage + formatting for dashboard | 25–35 min | S4 |
| S6 | AnomalyExplainer + Telegram integration | 25–35 min | S1, Sprint 2 circuit breaker |
| S7 | Dashboard /advisor page: review history + anomaly log | 30–40 min | S2, Sprint 3 dashboard |
| S8 | Dashboard: active suggestions + approve/reject UI | 30–40 min | S4, S7 |
| S9 | End-to-end integration + review quality of first real output | 30–40 min | All above |

**Total: 9 sessions, ~5–6 hours**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | NOT STARTED | — | Gate: ≥ 100 closed trades required |

---

## Definition of Done

- [ ] Gate confirmed: ≥ 100 closed trades in PostgreSQL before starting
- [ ] Daily review: runs automatically at 00:00 UTC, result stored in DB
- [ ] Weekly review: runs on Sunday, includes pattern breakdown
- [ ] Config suggestion: every suggestion includes backtest comparison (current vs proposed)
- [ ] Anomaly explainer: fires within 60s of circuit breaker trip
- [ ] Rate limits enforced: max 1 daily review, 1 weekly review, 20 anomaly explains per day
- [ ] LLM NEVER places orders, modifies agent state, or auto-applies config changes
- [ ] Dashboard /advisor: shows review history, active suggestions, anomaly log
- [ ] Approve/reject flow: owner can approve → triggers manual config update reminder
- [ ] All Sprint 1–4.5 tests still pass
- [ ] New tests: JournalAnalyzer schema, ConfigAutoTuner diff logic, rate limiter enforcement
- [ ] Cost estimate validated: actual API spend ≤ $20/month at current trade volume

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Gate ignored (< 100 trades) | Medium | Hard check in JournalAnalyzer.dailyReview() — returns early with warning |
| LLM output doesn't match schema | Medium | JSON schema validation + retry once. If fail → log error, skip |
| API cost runaway | Medium | Rate limits per review type. Alert if monthly spend > $30 |
| LLM suggests harmful config | Low | Backtest filter: reject if MaxDrawdown increases > 20% |
| Analysis on stale data | Low | Check journal freshness before analysis — warn if last trade > 3 days |

## Upgrade Path to Sprint 6–7

Sprint 5 is the **naive baseline** that Sprint 6–7 upgrades:

| Sprint 5 (naive) | Sprint 6–7 (smart) |
|---|---|
| Dump full journal JSON into prompt | Contextual RAG: retrieve top-8 relevant chunks |
| Context window: ~50 trades max | Retrieval: all trades searchable, top-k surfaced |
| No memory across sessions | Layered memory: episodic → semantic over time |
| Single query → single answer | RAG-Fusion: 5 sub-queries → merged results |
| No causal reasoning | Pattern graph: root cause traversal |
| Suggestion = LLM guess | Suggestion = LLM + empirical pattern from memory |
