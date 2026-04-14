# Codebase Map

## Documentation Intent Contract

- Audience: new engineer, oncall, and refactor owner.
- Primary tasks: trace the live startup and trading loop; estimate blast radius before changing strategy, agent, or feed code.
- Decision horizon: onboarding, incident response, and architecture review.
- Out of scope: trading alpha quality, exchange profitability, and market-domain validation.

## System overview

`minh-agent` is a single-process Bun trading engine that boots the database, selects coins, hydrates candle state, backfills missing history, wires a strategy pipeline, then routes emitted setups into an execution agent and operator surfaces (`src/index.ts:281`, `src/index.ts:301`, `src/index.ts:337`, `src/index.ts:439`, `src/index.ts:599`, `src/index.ts:673`). The live path is deliberately restartable: `runWithReconnect()` wraps `main()` with exponential backoff and a separate shutdown path that drains intervals, stops polling, closes feeds, and closes the DB (`src/index.ts:766`, `src/index.ts:777`, `src/index.ts:805`, `src/index.ts:816`).

The codebase is dense rather than wide. The generated import graph covers 118 TS/TSX files and 472 internal edges, with `types.ts`, `config.ts`, and `lib/logger.ts` acting as the dominant hubs (`docs/oracle-data/analysis-summary.md:5`, `docs/oracle-data/analysis-summary.md:23`). That makes contract files and shared operational helpers the highest-blast-radius edit points even though most business logic lives deeper in `strategy/`, `agent/`, `feed/`, and `backtest/`.

## Architecture map

### Runtime loop

```mermaid
flowchart LR
  A[index.ts boot] --> B[DB migrations]
  B --> C[Coin selection]
  C --> D[WS subscribe]
  D --> E[PG load plus REST backfill]
  E --> F[Strategy bootstrap]
  F --> G[Agent and execution wiring]
  G --> H[Telegram, TUI, metrics, health]
  H --> I[Reconnect loop]
```

This flow is explicit in `main()`, not spread across a framework lifecycle (`src/index.ts:281`, `src/index.ts:302`, `src/index.ts:337`, `src/index.ts:413`, `src/index.ts:439`, `src/index.ts:533`, `src/index.ts:599`, `src/index.ts:688`).

### Setup-to-order path

```mermaid
sequenceDiagram
  participant Feed
  participant Pipeline
  participant Agent
  participant Orders
  participant Exchange
  Feed->>Pipeline: onCandleTick()
  Pipeline->>Pipeline: closed-candle scan
  Pipeline->>Agent: emit setup
  Agent->>Orders: action(place_order)
  Orders->>Exchange: placeOrder / placeTrigger
  Exchange-->>Orders: fill / reject / cancel
  Orders-->>Agent: state event
```

The orchestrator gates on closed candles before dispatching strategies, then emits setup events through `pipelineEmitter`; the agent subscribes to that emitter and turns setups into state-machine events that the order manager executes (`src/strategy/orchestrator.ts:210`, `src/strategy/orchestrator.ts:263`, `src/strategy/orchestrator.ts:329`, `src/agent/trading-orchestrator.ts:103`, `src/agent/trading-orchestrator.ts:146`, `src/agent/order-manager.ts:116`, `src/agent/order-manager.ts:202`).

### Backtest reuse path

```mermaid
flowchart LR
  A[Historical candles] --> B[runBacktest]
  B --> C[clear shared state]
  C --> D[onCandleTick production path]
  D --> E[pipeline emits setup]
  E --> F[TradeSimulator]
  F --> G[metrics and equity curve]
```

Backtests reuse the production pipeline instead of a separate simulation-specific rule engine. `runBacktest()` clears the store and pipeline state, activates one strategy, replays candles through `onCandleTick()`, and lets the simulator react to emitted setups (`src/backtest/engine.ts:45`, `src/backtest/engine.ts:49`, `src/backtest/engine.ts:63`, `src/backtest/engine.ts:92`, `src/backtest/engine.ts:114`).

## Module guide

| Document | Focus | Why it matters |
|---|---|---|
| [runtime-and-feed.md](runtime-and-feed.md) | boot, subscriptions, backfill, in-memory store | startup reliability and data freshness |
| [strategy-engine.md](strategy-engine.md) | pipeline, registry, SMC-SD strategy | signal quality and blast radius of strategy changes |
| [agent-and-execution.md](agent-and-execution.md) | state machine, order manager, position sync, exchange pool | money-handling safety and reconciliation |
| [data-and-backtesting.md](data-and-backtesting.md) | persistence, analytics, backtest reuse, health and operator loop | rollback safety, observability, and offline evaluation |

## Infrastructure and runtime context

The runtime is Bun with PostgreSQL persistence via the `postgres` client, and the default local DB points to `postgres://minh:minh_dev@localhost:5432/minh` (`package.json:1`, `src/db/connection.ts:7`). Startup always runs numbered SQL migrations before touching feeds or exchange state, which keeps schema drift localized to boot (`src/index.ts:301`, `src/db/migrate.ts:14`).

The system is intentionally edge-driven. Exchange and Telegram I/O live in `index.ts`, `feed/`, `execution/`, and `alert/telegram/`, while the strategy and indicator layers stay pure or near-pure (`src/strategy/registry.ts:27`, `src/strategy/strategies/smc-sd/index.ts:13`, `src/feed/rest.ts:48`, `src/alert/telegram/bot.ts:1430`).

## Highest-risk hubs

| File | Risk | Impact |
|---|---|---|
| `src/types.ts` | Shared contract hub | breaks most layers if shape changes drift |
| `src/config.ts` | Runtime and model thresholds | changes both live trading and backtests |
| `src/lib/logger.ts` | Shared operational sink | affects observability across every hot path |
| `src/agent/types.ts` | Execution state contracts | breaks agent, order manager, monitor, and UI together |
| `src/backtest/types.ts` | Research and replay contracts | breaks optimization and backtest orchestration together |

The hub ranking comes from the generated import graph, not from name heuristics (`docs/oracle-data/analysis-summary.md:23`).

## Change priorities

1. Guard `config.ts` edits with backtest and live-path review. It is the second-largest hub and also stores the strategy thresholds that shape both production and replay behavior (`docs/oracle-data/analysis-summary.md:23`, `src/config.ts:25`, `src/config.ts:34`).
2. Treat `index.ts` as an orchestration boundary, not a dumping ground. It already owns startup sequencing, lifecycle recovery, TUI wiring, Telegram boot, and exchange bootstrap (`src/index.ts:281`, `src/index.ts:533`, `src/index.ts:671`, `src/index.ts:766`).
3. Keep order and position reconciliation conservative. `PositionMonitor.syncWithExchange()` explicitly skips reconciliation on API failure to avoid false closes, which is safer than stale-but-authoritative assumptions (`src/agent/position-monitor.ts:511`, `src/agent/position-monitor.ts:514`).
4. Preserve the production/backtest reuse contract. Strategy changes that bypass `onCandleTick()` or `pipelineEmitter` create instant model drift between live mode and replay mode (`src/strategy/orchestrator.ts:329`, `src/backtest/engine.ts:92`).

## Unknowns and verification

- Unknown: exchange-level protection quality in live Bybit mode. The code handles shutdown cancel-all and exchange bootstrap, but this review did not exercise real credentials or inspect exchange responses (`src/index.ts:743`, `src/execution/exchange-pool.ts:50`).
- Unknown: whether the Telegram control surface is fully documented for operators. The bot layer is substantial, but this pass did not enumerate command coverage from `commands.ts`; verify by tracing `registerBuiltinCommands()` and running the bot in a test chat (`src/alert/telegram/bot.ts:30`, `src/alert/telegram/bot.ts:123`).
- Unknown: whether all migrations are rollback-safe on production-sized datasets. The code runs them transactionally, but this pass did not benchmark or stage mixed-version rollouts (`src/db/migrate.ts:42`).

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: tree-sitter analysis + generated import graph + direct source reading
Audience: new engineer, oncall, refactor owner | Confidence: 82%
Unknowns: 3 items pending verification
-->
