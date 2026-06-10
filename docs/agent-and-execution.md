# Agent And Execution

The agent layer is a state-machine orchestrator, not a stateless order router. `TradingAgent` now stores one context per coin plus one shared global risk context, and dispatches events through state handlers instead of mutating order state inline. That separation is what allows the pipeline, order manager, and position monitor to exchange events without sharing direct mutable structures.

`OrderManager` is the I/O-heavy execution boundary. It generates idempotent client order IDs, submits entries and triggers through the exchange interface, persists order state in PostgreSQL, and exposes callback hooks back into the agent and position monitor (`src/agent/order-manager.ts:2`, `src/agent/order-manager.ts:15`, `src/agent/order-manager.ts:64`, `src/agent/order-manager.ts:116`, `src/agent/order-manager.ts:159`, `src/agent/order-manager.ts:202`). This is the right place for exchange retries and reconciliation because it keeps the strategy layer pure and the agent layer focused on intent.

`PositionMonitor` owns the reconciliation loop and trailing-stop logic. The pure helpers decide trailing updates, partial closes, and missing-position detection, while `syncWithExchange()` handles account-equity refresh, fill sync, snapshot polling, and action execution (`src/agent/position-monitor.ts:98`, `src/agent/position-monitor.ts:186`, `src/agent/position-monitor.ts:434`, `src/agent/position-monitor.ts:457`, `src/agent/position-monitor.ts:498`, `src/agent/position-monitor.ts:519`). The critical operational safeguard is that `queryExchangePositions()` returns `null` on API failure and the monitor skips reconciliation for that cycle instead of assuming positions vanished (`src/agent/position-monitor.ts:58`, `src/agent/position-monitor.ts:84`, `src/agent/position-monitor.ts:514`).

The exchange boundary is normalized through `IExchangeService` and a single-wallet `ExchangePool`. The pool chooses Bybit or Hyperliquid once at init, caches the active exchange, and returns one shared service instance for the whole process. In `EXECUTION_MODE=paper`, the pool uses `PaperExchangeService`: no private key, no Bybit secret, no exchange order API, and immediate simulated fills at the submitted price. That keeps exchange routing simple, but it also means exposure management lives above the exchange layer and must stay correct in the agent.

## Failure modes and recovery

Duplicate or stuck entries are handled defensively. `TradingAgent.onSetup()` ignores setups when the coin is already entering or has a pending order, which prevents repeated transition spam against DB idempotency guards. `OrderManager` also validates order UUIDs before querying PostgreSQL to avoid noisy error logs from malformed IDs.

Exchange-mode mismatches are treated as real errors. Bybit live mode requires an initialized `ExchangePool`, while Hyperliquid retains a singleton fallback for pre-init scripts and tests (`src/execution/exchange-pool.ts:124`, `src/agent/position-monitor.ts:63`, `src/agent/position-monitor.ts:486`). This is a sensible compromise because Bybit paths appear less compatible with implicit fallback behavior.

The biggest operational risk is partial failure after an entry order exists. The system mitigates that by syncing submitted entry fills before reconciliation, restoring open positions from exchange snapshots at boot, wiring callbacks before pipeline bootstrap so no early actions are dropped, and fail-safe closing the affected position if protective SL/TP placement fails after an entry fill.

## Blast radius and safe change plan

Changes to `agent/types.ts`, `execution/exchange-service.ts`, or the action/event flow inside `TradingAgent` can break state transitions, order persistence, and TUI rendering together (`docs/archive/oracle-data/analysis-summary.md:23`). Safe changes here should preserve event names and payload shapes first, then adjust exchange behavior second.

Do not collapse the distinction between pure decision logic and I/O wrappers. `evaluatePosition()` and `reconcilePositions()` are pure for a reason (`src/agent/position-monitor.ts:92`, `src/agent/position-monitor.ts:181`). Moving network or DB side effects into those helpers would make both backtesting and unit isolation materially worse.

## Unknowns

- Unknown: whether order-state recovery covers every exchange-specific edge case after process crash, especially mixed inline-fill and later-fill paths. Verification step: kill the process during live paper-mode and live exchange-mode entry flows, then inspect recovered positions and triggers after restart.
- Unknown: whether the current single-context portfolio guard remains adequate under heavier concurrent setup bursts. Verification step: stress paper mode with many correlated coins and inspect correlation-guard, order-cap, and exposure behavior.

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: direct source reading + generated import graph
Audience: oncall, feature owner | Confidence: 84%
Unknowns: 2 items pending verification
-->
