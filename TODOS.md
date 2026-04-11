# TODOS

Items deferred from CEO/Eng reviews. Priority: P1 (do next), P2 (soon), P3 (someday).

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
