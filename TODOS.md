# TODOS

Active backlog only. Historical review notes and superseded plans live in [docs/plan/decisions.md](docs/plan/decisions.md).
Priority: P1 (do next), P2 (soon), P3 (someday).

Current implementation source of truth:

- `README.md`
- `SETUP.md`
- `docs/CODEBASE_MAP.md`
- `docs/runtime-and-feed.md`
- `docs/strategy-engine.md`
- `docs/agent-and-execution.md`

Planning note:

- `docs/plan/` contains historical sprint plans and roadmap drafts.
- Do not treat sprint `[DONE]` markers as proof that `src/server/`, `dashboard/`, `src/advisor/`, or `src/memory/` exist on the current branch.

---

## Strategy

### [P2] AMD Standalone — Investigate 1H CHoCH-only entry without 4H POI gate

**What:** Remove 4H POI requirement from the signal pipeline. Test `scan1hSameTF` in isolation: pure 1H BOS/CHoCH + zone proximity, no HTF gate.

**Why:** If D+E+F optimizer run (10 coins, SMC_1H_CONFIDENCE_BASE param) still shows PF~1.0 with 40+ holdout trades, the SMC-SD strategy structure itself has no alpha. The next hypothesis to test is whether the 4H POI gate is the bottleneck (fires rarely, excludes valid setups) or the signal (1H BOS + bounce has no edge regardless of filter).

**How to start:** Add a new scan mode `scan1hAMDStandalone` in `smc-sd/index.ts` that skips HTF context entirely. Run optimizer on this mode with 10 coins.

**Trigger:** Only pursue if D+E+F 10-coin run shows holdout PF < 1.1 with 40+ trades.

**Effort:** M (3-5 days code + 4h optimizer run)
**Depends on:** D+E+F run results
**Added by:** CEO Review 2026-04-11

### [DONE] Debug Drilldown Cascade — Why does 4H→15m→5m fire zero times?

**Status:** DIAGNOSED 2026-04-12. Root cause: 5m FVG-only entry requirement (8,703 kills), CHoCH gate (1,293 kills), short TTL (907 expirations). See `docs/plan/decisions.md` "Drilldown Cascade Diagnostic Results".

**Diagnostic tool:** `src/backtest/run-drilldown-diag.ts`

### [P1] Fix Drilldown 5m Entry Bottleneck — Unblock 4H→15m→5m cascade

**What:** Implement 4 fixes to the 5m micro-entry stage: (F1) allow displacement bounce as FVG fallback, (F2) relax CHoCH-only requirement, (F3) extend confirmed POI TTL to 4h, (F4) extend FVG lookback to 10 bars. Then run optimizer to validate.

**Why:** Diagnostic showed 649K POIs → 11,667 confirmations → 27 signals → 0 trades. 5m entry is the sole bottleneck. Drilldown R:R (10:1-40:1) is the highest-value path in the strategy.

**How to start:** Apply F1-F4 in order (see decisions.md for details), run optimizer after each to measure impact.

**Effort:** S (1-2 sessions)
**Depends on:** Drilldown diagnostic (DONE)
**Added by:** Drilldown diagnostic session 2026-04-12

### [P3] Investigate Multiplicative Confidence Scoring Model

**What:** Replace additive confidence scoring (16 separate +0.05-0.12 bonuses that stack) with a multiplicative model (each factor is a probability, multiply them) or minimum-required-confluences model (need N of M conditions, not just enough bonuses to pass threshold).

**Why:** The additive model makes it trivially easy to pass MIN_CONFIDENCE by stacking 3-4 small bonuses regardless of signal quality. A BOS entry with weak zone + displacement + directional close + discount already reaches 0.65+. The scoring architecture may be the structural bottleneck preventing meaningful differentiation between good and bad signals.

**How to start:** Analyze confidence distributions of winning vs losing trades from optimizer runs. If both clusters have similar confidence scores, the scoring model isn't discriminating.

**Trigger:** Only pursue after both 1H fixes AND drilldown investigation fail to produce holdout PF > 1.1. This is a strategy architecture change affecting all scan modes.

**Effort:** L (5-7 days design + implementation + full regression)
**Depends on:** Results from P2 items above
**Added by:** Eng Review 2026-04-12 (outside voice recommendation)
