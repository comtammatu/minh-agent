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

### [P2] Debug Drilldown Cascade — Why does 4H→15m→5m fire zero times?

**What:** Add diagnostic logging to count how many 4H POIs are registered (scan4hPOI), how many 15m confirmations happen (scan15mConfirm), and how many 5m entries trigger (scan5mMicroEntry). Identify where the cascade stalls.

**Why:** The drilldown path is designed for 10:1-40:1 R:R entries (4H structure + 15m confirmation + 5m precision). If it can be made to fire, it's higher quality than any 1H same-TF signal. Across 10 coins in the optimizer, it produced exactly zero trades — either the 4H breaks are too rare, the 15m confirmation window is too narrow, or the 5m FVG-only entry requirement is too strict.

**How to start:** Instrument `scan4hPOI`, `scan15mConfirm`, and `scan5mMicroEntry` with counters. Run single-trial optimizer on 10 coins and analyze where the cascade drops to zero.

**Trigger:** After scan1hSameTF 5-fix diagnostic. If 1H holdout PF still < 1.1, promote this to P1.

**Effort:** S (1-2 days instrumentation + analysis)
**Depends on:** scan1hSameTF fix results
**Added by:** Eng Review 2026-04-12 (outside voice recommendation)

### [P3] Investigate Multiplicative Confidence Scoring Model

**What:** Replace additive confidence scoring (16 separate +0.05-0.12 bonuses that stack) with a multiplicative model (each factor is a probability, multiply them) or minimum-required-confluences model (need N of M conditions, not just enough bonuses to pass threshold).

**Why:** The additive model makes it trivially easy to pass MIN_CONFIDENCE by stacking 3-4 small bonuses regardless of signal quality. A BOS entry with weak zone + displacement + directional close + discount already reaches 0.65+. The scoring architecture may be the structural bottleneck preventing meaningful differentiation between good and bad signals.

**How to start:** Analyze confidence distributions of winning vs losing trades from optimizer runs. If both clusters have similar confidence scores, the scoring model isn't discriminating.

**Trigger:** Only pursue after both 1H fixes AND drilldown investigation fail to produce holdout PF > 1.1. This is a strategy architecture change affecting all scan modes.

**Effort:** L (5-7 days design + implementation + full regression)
**Depends on:** Results from P2 items above
**Added by:** Eng Review 2026-04-12 (outside voice recommendation)
