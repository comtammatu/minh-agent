# Minh (明)

Single-process Bun trading runtime for multi-timeframe setup detection, live or paper execution, Telegram operations, and historical evaluation.

## Current Branch Status

As of `2026-04-15`, this branch implements:

- PostgreSQL/TimescaleDB migrations and candle persistence
- Hyperliquid and Bybit feed adapters
- In-memory hot store plus strategy orchestrator and registry
- `smc-sd` multi-timeframe strategy logic
- Trading agent, order manager, position monitor, circuit breakers, and thesis monitoring
- Full-screen Ink TUI and Telegram operator commands
- Backtest, optimization, walk-forward, and pipeline benchmark tooling

This branch does **not** currently contain the planned:

- `src/server/` HTTP API / Elysia layer
- `dashboard/` React or Vite web UI
- `src/advisor/` LLM advisor
- `src/memory/` advisor memory system

Several sprint docs still describe those planned systems for roadmap or historical context. Treat this `README`, [TODOS.md](TODOS.md), and [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) as the source of truth for what is actually present in the repo today.

## Quick Start

```bash
bun install
docker-compose up -d
cp .env.example .env
bun test --run
bun run src/index.ts
```

Recommended first run:

- keep `PAPER_TRADE=true`
- use `ACTIVE_EXCHANGE=HL` unless you are validating Bybit-specific behavior
- configure Telegram only if you want remote operator commands

## Runtime Shape

```text
Exchange REST/WS
  -> PostgreSQL + in-memory candle store
  -> strategy orchestrator / registry
  -> TradingAgent + OrderManager + PositionMonitor
  -> TUI + Telegram

Historical replay tools reuse the same strategy path through backtest/optimize flows.
```

## Where To Read Next

- [SETUP.md](SETUP.md): local environment and startup flow
- [TODOS.md](TODOS.md): active backlog only
- [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md): current architecture map
- [docs/runtime-and-feed.md](docs/runtime-and-feed.md): startup, subscriptions, persistence
- [docs/strategy-engine.md](docs/strategy-engine.md): strategy runtime behavior
- [docs/agent-and-execution.md](docs/agent-and-execution.md): money-handling path
- [docs/data-and-backtesting.md](docs/data-and-backtesting.md): DB, analytics, replay tooling

## Planning Docs

`docs/plan/` is a mix of:

- historical sprint plans
- superseded design decisions
- forward-looking roadmap drafts

Those files are still useful for rationale, but they are **not** a reliable inventory of modules that exist on the current branch. If a plan mentions `dashboard/`, `src/server/`, `src/advisor/`, or `src/memory/`, verify against the filesystem before treating it as implemented.
