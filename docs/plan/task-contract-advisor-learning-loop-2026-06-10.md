# Task Contract — Advisor + Learning Loop v1

```
===== TASK CONTRACT =====
SESSION: advisor-learning-loop-v1
DATE: 2026-06-10
TASK: Close the learning loop — measurable trade outcomes → bucket stats →
      pre-entry advisor (veto / size-dampen) → periodic insights → surfaces.
      Resolves task-contract-arch-ai-agents-refactor Q2 ("advisor now or defer")
      as: NOW, deterministic-stats v1, no LLM, no new secrets.

OPERATIONAL RISK ASSESSMENT:
  - Risk 1 (runtime failure): advisor blocks the entry hot path or crashes
    dispatch. Mitigation: synchronous reads from a pre-loaded in-memory stats
    cache only; fail-open (no stats / stale stats → pass-through verdict);
    try/catch confined to the cache refresh I/O edge.
  - Risk 2 (solo-dev maintenance): another moving part to babysit. Mitigation:
    pure functions for all math (stats, verdict, insights) with hand-crafted
    tests; one cache class; config thresholds in config.ts; shadow mode default
    so behaviour is observable before it acts.
  - Risk 3 (simpler alternative): could we just read pattern_performance
    matview? No — it lacks regime/side/timeframe dimensions and the outcome
    signal itself is broken (pnl:0 on all close paths, positions table never
    written). Fixing the exit-data path is unavoidable for ANY learning
    approach; trade_memory is the designed store and already has the write
    path + indexes.

SCOPE (files):
  - src/config.ts                      — ADVISOR config block
  - src/advisor/types.ts               — BucketStats, AdvisorVerdict, snapshot types  (new)
  - src/advisor/stats.ts               — pure: bucket keys, aggregation, evaluateSetup (new)
  - src/advisor/cache.ts               — I/O edge: SQL aggregate → in-memory snapshot  (new)
  - src/advisor/insights.ts            — pure insight generation + job runner          (new)
  - src/advisor/index.ts               — public exports                                (new)
  - src/agent/position-monitor.ts      — realized-PnL estimate at close paths
  - src/agent/trading-agent.ts         — exit details: pnlR + regime + patternData keys
  - src/agent/journal.ts               — single trade_outcome per close (dedupe)
  - src/agent/trading-orchestrator.ts  — advisor gate beside portfolio-risk filter
  - src/agent/order-manager.ts         — apply advisorSizeMultiplier in sizing
  - src/runtime/app.ts                 — cache refresh wiring, insight job, pruneMemories schedule
  - src/alert/telegram/commands.ts     — /advisor command
  - src/server/handlers.ts (+contracts)— GET /api/advisor
  - test/advisor/*, existing test files — unit + contract tests

DESIGN DECISIONS (locked):
  - D1 v1 is deterministic stats. No LLM, no embeddings, no new secrets.
  - D2 Source of truth: trade_memory category='trade_outcome' (enriched).
  - D3 Outcome fix in scope: pnl estimate at close (trigger price for SL/TP
    reasons, last mark price otherwise; tagged pnlEstimated), price-based
    pnlR = signed (close−entry)/(entry−sl), regime from setup.patternData.
    Exactly one trade_outcome memory per position close.
  - D4 Advisor can only reduce risk: veto or dampen size. Never boosts size,
    never rescues C-grade setups, never touches confidence in v1.
  - D5 ADVISOR_MODE: 'off' | 'shadow' | 'active'. Default 'shadow' — verdicts
    journaled (event 'advisor', applied:false) but not enforced. 'active'
    enforces veto + size multiplier. Every verdict journaled either way →
    counterfactual data for efficacy measurement.
  - D6 Gate location: TradingAgent.dispatch via a filterByAdvisor step beside
    filterByPortfolioRisk (same veto contract: replace place_order with
    journal action + state revert). Cache injected via agent.setAdvisor().
  - D7 Bucket hierarchy (most specific with n ≥ ADVISOR_MIN_SAMPLE wins):
    pattern|regime|side|interval → pattern|regime|side → pattern|side.
    Laplace-smoothed win rate. Insufficient samples everywhere → allow.
  - D8 Cache refresh: on trade close + every ADVISOR_REFRESH_MS. Insight job
    every ADVISOR_INSIGHT_INTERVAL_MS writes pattern_insight memories
    (deduped per bucket/period); pruneMemories scheduled at same cadence
    (currently never scheduled — known gap).
  - D9 Surfaces: telegram /advisor, GET /api/advisor.
  - D10 Deferred (follow-ups, not this session): backtest advisor-gate
    validation via walk-forward, historical backfill of pnlR/regime,
    embeddings/pattern-graph/RAG (Sprint 6B+/7 archive designs).

CONSTRAINTS:
  - Pure-function boundary: all advisor math zero-I/O, null/pass-through on
    invalid input. I/O only in cache.ts, runtime wiring, surfaces.
  - No magic numbers — all thresholds in src/config.ts ADVISOR block.
  - Hot path stays synchronous; advisor failure → pass-through, never throw.
  - Paper/live identical behaviour; memories tagged with execution mode.
  - TS strict, no `any` without justification comment.

COMPLETION CRITERIA:
  - [ ] Exit journal carries real pnl estimate + pnlR + regime; one
        trade_outcome memory per close (test proves dedupe)
  - [ ] evaluateSetup verdict tests: veto / dampen / allow / cold-start /
        bucket fallback / smoothing
  - [ ] Shadow mode journals verdicts without altering actions (test)
  - [ ] Active mode vetoes + dampens size via order-manager (test)
  - [ ] Insight job writes deduped pattern_insight memories (test)
  - [ ] /advisor + /api/advisor return live snapshot
  - [ ] bun run test:run passes; typecheck passes; lint clean on new code
ESTIMATE: 1 extended session (multi-agent), ~15 files
==========================
```
