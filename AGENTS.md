# Minh (明) — Autonomous Trading Runtime

Deterministic Bun trading runtime: exchange feeds → PostgreSQL + in-memory store → strategy registry/orchestrator → trading agent → exchange execution → TUI + Telegram. Current branch does not ship the historical `src/server/`, `dashboard/`, `src/advisor/`, or `src/memory/` modules described in older sprint plans.

## Commands

```bash
bun install               # Install dependencies
bun run src/index.ts      # Start runtime (migrate → hydrate → backfill → scan)
bun test                  # Run tests (watch mode)
bun test --run            # Run tests (single run, MUST pass before done)
bun run typecheck         # Type-check runtime code
```

## Constraints

- MUST use TypeScript strict mode. NEVER use `any` without justification comment
- NEVER do I/O in `indicators/` and pure strategy helpers
- I/O lives at edges: `index.ts`, `feed/`, `execution/`, `alert/telegram/`, `db/`, and `ui/`
- MUST run `bun test --run` before marking any task complete
- Task Contract REQUIRED for 3+ step tasks (see `.claude/rules/session-protocol.md`)
- No magic numbers — all thresholds in `config.ts`
- NEVER commit secrets (`.env`, API keys, private keys)
- Simplest working solution wins: `slice()` over ring buffer, `Map` over SQLite

## Architecture

```text
Hyperliquid / Bybit REST + WS
  → PostgreSQL + in-memory candle store
  → strategy orchestrator / registry
  → TradingAgent + OrderManager + PositionMonitor
  → exchange execution + Telegram + TUI

Backtest / optimize / walk-forward reuse the same strategy path.
```

Runtime: Bun | DB: PostgreSQL/TimescaleDB | Exchanges: Hyperliquid + Bybit | UI: Ink TUI + Telegram

## Key Directories

- `src/indicators/` — Pure indicator building blocks
- `src/strategy/` — Orchestrator, registry, strategies, shared caches/invalidation helpers
- `src/agent/` — Trading agent state machine, order manager, position monitor, thesis monitor, exits, circuit breakers
- `src/execution/` — Exchange service boundary and exchange pool
- `src/feed/` — REST backfill, WS subscribe, store hydration, exchange adapters
- `src/db/` — Migrations, candle repository, analytics persistence
- `src/backtest/` — Backtest, optimizer, walk-forward, benchmark tools
- `src/analytics/` — Metrics repo and live metrics service
- `src/alert/telegram/` — Telegram alerts and operator commands
- `src/ui/` — Ink TUI
- `src/config.ts` — Thresholds, risk controls, exchange/timeframe settings
- `src/types.ts` — Core market and signal types

## Things That Will Bite You

- **HL SDK**: All numeric values are strings → `parseFloat()` everywhere
- **HL WS**: Returns only live bars, not historical candles → REST or DB hydration must happen first
- **HL REST rate limit**: Weight-based 1200 weight/min per IP. All callers go through `feed/rate-limiter.ts`
- **HL REST candles**: Max 5000/request. Per-TF counts live in `BACKFILL_CANDLE_COUNTS`
- **HL order precision**: Prices max 5 sig figs + `(6 - szDecimals)` decimals. Sizes rounded to `szDecimals`
- **HL signing**: Use SDK, do not DIY. Field order and lowercase addresses matter
- **HL OI cap**: Some assets cannot open new positions when OI capped
- **HL dead man's switch**: `scheduleCancel` exists and matters for live safety
- **HL unified account**: Effective balance = perp + spot USDC
- **Single exchange per process**: `ACTIVE_EXCHANGE` is mutually exclusive (`HL` or `BB`). Run two processes if you want both
- **Single shared live wallet per process**: strategy isolation is in software state and risk controls, not separate live wallets
- **Candle dedup**: WS can resend the same timestamp as REST/DB hydration → store upserts by timestamp
- **Staleness**: Track `lastCandleTime` per coin/tf, warn after 60s silence
- **Regime filter**: Soft — reduces confidence, does not hard-block every counter-trend setup
- **detectRegime**: Requires 50+ candles
- **Thesis Monitor**: Active positions re-evaluate multi-TF regime and bias every sync cycle; legacy positions with null thesis are skipped

## Code Patterns

- Pure functions return values, never mutate input, return `null` for invalid input
- `try/catch` at I/O boundaries only
- Commit: `<type>(<scope>): <description>` — types: feat/fix/refactor/test/docs/chore/perf

## References

- Current branch overview: `README.md`, `SETUP.md`, `TODOS.md`
- Architecture map: `docs/CODEBASE_MAP.md`
- Runtime/feed: `docs/runtime-and-feed.md`
- Strategy runtime: `docs/strategy-engine.md`
- Agent/execution: `docs/agent-and-execution.md`
- Data/backtesting: `docs/data-and-backtesting.md`
- Historical architecture + roadmap context: `docs/spec/architecture.md`, `docs/spec/market-memory.md`, `docs/plan/decisions.md`, `docs/plan/sprint-*.md`
- Session protocol + task contract: `.claude/rules/session-protocol.md`
- Quality gates: `.claude/rules/quality-gates.md`
- Pattern invalidation rules: `.claude/rules/invalidation-table.md`
