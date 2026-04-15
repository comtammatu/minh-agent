# Data, Backtesting, And Ops

The persistence model is deliberately simple: one bounded PostgreSQL pool (`src/db/connection.ts:8`, config-driven `DB_MAX_CONNECTIONS`), ordered SQL migrations with version tracking (`src/db/migrate.ts:14`), and a candle repository that handles both live write-through and bulk backfill (`src/db/candle-repo.ts:17`, `src/db/candle-repo.ts:47`). The runtime restores recent history from PostgreSQL first, then REST-fills gaps before switching into steady-state live writes. That hybrid model keeps the hot path fast while making restart recovery and backtests practical.

## Candle data lifecycle

The candle flow has four phases, each with a distinct persistence contract:

1. **WS subscription starts early** in bootstrap, before backfill, so no live ticks are missed (`src/index.ts:337`).
2. **PG load** restores persisted candles into the in-memory store (`src/index.ts:413`).
3. **REST gap-fill** tops up missing history. Gap-fill logic is pure: `computeGapStart()` and `shouldGapFill()` decide whether partial fill or full backfill is cheaper (`src/db/candle-repo.ts:152`, `src/db/candle-repo.ts:167`).
4. **Live write-through** upserts each candle to PG on the persist callback (`src/db/candle-repo.ts:17`).

The upsert uses `ON CONFLICT (coin, interval, t) DO UPDATE` to handle WS/REST dedup safely (`src/db/candle-repo.ts:28`). Bulk backfill batches in 500-row chunks to avoid oversized SQL (`src/db/candle-repo.ts:57`). Deadlock on concurrent upserts is retried once with jitter (`src/db/candle-repo.ts:34`).

Startup uses `getAllLastTimestamps()` — a single `GROUP BY` query — to compute gap-fill ranges for all coin/interval pairs without N+1 queries (`src/db/candle-repo.ts:131`).

## Backtesting model

Backtesting reuses the production pipeline instead of maintaining a separate detector stack. `runBacktest()` resets shared state (`clearPipelineState`, `clearStore`, `clearOnPersist`, `getStrategyRegistry().clearAllState()`), activates one strategy, replays candles through `onCandleTick()`, and lets the simulator react to emitted setups (`src/backtest/engine.ts:49`, `src/backtest/engine.ts:50`, `src/backtest/engine.ts:52`, `src/backtest/engine.ts:53`, `src/backtest/engine.ts:98`). The `finally` block restores fan-out mode and clears state regardless of outcome (`src/backtest/engine.ts:123`).

The replay sequence interleaves all coin x TF candles chronologically via `buildReplaySequence()`, preserving multi-asset ordering (`src/backtest/engine.ts:145`). The key invariant is zero look-ahead bias: the store only contains candles up to the current replay point because they are fed one by one through `onCandleTick()`.

### Trade simulator

`TradeSimulator` supports two exit modes (`src/backtest/simulator.ts:70`):

- **Multi-exit** (default): TP1 at 40% (zone target), TP2 at 30% (swing target), remaining 30% on ATR trailing stop. SL moves to breakeven after TP1 (`src/backtest/simulator.ts:257`, `src/backtest/simulator.ts:276`, `src/backtest/simulator.ts:289`).
- **Single-exit**: one SL, one TP, 100% close (`src/backtest/simulator.ts:196`).

Position sizing uses the same `computePositionSize()` from the live agent (`src/backtest/simulator.ts:138`). Correlation guard mirrors live behavior with `shouldBlockCorrelatedEntry()` (`src/backtest/simulator.ts:107`). Circuit breaker stops new entries when drawdown exceeds `BACKTEST_CIRCUIT_BREAKER_DD` (`src/backtest/simulator.ts:103`). Max concurrent positions are capped at `BACKTEST_MAX_OPEN_POSITIONS` (`src/backtest/simulator.ts:100`).

Fill happens at next-bar open plus slippage to avoid signal-bar bias (`src/backtest/simulator.ts:90`, `src/backtest/simulator.ts:123`). SL is checked before TP on each bar — conservative by design (`src/backtest/simulator.ts:243`).

### Async variant

`runBacktestAsync()` yields to the event loop every `BACKTEST_CHUNK_SIZE` bars via `setTimeout(0)`, keeping Telegram polling and SSE responsive during long replays (`src/backtest/engine.ts:195`, `src/backtest/engine.ts:246`). Same logic as the sync variant, with progress callbacks.

## Analytics and reporting

Analytics are fed from persisted trade state, not a separate execution path.

- `MetricsRepo` reads closed positions and refreshes three materialized views: `daily_performance`, `pattern_performance`, `pnl_hourly` (`src/analytics/metrics-repo.ts:21`).
- `refreshViews()` tries `REFRESH CONCURRENTLY` first, falls back to plain refresh on first run when matviews are unpopulated (`src/analytics/metrics-repo.ts:214`, `src/analytics/metrics-repo.ts:49`).
- `MetricsService.onTradeClose()` is fire-and-forget: logs errors but never throws, so the agent loop never blocks on analytics (`src/analytics/metrics-service.ts:33`).
- `connectToAgent()` wires the service to `TradingAgent.onTradeClose` at startup (`src/analytics/metrics-service.ts:73`).
- `getLiveMetrics()` runs three parallel DB queries and builds a `LiveMetrics` object for API/TUI consumption, using paper balance or cached exchange value depending on mode (`src/analytics/metrics-service.ts:47`).

Walk-forward validation reports are pure formatters with overfit detection and IS/OOS comparison (`src/backtest/report.ts:22`, `src/backtest/report.ts:43`).

## Operator surfaces

Current operator surfaces tied to this data path:
- Ink TUI (live account stats from `src/ui/live-account-stats.ts`)
- Telegram alerts/commands
- Structured logs

No browser dashboard or SSE pipeline in the active runtime path. Operational debugging assumes terminal + logs + Telegram.

## Failure modes and recovery

**Migrations**: Re-entry safe — applied versions tracked in `schema_migrations`, each new migration runs in a transaction (`src/db/migrate.ts:42`). Risk: slow DDL or heavy view refreshes delaying startup.

**Candle persistence**: Live writes are best-effort. Deadlock on concurrent upserts retries once with 50-150ms jitter (`src/db/candle-repo.ts:34`). If write fails after retry, the error propagates to the caller, which logs and records health degradation rather than crashing. Operators must watch health state, not just process liveness.

**Analytics refresh**: Non-fatal by design. `onTradeClose` catches all errors and logs them (`src/analytics/metrics-service.ts:37`). A metrics refresh failure makes TUI summaries lag behind exchange reality until the next successful refresh.

**Matview bootstrap**: `REFRESH CONCURRENTLY` fails on unpopulated matviews. The repo probes `pg_class.relispopulated` and does a plain refresh first when needed (`src/analytics/metrics-repo.ts:49`). This prevents noisy ERROR logs on first startup.

**Backtest state leakage**: The `finally` block in `runBacktest()` restores registry fan-out, clears pipeline state, and clears the store (`src/backtest/engine.ts:123`). If a caller bypasses `runBacktest()` and calls `onCandleTick()` directly without clearing state, the next live or backtest run inherits contaminated buffers.

## Blast radius and safe change plan

- `src/db/candle-repo.ts` is cross-cutting. Startup, live runtime, analytics, and backtests all depend on its upsert semantics and query contracts. Safe changes must preserve timestamp dedup and the hot-window cap.
- `src/backtest/engine.ts` is part of live-trading correctness. If it stops replaying through `onCandleTick()`, research diverges from production. The state reset sequence (`clearPipelineState` → `clearStore` → `clearOnPersist` → `clearAllState`) must stay complete.
- Migration changes are rollout-sensitive even in a solo-dev environment. A syntactically valid migration can create an unsafe startup path if it blocks or fails mid-apply.
- `config.ts` backtest parameters (`BACKTEST_SLIPPAGE_PCT`, `BACKTEST_COMMISSION_PCT`, `BACKTEST_MAX_OPEN_POSITIONS`, `BACKTEST_CIRCUIT_BREAKER_DD`, `BACKTEST_RISK_PER_TRADE_PCT`) affect research validity. Changes must be paired with benchmark reruns.

## Unknowns

- Unknown: whether all migrations are rollback-safe on production-sized datasets. The code runs them transactionally, but no benchmark or staged mixed-version rollout has been tested. Verification step: run migrations against a cloned production DB and measure lock duration.
- Unknown: whether matview refresh latency is acceptable under high trade volume. Three sequential `REFRESH CONCURRENTLY` calls could contend with live reads. Verification step: measure refresh duration under concurrent TUI/API queries with 1000+ closed positions.
- Unknown: whether the backtest state reset sequence is complete after adding new shared caches or module-level state in the strategy layer. Verification step: add a test that runs two backtests sequentially with different strategies and asserts zero state leakage between them.

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-15
Data: CodeIndex static analysis + direct source reading
Audience: new engineer, oncall, refactor owner | Confidence: 85%
Unknowns: 3 items pending verification
-->
