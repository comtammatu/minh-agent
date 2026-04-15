# Minh (明) — Autonomous Trading Runtime

Exchange-aware Bun trading runtime for Hyperliquid and Bybit. Live process = market data ingest → PostgreSQL + in-memory store → single `smc-sd` setup engine → trading agent → shared exchange execution → TUI + Telegram + PostgreSQL-backed analytics/backtesting. Current branch does not ship the historical `src/server/`, `dashboard/`, `src/advisor/`, or `src/memory/` modules described in older sprint plans.

## Commands

```bash
bun install               # Install dependencies
bun run start             # Start the live runtime
bun run src/index.ts      # Start directly (same entrypoint)
bun test                  # Run tests (watch mode)
bun run test:run          # Run tests once (preferred final check)
bun run typecheck         # Strict TS typecheck
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci  # Pipeline latency gate
```

## Constraints

- MUST use TypeScript strict mode. NEVER use `any` without justification comment
- NEVER do I/O in `indicators/` or pure `strategy/` helpers — zero side effects
- I/O lives at edges: `src/runtime/`, `src/feed/`, `src/db/`, `src/execution/`, `src/alert/telegram/`, `src/ui/`
- MUST run `bun test --run` before marking any task complete
- Task Contract REQUIRED for 3+ step tasks (see `.claude/rules/session-protocol.md`)
- No magic numbers — all thresholds in `config.ts`
- NEVER commit secrets (.env, API keys, private keys)
- Simplest working solution wins: `slice()` over ring buffer, `Map` over SQLite

## Architecture

```text
Hyperliquid / Bybit REST + WS
  → PostgreSQL + in-memory candle store
  → setup generation pipeline (`smc-sd`)
  → TradingAgent + OrderManager + PositionMonitor + InvalidationBridge
  → shared exchange execution + Telegram + TUI

Backtest / optimize / walk-forward reuse the same strategy path.
```

Runtime: Bun | DB: PostgreSQL/TimescaleDB | UI: Ink TUI | Exchanges: Hyperliquid, Bybit

## Key Directories

- `src/runtime/` — Boot, reconnect, shutdown, and coin lifecycle orchestration
- `src/indicators/` — Pure indicator/domain functions
- `src/strategy/` — Concrete setup engine, orchestrator, diagnostics, shared caches/helpers
- `src/agent/` — Trading agent, order manager, position monitor, thesis monitor, exits, circuit breakers, journal
- `src/execution/` — Exchange adapters + shared `ExchangePool`
- `src/feed/` — HL/BB REST/WS feeds, selectors, funding/OI, in-memory store
- `src/db/` — Connection, migrations, candle repository
- `src/analytics/` — Closed-trade metrics + live wallet stats
- `src/alert/telegram/` — Bot, commands, alert formatting
- `src/ui/` — Ink TUI dashboard, live account/position views, sound
- `src/backtest/` — Replay engine, simulator, optimization, reporting, benchmarks
- `src/config.ts` — All thresholds, regime multipliers, coin/TF lists
- `src/types.ts` — Core type definitions

## Things That Will Bite You

- **Active exchange is process-wide**: `ACTIVE_EXCHANGE=HL|BB` is chosen once at startup. No mixed-exchange runtime in one process
- **Single strategy path is active**: current branch runs one concrete `smc-sd` setup engine. There is no active registry or `strategyId` runtime dimension on the live path
- **Startup order matters**: current boot is `migrations → coin selection → WS subscribe first → PG load → gap-fill/backfill → write-through persist → polling/agent/TUI steady state`
- **TUI starts before backfill finishes**: it shows bootstrap progress first, then transitions into the main dashboard after `setBackfillDone()`
- **Strategy pipeline is still pure, agent is not**: `strategy/` emits setups; `agent/` and `execution/` own side effects, retries, reconciliation, and state transitions
- **Exchange pool is single-wallet**: one shared exchange service/account per process. Cross-coin exposure control belongs above the execution layer
- **Coin selection is dynamic**: HL tracks top native perps + optional HIP-3 coins; BB uses its own ranked list. Coins with active setups are intentionally not dropped mid-lifecycle
- **Candle persistence is hybrid**: hot window in memory, historical continuity in PG. Runtime loads from PG first, then gap-fills via REST
- **Paper mode is the safe default**: `.env.example` sets `PAPER_TRADE=true`; live mode requires valid exchange credentials and should not be assumed
- **HL SDK**: All numeric values are strings → `parseFloat()` everywhere
- **HL WS**: real-time only for candles; history comes from REST/PG bootstrap
- **HL REST rate limit**: Weight-based 1200 weight/min per IP. Info=20, candleSnapshot=20+ceil(items/60) surcharge (500 candles→~29w, 5000→~104w), l2Book/allMids/clearinghouseState/orderStatus=2, exchange=1. All REST callers go through `feed/rate-limiter.ts`
- **HL REST candles**: Max 5000/request. Per-TF counts: 500 for 1m/5m, 5000 for 15m+ (config `BACKFILL_CANDLE_COUNTS`)
- **HL address rate limit**: 1 req per 1 USDC traded (cumulative). Initial buffer 10K. Stale `expiresAfter` cancels cost 5x weight
- **HL order precision**: Prices max 5 sig figs + `(6 - szDecimals)` decimals. Sizes rounded to `szDecimals`. Remove trailing zeroes. Min order value $10. Asset ID = index from `meta.universe`, not coin name
- **HL signing**: Two schemes (l1_action vs user_signed_action). Field order matters. Lowercase addresses. Wrong signature → opaque error ("missing wallet"). Use SDK, don't DIY
- **HL OI cap**: Some assets at OI cap → can't open positions. Check `perpsAtOpenInterestCap()` before placing
- **HL dead man's switch**: `scheduleCancel` auto-cancels all orders after timestamp. Max 10/day. Critical for bot safety
- **HL WS limits**: 1000 subs, 10 connections, 2000 msg/min. Subscription budget depends on dynamic coin count and per-coin feeds
- **HL agent wallet**: Bot uses agent wallet PK (`PRIVATE_KEY`) for signing, main account address (`ACCOUNT_ADDRESS`) for info queries. Agent wallet can trade but cannot withdraw. Nonces tracked per agent address
- **HL unified account**: Balance lives in spot (`spotClearinghouseState`), not perp (`clearinghouseState`). `getAccountState()` queries both and returns `effectiveBalance = perp + spot USDC`
- **Bybit feed differs from HL**: no separate mark-price stream in the current runtime; the TUI uses the latest 1m candle close as the price proxy on BB
- **Candle dedup**: WS may resend same timestamp as REST → store upserts by timestamp
- **Staleness**: candles and orderbook are checked on intervals; stale data warns instead of silently trusting dead feeds
- **Regime filter**: Soft — does not block counter-trend, reduces confidence (×1.0/×0.8/×0.3)
- **detectRegime**: Requires 50+ candles (SMA/ATR/ADX/volume)

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
- Historical architecture + roadmap context: `docs/archive/spec/architecture.md`, `docs/archive/spec/knowledge-spec.md`, `docs/archive/spec/market-memory.md`, `docs/archive/ref/domain-knowledge.md`, `docs/archive/plan/decisions.md`, `docs/archive/plan/sprint-*.md`
- Session protocol + task contract: `.claude/rules/session-protocol.md`
- Quality gates: `.claude/rules/quality-gates.md`
- Pattern invalidation rules: `.claude/rules/invalidation-table.md`
