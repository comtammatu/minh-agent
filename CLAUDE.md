# Minh (明) — Autonomous Trading Runtime

Exchange-aware Bun trading runtime for Hyperliquid and Bybit.

Live process = market data ingest → PostgreSQL + in-memory store → single `smc-sd` setup engine → trading agent → shared exchange execution → journal/memory foundation → TUI + Telegram + browser dashboard.

`src/memory/` is a foundation (storage + scored retrieval) and receives closed-trade `trade_outcome` memories from journal `exit` events. There is no live `src/advisor/` module on this branch.

## Commands

```bash
bun install                                    # Install dependencies
bun run start                                  # Start the live runtime (= bun run src/index.ts)
bun run test:run                               # Run tests once (preferred final check)
bun test                                       # Watch mode
bun run typecheck                              # Strict TS typecheck
bun run lint                                   # Biome lint (baseline + fixes in S4)
bun run deadcode                               # Knip dead code detection
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci   # Pipeline latency gate
```

## Tooling Health (S3+)
- `bun run lint` / `lint:fix` (biome) — style, no-any, unused.
- `bun run deadcode` (knip) — exports/imports/files.
Baselines recorded in S3; fixes/triage in S4. These feed into runtime `/health` composite (when wired) and PR quality.

## Architecture

```text
Hyperliquid / Bybit REST + WS
  → PostgreSQL + in-memory candle store
  → setup generation pipeline (smc-sd)
  → TradingAgent + OrderManager + PositionMonitor + InvalidationBridge
  → shared exchange execution + Telegram + TUI + browser dashboard

Backtest / optimize / walk-forward reuse the same strategy path.
```

Runtime: Bun · DB: PostgreSQL/TimescaleDB · UI: Ink TUI + Vite/React dashboard · Exchanges: Hyperliquid, Bybit

## Layout

| Path | Purpose |
|---|---|
| `src/runtime/` | Boot, reconnect, shutdown, coin lifecycle orchestration |
| `src/indicators/` | Pure indicator/domain functions |
| `src/strategy/` | Setup engine, orchestrator, diagnostics, shared caches |
| `src/agent/` | Trading agent, order manager, position monitor, thesis monitor, exits, circuit breakers, journal |
| `src/execution/` | Exchange adapters + shared `ExchangePool` |
| `src/feed/` | HL/BB REST/WS feeds, selectors, funding/OI, in-memory store |
| `src/db/` | Connection, migrations, candle repository |
| `src/analytics/` | Closed-trade metrics + live wallet stats |
| `src/alert/telegram/` | Bot, commands, alert formatting |
| `src/ui/` | Ink TUI dashboard, account/position views, sound |
| `src/server/` | Bun HTTP server for the browser dashboard |
| `src/memory/` | Trade memory foundation; journal exit outcomes write `trade_outcome` |
| `src/lib/` | Cross-cutting helpers (`retry.ts`, `logger.ts`) |
| `src/backtest/` | Replay engine, simulator, optimization, reporting, benchmarks |
| `dashboard/` | React + Vite browser dashboard, served via `src/server/` |
| `src/config.ts` | All thresholds, regime multipliers, coin/TF lists |
| `src/types.ts` | Core type definitions |
| `scripts/`, `test/` | One-shot scripts and out-of-module integration tests |

## Core Constraints

- TypeScript strict mode. NEVER use `any` without a justification comment
- `src/indicators/` and pure `src/strategy/` helpers stay **zero I/O** — side effects belong at the edges (`runtime/`, `feed/`, `db/`, `execution/`, `alert/telegram/`, `ui/`, `server/`)
- No magic numbers — thresholds live in `src/config.ts`
- NEVER commit secrets (`.env`, API keys, private keys)
- Simplest working solution wins: `slice()` over ring buffer, `Map` over SQLite
- Pure functions return values, never mutate inputs, return `null` for invalid input
- `try/catch` at I/O boundaries only
- `bun run test:run` MUST pass before marking any task complete
- Task Contract REQUIRED for tasks ≥ 3 steps — see [.claude/rules/session-protocol.md](.claude/rules/session-protocol.md)
- Commit format: `<type>(<scope>): <description>` — types: feat / fix / refactor / test / docs / chore / perf

## Runtime Invariants

- **Active exchange is process-wide.** `ACTIVE_EXCHANGE=HL|BB` is chosen once at startup. No mixed-exchange runtime in one process.
- **Single strategy path is active.** One concrete `smc-sd` engine. No active registry, no `strategyId` runtime dimension.
- **Exchange pool is single-wallet.** One shared exchange service/account per process. Cross-coin exposure control sits above the execution layer.
- **Startup order matters:** `migrations → coin selection → WS subscribe first → PG load → gap-fill/backfill → write-through persist → polling/agent/TUI steady state`. Don't "clean up" the boot sequence casually.
- **TUI starts before backfill finishes** — it shows bootstrap progress first, then transitions into the main dashboard after `setBackfillDone()`.
- **Strategy pipeline is pure, agent is not.** `strategy/` emits setups. `agent/` and `execution/` own side effects, retries, reconciliation, and state transitions.
- **Coin selection is dynamic** (HL: top native perps + optional HIP-3; BB: own ranked list). Coins with active setups are intentionally not dropped mid-lifecycle.
- **Candle persistence is hybrid** — hot window in memory, historical continuity in PG. Runtime loads from PG first, then gap-fills via REST.
- **Paper mode is the safe default.** `.env.example` sets `EXECUTION_MODE=paper`. `PAPER_TRADE=false` is only a legacy alias when `EXECUTION_MODE` is unset. Live mode requires valid exchange credentials and should not be assumed.

## Rules (per-topic single source of truth)

Detailed rules live in `.claude/rules/`. Each file is the canonical source for its topic — do not duplicate their content here.

| Topic | File |
|---|---|
| Session workflow + Task Contract | [session-protocol.md](.claude/rules/session-protocol.md) (Cloud: see environment/cursor-cloud.md) |
| Test / lint / typecheck gates | [quality-gates.md](.claude/rules/quality-gates.md) |
| Pattern TTLs (Order Block, FVG, Spring, …) | [invalidation-table.md](.claude/rules/invalidation-table.md) |
| Indicator rules (zero I/O, golden tests) | [indicators.md](.claude/rules/indicators.md) |
| Strategy rules (regime soft, confluence grades) | [strategy.md](.claude/rules/strategy.md) |
| Feed rules (candle dedup, staleness, store API) | [feed.md](.claude/rules/feed.md) |
| HL + Bybit landmines (rate limits, signing, OI cap, DMS) | [exchange-gotchas.md](.claude/rules/exchange-gotchas.md) |

## Architecture Docs

**Before any UI, schema, or system-level change → read [docs/DESIGN.md](docs/DESIGN.md) first.** It is the canonical reference for system design, database schema, design tokens, component patterns, UI layout, keyboard shortcuts, and API contracts. Existing topic docs below remain valid for deeper per-layer context.

| Doc | Focus |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | **Canonical design reference** — index over 7 sub-docs (system / DB / tokens / components / UI / hotkeys / API) |
| [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) | System overview, import graph hubs, change priorities |
| [docs/runtime-and-feed.md](docs/runtime-and-feed.md) | Boot order, subscriptions, persistence |
| [docs/strategy-engine.md](docs/strategy-engine.md) | Strategy runtime, pipeline, setup generator |
| [docs/agent-and-execution.md](docs/agent-and-execution.md) | State machine, order manager, exchange pool |
| [docs/data-and-backtesting.md](docs/data-and-backtesting.md) | DB, analytics, replay tooling |

## Project Docs

| Doc | Purpose |
|---|---|
| [README.md](README.md) | Project pitch + quick start |
| [SETUP.md](SETUP.md) | Local environment + startup flow |
| [TODOS.md](TODOS.md) | Active backlog only |
| [CONTRIBUTING.md](CONTRIBUTING.md) | PR workflow + quality gates |

## Archive

Sprint plans, legacy architecture notes, generated analysis artifacts, and external reference material live under [docs/archive/](docs/archive/README.md). Useful for rationale; not a reliable inventory of what is on the current branch — verify against the filesystem first.
