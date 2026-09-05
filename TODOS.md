# TODOS

Active backlog only — **Minh Greenfield**. History: [docs/archive/](docs/archive/README.md). Features: [docs/FEATURES.md](docs/FEATURES.md). Pipeline: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Priority: **P0** urgent safety · **P1** next · **P2** soon · **P3** someday.

**Active:** Greenfield presence rebuild (Ink TUI + Telegram). Browser dashboard / Bloomberg DESIGN targets are out of scope.

## Advisor

### [P1] Shadow → active promotion gate
- Accumulate `advisor` journal events in shadow; evaluate whether enforced vetoes would have improved PF/expectancy.
- Promote `ADVISOR_MODE=active` only on positive evidence.
- Needs analysis script: journal `advisor` events joined to exits by `setupId`.
- Contract/notes (archived): `docs/archive/plan/task-contract-advisor-learning-loop-2026-06-10.md`

### [P2] Advisor follow-ons
- Backtest validation: inject advisor gate into `src/backtest/engine.ts` + walk-forward before active mode
- Mode-aware stats filter (paper vs live) once both exist in one DB
- Fill-based realized PnL (replace price-estimated `pnlEstimated`)

## Strategy

### [P1] Simulator slot contention — enable drilldown in optimizer
- Simulator one-position-per-coin rejects 5m micro-entry when `1h_same_tf` is open.
- Option A: `--mode 5m-only` for optimizer. Option B: allow drilldown coexist/override in `TradeSimulator.tryFill()`.
- Effort: S. Context in `docs/archive/plan/decisions.md`.

### [P2] AMD standalone — 1H CHoCH without 4H POI gate
- Only if D+E+F 10-coin holdout stays PF &lt; 1.1 with 40+ trades.
- Add `scan1hAMDStandalone` skipping HTF context; run optimizer.

### [P3] Multiplicative confidence scoring
- Replace additive confidence stack with multiplicative or min-N-of-M model.
- Only after 1H + drilldown investigations fail to produce holdout PF &gt; 1.1.

## Recently completed (do not re-litigate)

Advisor v1 (shadow), EXITING stranding fix, journal-derived analytics (migration 013), cancel-failure visibility, HL DMS + BB watchdog, order reconciliation, execution-boundary contracts, operator flatten/pause/resume APIs, arch/docs agent-config cleanup. Details under `docs/archive/plan/`.
