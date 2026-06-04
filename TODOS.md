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

### [DONE 2026-05-19] Wire HL scheduleCancel into runtime — periodic refresh
- Added `DMS_DEADLINE_MS` (6h), `DMS_REFRESH_MS` (4h), `isPaperMode()`, `isDmsEnabled()` in `src/config.ts`.
- `PAPER_TRADE` env wired (default `true`). DMS arms only when `ACTIVE_EXCHANGE=HL && PAPER_TRADE=false`.
- `runApp()` arms via `setInterval` after pool init; refresh tick logs on error. Graceful shutdown calls `scheduleCancel(undefined)`.
- Policy tests in `test/runtime/dms-arming.test.ts` lock in cadence ≤10 ops/day and ≥5s HL minimum.

### [DONE 2026-05-19] BB heartbeat watchdog — process-freeze coverage
- Implemented Option A from the design comparison: standalone Bun script (`scripts/bb-watchdog.ts`) polling a heartbeat file (`{pid, ts}`) written every 30s by the main runtime when `ACTIVE_EXCHANGE=BB && PAPER_TRADE=false`.
- Detection logic is pure (`evaluateHeartbeat`) and unit-tested; the loop, file IO, and `cancelAllOpenOrders()` call sit at the edge.
- Stale + dead PID → crash; stale + alive PID → freeze. Both fire the cancel and exit non-zero for supervisor restart. Missing file → intentional shutdown (no-op).
- Graceful shutdown deletes the heartbeat file so the watchdog doesn't fire on operator-driven stops.
- Configurable via `BB_HEARTBEAT_PATH` / `BB_HEARTBEAT_WRITE_MS` / `BB_HEARTBEAT_THRESHOLD_MS` (defaults: `/tmp/minh-heartbeat.json`, 30s, 5min).
- Deploy guide (systemd + pm2 + container) and design rationale in [docs/operations/dead-man-switch.md](docs/operations/dead-man-switch.md).
- Tests: `test/runtime/heartbeat.test.ts` (writer/reader + isPidAlive) and `test/runtime/bb-watchdog.test.ts` (decision matrix + gating + cadence invariants).

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

### [DONE 2026-06-04] Arch + AI Agents Refactor (cursor/refactor-arch-ai-agents-f5ce)
- Doc reality sync (Elysia/SSE/memory lies removed from active; DESIGN tagged current vs target).
- May cleanup S2-S5 complete (script move, biome+knip + baseline/triage, telegram split to <600 files).
- Memory tests (S6c) + test/memory/ added.
- AI Agent System Structure rebuilt: .claude/ now has environment/cursor-cloud.md (exact match to Cloud tools/git/PR/MCP/Task), agents/ as playbooks, .cursor/ optional, protocol/gates/CLAUDE aligned, no fiction.
- Advisor skeleton + minimal journal wire (optional, deferred full).
- All 10 plan todos complete; PR #10; all gates noted (pre-existing type issues + env for PG in tests); reviewer checklist on diff.
- See docs/plan/task-contract-arch-ai-agents-refactor-2026-06-04.md and .claude/README.md .

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
