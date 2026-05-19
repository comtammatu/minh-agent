# TODOS

Active backlog only. Historical review notes and superseded plans live in [docs/archive/plan/decisions.md](docs/archive/plan/decisions.md).
Priority: **P0 (urgent safety), P1 (do next), P2 (soon), P3 (someday)**.

## Execution safety (from /autoplan 2026-05-19 — Phase 3 Eng Review)

See [docs/plan/stack-decision-draft.md](docs/plan/stack-decision-draft.md) for full context.

### [DONE 2026-05-19] Fix cancel-failure-hidden bug — order-manager.ts
- Fixed: if exchange cancel + cloid retry both fail, status now stays `submitted` (was: silently marked `cancelled`).
- Test added: `cancelOrder > preserves status when exchange cancel + cloid retry both fail`.

### [DONE 2026-05-19] Add HL scheduleCancel (dead-man-switch) — exchange method
- Implemented `scheduleCancel(timestampMs?)` on `HLExchangeService` via `@nktkas/hyperliquid` SDK.
- Added optional `scheduleCancel?(timestampMs?)` to `IExchangeService` interface.
- BB returns explicit failure (not no-op); caller relies on `cancelAllOpenOrders()` at shutdown.

### [P0] Wire HL scheduleCancel into runtime — periodic refresh
**What:** Add a periodic timer in `src/runtime/app.ts` that calls `exchangeService.scheduleCancel(Date.now() + DMS_DEADLINE_MS)` every `DMS_REFRESH_MS`. On clean shutdown, call `scheduleCancel(undefined)` to clear.

**Why:** HL natively supports dead-man-switch but it's only useful if armed. CLAUDE.md / `.claude/rules/exchange-gotchas.md` flag it as "Critical for bot safety on crash/disconnect — keep it armed."

**How to start:**
- Add to `src/config.ts`: `DMS_DEADLINE_MS = 6 * 60 * 60 * 1000` (6h) + `DMS_REFRESH_MS = 4 * 60 * 60 * 1000` (4h) → ~6 ops/day, within HL's 10/day cap.
- In `runApp()` after exchange init, start `setInterval` calling scheduleCancel.
- In shutdown handler, clear the schedule.
- Test: assert refresh tick fires; assert clear on shutdown.

**Effort:** S (1 session, security-sensitive)
**Depends on:** Done methods above.

### [P0] BB heartbeat watchdog — process-freeze coverage
**What:** Bybit has no native dead-man-switch. Build an external heartbeat: a child process or systemd watchdog that calls Bybit `cancelAllOpenOrders` if main process stops emitting a heartbeat for >N minutes.

**Why:** BB-only operators currently have ZERO crash protection — `bybit-exchange-service.ts:609` returns failure; shutdown path only runs on clean exit.

**How to start:** Sketch options: (a) sidecar Node process polling main process PID, (b) external uptime monitor calling a /flatten endpoint, (c) systemd watchdog config.

**Effort:** M (1-2 sessions)
**Depends on:** Operator-control contract (next item).

### [P0] Reconciliation pass — surface cancel-failed orders + sync exchange state
**What:** Today the cancel-failure-hidden bug fix prevents corruption but leaves the order ACTIVE on the exchange while marked as something other than `cancelled` in DB. Need a reconciliation loop that: (1) periodically queries exchange for open orders, (2) diffs against DB, (3) re-attempts failed cancels, (4) alerts on persistent drift.

**Why:** Without reconciliation, a single 503 during cancel can leave a ghost order open indefinitely until `checkTimeouts` happens to retry.

**How to start:** Extend `src/agent/position-monitor.ts` or new `src/agent/reconciler.ts`. Compare `getOrders()` (DB) vs `exchange.getOpenOrders()` every N seconds.

**Effort:** M (1-2 sessions)
**Added by:** /autoplan 2026-05-19 (Eng review medium finding)

### [P1] Execution boundary contract test suite
**What:** Comprehensive tests covering HL signing, cloid round-trip, balance reconciliation (perp+spot), SL/TP placement after fill, modify-trigger race.

**Why:** /autoplan 2026-05-19 Eng review flagged execution code as "too sensitive for rebuild churn" — needs contract tests before any DB/UI/strategy work that could regress.

**Effort:** L (1-2 weeks)

### [P1] Operator-control surface contract (`src/server/`)
**What:** `POST /api/operator/flatten` with hold-to-confirm + `POST /api/operator/pause`. Audit log of operator actions. Distinct from `circuit-breakers.ts` which only pauses new entries.

**Why:** /autoplan 2026-05-19 Design review DIM 3 (2/10) — kill-switch journey unspecified. `dashboard-shell.tsx:99` is labelled "Read-only ops console"; emergency path only exists in Telegram.

**Effort:** M (1 session for contract + 1 for dashboard wire-up)

---

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
