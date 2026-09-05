# Agent And Execution

Money path for Minh. Overview: [ARCHITECTURE.md §4](ARCHITECTURE.md).

## Role

- `TradingAgent` — per-coin state machine + global risk context
- `OrderManager` — cloids, place/cancel/modify, PG order persistence, callbacks
- `PositionMonitor` — exchange sync, trail, partial/full close, thesis-driven closes
- `InvalidationBridge` — pipeline invalidations → agent actions
- `initExecution()` / `getExecution()` — one shared HL | BB | paper service (`src/app/execution.ts`)
- `src/advisor/` — pre-entry verdicts (`allow` / dampen / veto); shadow journals, active enforces; fail-open

## Setup → order

```text
pipeline setup
  → agent.onSetup / dispatch
  → risk + correlation + circuit breakers
  → advisor gate (mode-dependent)
  → place_order action
  → OrderManager → execution service
  → fill → PositionMonitor tracking
  → exits / reconcile / journal
```

Wire `agent.onAction` (and advisor) **before** `subscribeToPipeline` so bootstrap setups are handled.

## Execution modes

| Mode | Behavior |
|---|---|
| `paper` | `PaperExchangeService` — simulated fills, no private exchange orders |
| `live` | Real HL or BB orders; DMS / BB watchdog policies apply |

## Safety invariants

- `queryExchangePositions()` / open-orders null on API error → **skip** reconcile cycle (do not assume flat)
- Cancel failure must not silently mark cancelled (ghost prevention)
- Thesis severe close must submit real reduce-only close and stay tracked until reconcile
- EXITING reserved for agent-initiated closes in flight; completed exchange close notifications → IDLE

## Blast radius

`agent/types`, exchange interfaces, and action/event names affect TUI, journal, and tests together. Keep pure helpers (`evaluatePosition`, reconcile planners) free of I/O.

## Rules

[.claude/rules/exchange-gotchas.md](../.claude/rules/exchange-gotchas.md) · [.claude/rules/quality-gates.md](../.claude/rules/quality-gates.md)
