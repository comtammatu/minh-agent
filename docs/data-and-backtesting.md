# Data, Backtesting, And Ops

The persistence layer is deliberately simple. `db/connection.ts` creates one bounded PostgreSQL pool, `runMigrations()` applies ordered SQL files transactionally, and `db/candle-repo.ts` handles both live write-through and bulk backfill. The runtime restores recent history from PostgreSQL first, then REST-fills gaps before switching into steady-state live writes. That hybrid model keeps the hot path fast while making restart recovery and backtests practical.

## Candle data lifecycle

The candle flow has four phases, each with a distinct persistence contract:

1. **WS subscription starts early** in bootstrap, before backfill, so live ticks are not missed
2. **PG load** restores persisted candles into the in-memory store
3. **REST gap-fill** tops up missing history. Gap-fill logic stays pure: `computeGapStart()` and `shouldGapFill()` decide whether partial fill or full backfill is cheaper
4. **Live write-through** upserts each candle to PostgreSQL on the persist callback

The upsert uses `ON CONFLICT (coin, interval, t) DO UPDATE` to handle WS/REST dedup safely. Bulk backfill batches in 500-row chunks to avoid oversized SQL. Deadlock on concurrent upserts is retried once with jitter. Startup also uses `getAllLastTimestamps()` — one grouped query — to compute gap-fill ranges for all coin/interval pairs without N+1 queries.

## Backtesting model

Backtesting reuses the production pipeline instead of maintaining a separate detector stack. `runBacktest()` resets shared state (`clearPipelineState`, `clearStore`, `clearOnPersist`, `clearSetupGeneratorState`, `setActiveStrategyParams`), replays candles through `onCandleTick()`, and lets the simulator react to emitted setups from the same live path. The `finally` block clears state and restores params regardless of outcome.

The replay sequence interleaves all coin x TF candles chronologically via `buildReplaySequence()`, preserving multi-asset ordering. The key invariant is zero look-ahead bias: the store only contains candles up to the current replay point because they are fed one by one through `onCandleTick()`.

### Trade simulator

`TradeSimulator` supports two exit modes:

- **Multi-exit** (default): TP1 at 40% (zone target), TP2 at 30% (swing target), remaining 30% on ATR trailing stop. SL moves to breakeven after TP1
- **Single-exit**: one SL, one TP, 100% close

Position sizing uses the same risk helpers as the live agent. Correlation guard mirrors live behavior. Circuit breaker stops new entries when drawdown exceeds the configured backtest threshold. Fill happens at next-bar open plus slippage to avoid signal-bar bias, and SL is checked before TP on each bar — conservative by design.

### Async variant

`runBacktestAsync()` yields to the event loop every `BACKTEST_CHUNK_SIZE` bars via `setTimeout(0)`, keeping Telegram polling and other operator loops responsive during long replays. It uses the same replay logic as the sync variant, with progress callbacks layered on top.

## Analytics and reporting

Analytics are fed from persisted trade state, not a separate execution path.

- `MetricsRepo` reads closed positions and refreshes the `daily_performance`, `pattern_performance`, and `pnl_hourly` materialized views
- `refreshViews()` tries `REFRESH CONCURRENTLY` first, then falls back to a plain refresh on first run when matviews are still unpopulated
- `MetricsService.onTradeClose()` is fire-and-forget: it logs errors but never throws, so the agent loop never blocks on analytics
- `connectToAgent()` wires the service to `TradingAgent.onTradeClose` at startup
- `getLiveMetrics()` runs parallel DB queries and builds a `LiveMetrics` object for TUI/operator consumption

Walk-forward validation reports remain pure formatters with overfit detection and IS/OOS comparison.

## Operator surfaces

Three operator surfaces run alongside the trading loop:

| Surface | Where | Purpose |
|---|---|---|
| Ink TUI | terminal (stdout) | Primary real-time view: candles, positions, agent state, health |
| Browser dashboard | `localhost:3030` | Algo Trading Terminal — vital strip, Overview / Market / Journal pages (HTTP polling) |
| Telegram bot | remote | Remote operator commands: `/status`, `/pnl`, `/pause`, `/resume`, `/closeall`, `/mode` |

Operational debugging uses terminal + browser dashboard + logs + Telegram. Real-time browser updates use HTTP polling today; SSE/WS is a documented target in `docs/DESIGN.md`.

## Failure modes and recovery

**Migrations**: Re-entry safe — applied versions are tracked in `schema_migrations`, and each new migration runs in a transaction. The unresolved risk is slow DDL or heavy view refreshes delaying startup.

**Candle persistence**: Live writes are best-effort. Deadlock on concurrent upserts retries once with jitter. If a write still fails, the caller logs and marks health degradation instead of crashing the process.

**Analytics refresh**: Non-fatal by design. `onTradeClose()` catches all errors and logs them. A metrics refresh failure makes TUI summaries lag behind exchange reality until the next successful refresh.

**Matview bootstrap**: `REFRESH CONCURRENTLY` fails on unpopulated matviews. The repo probes relispopulated state and does a plain refresh first when needed, which avoids noisy first-run errors.

**Backtest state leakage**: The `finally` block in `runBacktest()` clears pipeline/store/setup-generator state and restores active params. If a caller bypasses `runBacktest()` and calls `onCandleTick()` directly without the reset sequence, the next run inherits contaminated buffers.

## Blast radius and safe change plan

- `src/db/candle-repo.ts` is cross-cutting. Startup, live runtime, analytics, and backtests all depend on its upsert semantics and query contracts. Safe changes must preserve timestamp dedup and the hot-window cap
- `src/backtest/engine.ts` is part of live-trading correctness. If it stops replaying through `onCandleTick()`, research diverges from production
- Migration changes are rollout-sensitive even in a solo-dev environment. A syntactically valid migration can still create an unsafe startup path if it blocks or fails mid-apply
- Backtest config parameters affect research validity. Changes should be paired with benchmark reruns

## Unknowns

- Unknown: whether all migrations are rollback-safe on production-sized datasets. The code runs them transactionally, but no staged mixed-version rollout has been tested. Verification step: run migrations against a cloned production DB and measure lock duration
- Unknown: whether matview refresh latency is acceptable under higher trade volume. Three sequential refreshes could contend with live reads. Verification step: measure refresh duration under concurrent TUI queries with 1000+ closed positions
- Unknown: whether the backtest reset sequence is still complete after future shared-cache additions in the strategy layer. Verification step: run sequential backtests with different configs and assert zero state leakage

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-15
Data: CodeIndex static analysis + direct source reading
Audience: new engineer, oncall, refactor owner | Confidence: 85%
Unknowns: 3 items pending verification
-->
