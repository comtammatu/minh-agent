# TODOS

Active backlog only. Historical review notes and superseded plans live in [docs/archive/plan/decisions.md](docs/archive/plan/decisions.md).
Priority: P1 (do next), P2 (soon), P3 (someday).

Current implementation source of truth:

- `README.md`
- `SETUP.md`
- `docs/CODEBASE_MAP.md`
- `docs/runtime-and-feed.md`
- `docs/strategy-engine.md`
- `docs/agent-and-execution.md`

Planning note:

- `docs/archive/plan/` contains historical sprint plans and roadmap drafts.
- Do not treat sprint `[DONE]` markers as proof that `src/advisor/` or `src/memory/` exist on the current branch. (`src/server/` and `dashboard/` are now implemented.)

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

**Status:** DIAGNOSED 2026-04-12. Root cause: 5m FVG-only entry requirement (8,703 kills), CHoCH gate (1,293 kills), short TTL (907 expirations). See `docs/archive/plan/decisions.md` "Drilldown Cascade Diagnostic Results".

**Diagnostic tool:** `src/backtest/run-drilldown-diag.ts`

### [DONE] Fix Drilldown 5m Entry Bottleneck — F1-F4 applied 2026-04-12

**Status:** F1-F4 applied. 5m signals 27→49 (+81%). See `docs/archive/plan/decisions.md` "Drilldown 5m Entry Fixes Applied".

### [P1] Fix Simulator Slot Contention — Enable drilldown trades in optimizer

**What:** The optimizer simulator rejects 5m micro-entry when the same coin already has an open `1h_same_tf` position. `simulator.tryFill()` enforces one-position-per-coin. Either (A) run optimizer with `1h_same_tf` disabled to validate 5m signal quality in isolation, or (B) add priority routing so drilldown mode can coexist with or override the 1h position for the same coin.

**Why:** F1-F4 raised 5m signals to 49 but drilldown trades remain 0 in all optimizer runs. Root cause confirmed: `1h_same_tf` fills coin slot first → 5m micro-entry rejected by simulator. Drilldown R:R (10:1-40:1) is the highest-value path.

**How to start:**
- Option A (fastest): add `--mode 5m-only` flag to optimizer run script that disables `scan1hSameTF`. Run 10-coin optimizer. If holdout PF ≥ 1.1 with ≥ 40 trades → 5m standalone has alpha.
- Option B: modify `TradeSimulator.tryFill()` to allow drilldown entries to coexist or supersede same-coin 1h positions.

**Effort:** S (1-2 sessions)
**Depends on:** F1-F4 done (CONFIRMED), Drilldown diagnostic (DONE)
**Added by:** Slot contention analysis 2026-04-12

### [P3] Investigate Multiplicative Confidence Scoring Model

**What:** Replace additive confidence scoring (16 separate +0.05-0.12 bonuses that stack) with a multiplicative model (each factor is a probability, multiply them) or minimum-required-confluences model (need N of M conditions, not just enough bonuses to pass threshold).

**Why:** The additive model makes it trivially easy to pass MIN_CONFIDENCE by stacking 3-4 small bonuses regardless of signal quality. A BOS entry with weak zone + displacement + directional close + discount already reaches 0.65+. The scoring architecture may be the structural bottleneck preventing meaningful differentiation between good and bad signals.

**How to start:** Analyze confidence distributions of winning vs losing trades from optimizer runs. If both clusters have similar confidence scores, the scoring model isn't discriminating.

**Trigger:** Only pursue after both 1H fixes AND drilldown investigation fail to produce holdout PF > 1.1. This is a strategy architecture change affecting all scan modes.

**Effort:** L (5-7 days design + implementation + full regression)
**Depends on:** Results from P2 items above
**Added by:** Eng Review 2026-04-12 (outside voice recommendation)
