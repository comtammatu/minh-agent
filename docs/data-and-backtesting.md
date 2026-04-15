# Data, Backtesting, And Ops

The persistence layer is deliberately simple. `db/connection.ts` creates one bounded `postgres` pool, and `runMigrations()` applies numbered SQL files transactionally while tracking versions in `schema_migrations` (`src/db/connection.ts:7`, `src/db/migrate.ts:14`, `src/db/migrate.ts:42`). That keeps boot deterministic and makes schema drift visible at process start instead of surfacing later through runtime query failures.

`db/candle-repo.ts` is the core storage contract for market data. It supports single-candle write-through upserts for live ticks, chunked bulk upserts for backfill, recent-candle loads, and pure gap-fill decision helpers (`src/db/candle-repo.ts:17`, `src/db/candle-repo.ts:47`, `src/db/candle-repo.ts:105`, `src/db/candle-repo.ts:131`, `src/db/candle-repo.ts:152`, `src/db/candle-repo.ts:167`). This boundary matters because the live runtime can choose between full backfill and gap-fill without pushing SQL awareness back into `feed/` or `strategy/`.

Backtesting intentionally reuses the live pipeline. `runBacktest()` resets shared state, replays historical candles through `onCandleTick()`, listens for emitted setups, and lets the simulator apply fills and exits (`src/backtest/engine.ts:45`, `src/backtest/engine.ts:49`, `src/backtest/engine.ts:69`, `src/backtest/engine.ts:92`, `src/backtest/engine.ts:117`). `runBacktestAsync()` adds event-loop yields to keep SSE and Telegram responsive during long replays instead of cloning the engine into a browser-only path (`src/backtest/engine.ts:195`, `src/backtest/engine.ts:245`).

Analytics and operator surfaces hang off that same lifecycle. `metrics-service.ts` refreshes materialized views after trade close and builds live metrics from DB state plus cached account balance (`src/analytics/metrics-service.ts:33`, `src/analytics/metrics-service.ts:47`, `src/analytics/metrics-service.ts:73`). `HealthMonitor` computes component and memory status from explicit thresholds and logs degraded or critical states without taking autonomous control actions (`src/agent/self-healing.ts:35`, `src/agent/self-healing.ts:53`, `src/agent/self-healing.ts:73`, `src/agent/self-healing.ts:135`). The Telegram bot adds a long-polling operator interface that resolves config from env, sends Bot API calls, and loops on `getUpdates()` with bounded timeout (`src/alert/telegram/bot.ts:85`, `src/alert/telegram/bot.ts:102`, `src/alert/telegram/bot.ts:161`, `src/alert/telegram/bot.ts:1430`).

## Failure modes and recovery

The migration runner is safe under re-entry because it skips already-applied versions and executes each new migration inside a transaction (`src/db/migrate.ts:24`, `src/db/migrate.ts:35`, `src/db/migrate.ts:42`). The unresolved risk is performance or lock duration on large production datasets, not accidental duplicate application.

Analytics are best-effort by design. `onTradeClose()` catches matview refresh errors and logs them without blocking the agent loop (`src/analytics/metrics-service.ts:29`, `src/analytics/metrics-service.ts:37`). That is correct for operational safety, but it means operator views can lag behind trading state during DB incidents.

The operator loop is also best-effort. The Telegram bot tolerates network failure by logging repeated `getUpdates` errors rather than panicking the runtime (`src/alert/telegram/bot.ts:1460`, `src/alert/telegram/bot.ts:1470`). Health monitoring reports degraded states but does not auto-restart or auto-disable the runtime (`src/agent/self-healing.ts:2`, `src/agent/self-healing.ts:140`).

## Blast radius and safe change plan

Changes in `backtest/engine.ts` can silently desynchronize research from production if they stop replaying through `onCandleTick()` or stop resetting shared state (`src/backtest/engine.ts:25`, `src/backtest/engine.ts:49`, `src/backtest/engine.ts:98`). Treat that file as part of the live-trading correctness surface, not just offline tooling.

Changes to DB schemas or candle persistence should be staged conservatively because startup, live write-through, analytics, and replay data loading all depend on the same tables (`src/runtime/app.ts`, `src/db/candle-repo.ts`, `src/analytics/metrics-service.ts`). A migration that is syntactically valid but operationally slow will delay the whole engine.

## Unknowns

- Unknown: whether matview refresh cost remains acceptable at higher trade volume. Verification step: benchmark `refreshViews()` under synthetic close-rate spikes and inspect DB lock times.
- Unknown: whether long-polling Telegram remains responsive during very long compute-heavy backtests in the same process. Verification step: run `runBacktestAsync()` with large replay sets while the bot loop is active and inspect callback latency.

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: direct source reading + generated import graph
Audience: oncall, refactor owner | Confidence: 81%
Unknowns: 2 items pending verification
-->
