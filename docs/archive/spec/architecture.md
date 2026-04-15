# Minh (明) — Architecture

> **Archive note (2026-04-15)**: this document is preserved as historical architecture and roadmap context, not as the active implementation source of truth.
>
> **Current runtime snapshot (2026-04-15)**:
> - one active exchange per process (`HL` or `BB`)
> - one shared exchange wallet/service per process
> - one concrete `smc-sd` setup engine on the active path
> - thin `src/index.ts` entrypoint with long-lived orchestration in `src/runtime/app.ts`
> - Ink TUI + optional Telegram operator surface
>
> Current branch does **not** contain the planned `src/server/`, `dashboard/`, `src/advisor/`, or `src/memory/` modules referenced in older roadmap material. Use `README.md`, `docs/CODEBASE_MAP.md`, `docs/runtime-and-feed.md`, `docs/strategy-engine.md`, `docs/agent-and-execution.md`, and `docs/data-and-backtesting.md` as the live branch source of truth.

## System overview

```text
                +-----------------------------+
                |         src/config.ts       |
                | exchange / TF / risk knobs  |
                +-------------+---------------+
                              |
                              v
 +------------------+   +------------------+   +----------------------+
 | HLFeed / BybitFeed|-->| feed/store.ts    |-->| strategy/orchestrator |
 | REST + WS ingest  |   | hot candle cache |   | closed-candle scans   |
 +---------+--------+   +---------+--------+   +----------+-----------+
           |                        |                       |
           |                        v                       v
           |              +------------------+   +----------------------+
           |              | db/candle-repo   |   | strategy/registry    |
           |              | PG write-through |   | enabled strategies   |
           |              +------------------+   +----------+-----------+
           |                                                  |
           |                                                  v
           |                                      pipeline setup events
           |                                                  |
           v                                                  v
 +-------------------+   +-------------------+   +----------------------+
 | TradingAgent      |<->| OrderManager      |<->| ExchangePool         |
 | per-coin state    |   | order lifecycle   |   | shared HL/BB service |
 +---------+---------+   +---------+---------+   +----------+-----------+
           |                       ^                        |
           v                       |                        v
 +-------------------+   +---------+---------+   +----------------------+
 | PositionMonitor   |---| InvalidationBridge|   | analytics / journal  |
 | sync + trailing   |   | setup invalidation|   | metrics + persistence|
 +---------+---------+   +-------------------+   +----------+-----------+
           |                                                         |
           +----------------------+----------------------+-----------+
                                  |                      |
                                  v                      v
                         +----------------+     +-------------------+
                         | Ink TUI        |     | Telegram bot      |
                         | local operator |     | alerts + commands |
                         +----------------+     +-------------------+
```

## Execution model

The architecture is intentionally split into pure and impure layers.

### Pure layers

- `src/indicators/` computes domain signals and market structure
- `src/strategy/` turns candles plus context into `Signal` / setup events
- backtests reuse the same scan path by replaying candles through the orchestrator

### Stateful / I/O layers

- `src/feed/` handles REST/WS transport, coin selection, and in-memory market data
- `src/db/` persists candles, orders, journal state, analytics inputs
- `src/agent/` owns state transitions, risk state, reconciliation, and invalidation responses
- `src/execution/` owns exchange-specific order/account/position calls
- `src/ui/` and `src/alert/telegram/` are operator surfaces

This separation is an important invariant. Strategy code should not start doing exchange or DB work.

## Startup flow

Current `src/index.ts` boot order:

1. select active exchange (`HL` or `BB`)
2. run migrations
3. build the dynamic coin selector
4. fetch ranked coins
5. subscribe websocket feeds first
6. start the TUI immediately
7. load persisted candles from PostgreSQL into the in-memory store
8. gap-fill / full backfill with REST
9. enable per-candle PG write-through for live runtime
10. start funding / OI polling where applicable
11. initialize the shared exchange pool
12. wire agent, order manager, position monitor, invalidation bridge
13. start Telegram bot
14. bootstrap the pipeline from the store
15. enter steady-state loops (sync, staleness checks, refresh loops, metrics refresh)

Two design points matter here:
- websocket subscribe happens before backfill so the process does not miss real-time candles during bootstrap
- the TUI starts early so the operator sees bootstrap progress instead of a silent terminal

## Exchange modes

### Hyperliquid mode

- dynamic native perp ranking by open interest
- optional HIP-3 coin tracking
- REST rate limiting is explicit and central
- funding/OI side feeds run in-process
- unified account view combines perp + spot USDC

### Bybit mode

- separate feed and execution adapters live under `src/feed/bybit/` and `src/execution/`
- coin ranking comes from Bybit-specific selection logic
- the current TUI price display uses the latest 1m candle close as the mark proxy
- live shutdown attempts cancel-all open orders

The process never mixes exchanges. `ACTIVE_EXCHANGE` is read at startup and treated as fixed for the process lifetime.

## Strategy pipeline

`StrategyRegistry` owns strategy registration, enablement, and failure isolation. `strategy/orchestrator.ts` owns scan cadence, setup tracking, status snapshots, and event emission.

Today the production strategy path is centered on `SmcSdStrategy`, which implements a staged ICT-style drill-down:
- 4h POI discovery
- 15m confirmation
- 5m micro entry
- 1h same-TF path

All thresholds remain centralized in `src/config.ts`, which is good for tuning but means config changes affect both live trading and backtests unless a backtest pins parameters explicitly.

## Agent and execution

The agent side is designed as a state machine, not a fire-and-forget order router.

- `TradingAgent` manages per-coin/per-strategy contexts
- `OrderManager` owns order submission, persistence, callbacks, and timeout handling
- `PositionMonitor` owns exchange sync, trailing-stop updates, and open-position recovery
- `InvalidationBridge` translates pipeline invalidation into agent events
- `ExchangePool` exposes one shared exchange service/account to all enabled strategies

Shared-wallet operation reduces wallet fragmentation and duplicate exchange clients, but it pushes exposure coordination up into agent/risk logic.

## Persistence and replay

The storage model is hybrid:
- recent candles stay in memory for hot-path strategy access
- candles are also persisted to PostgreSQL/TimescaleDB
- startup restores from PG first, then gap-fills missing ranges

Backtests intentionally reuse the live pipeline:
- historical candles are replayed through `onCandleTick()`
- emitted setups feed the simulator
- this keeps research closer to live behavior than a separate detector implementation would

## Operator surfaces

The current operator surfaces are:
- Ink TUI in the terminal
- Telegram alerts and command bot
- structured logs in `minh.log`

There is no active browser dashboard or in-process HTTP API in the current runtime path. Older sprint documents describe that design direction, but the code presently runs as TUI + Telegram.

## Safety invariants

- `src/indicators/` and `src/strategy/` stay pure
- candle upserts are idempotent by timestamp
- startup order is behaviorally significant
- one process uses one active exchange
- one process uses one shared wallet/service instance
- agent/exchange failures should degrade explicitly, not silently mutate strategy behavior

## Highest-risk files for change

- `src/index.ts` — lifecycle wiring and startup/shutdown ordering
- `src/feed/store.ts` — hot data semantics shared by runtime and replay
- `src/strategy/orchestrator.ts` — event cadence and setup state
- `src/agent/order-manager.ts` — money-moving boundary
- `src/agent/position-monitor.ts` — reconciliation and trailing behavior
- `src/execution/exchange-pool.ts` — shared exchange mode assumptions
- `src/config.ts` — live and backtest behavior knobs

## Related docs

- `docs/runtime-and-feed.md`
- `docs/strategy-engine.md`
- `docs/agent-and-execution.md`
- `docs/data-and-backtesting.md`
- `SETUP.md`
