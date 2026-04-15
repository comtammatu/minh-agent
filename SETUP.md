# Setup Guide — Minh (明)

Current runtime is a single Bun process with:
- one active exchange per process (`HL` or `BB`)
- a PostgreSQL/TimescaleDB backing store
- an Ink TUI for local operations
- optional Telegram alerts/commands

There is no browser dashboard or local HTTP server in the current codepath.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Bun | >= 1.x | Required runtime and test runner |
| Docker Compose | recent | Used for local PostgreSQL/TimescaleDB |
| Git | any recent | Clone + workflow |

## 1. Install dependencies

```bash
git clone <repo-url> minh-agent
cd minh-agent
bun install
```

## 2. Start PostgreSQL/TimescaleDB

```bash
docker-compose up -d
docker-compose ps
```

Expected container:
- `minh-timescaledb`

Default local DB settings from `docker-compose.yml`:
- user: `minh`
- password: `minh_dev`
- database: `minh`
- port: `5432`

Migrations run automatically on process start via `runMigrations()`.

## 3. Configure environment

```bash
cp .env.example .env
```

Minimum `.env` for safe local startup:

```env
DATABASE_URL=postgres://minh:minh_dev@localhost:5432/minh
LOG_LEVEL=INFO
ACTIVE_EXCHANGE=HL
PAPER_TRADE=true
```

### Exchange credentials

Hyperliquid live mode:

```env
PRIVATE_KEY=0x...
ACCOUNT_ADDRESS=0x...
```

Bybit live mode:

```env
ACTIVE_EXCHANGE=BB
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
```

Optional operator surface:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Notes:
- `.env.example` defaults to `PAPER_TRADE=true`. Keep it that way until you explicitly want live trading
- `ACTIVE_EXCHANGE` is process-wide. One process runs one exchange

## 4. Verify the repo before first run

```bash
bun run typecheck
bun run test:run
```

If DB-related tests fail, check that Docker is up and the DB is healthy.

## 5. Optional performance gate

```bash
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
```

Use this before changing hot-path strategy or pipeline code.

## 6. Start the runtime

```bash
bun run start
```

Equivalent:

```bash
bun run src/index.ts
```

## Startup sequence

`src/index.ts` is now a thin entrypoint. Long-lived orchestration lives in `src/runtime/app.ts`, which currently boots in this order:

1. choose active exchange and build coin selector
2. run DB migrations
3. fetch ranked coins
4. subscribe websocket feeds first
5. start the TUI immediately
6. load persisted candles from PostgreSQL into memory
7. gap-fill/backfill with REST
8. enable PG write-through for live candles
9. start funding/OI polling
10. initialize exchange pool
11. wire agent, order manager, position monitor, invalidation bridge
12. start Telegram bot if configured
13. bootstrap pipeline from store and enter steady-state loops

This order matters. Do not "clean up" the boot sequence casually.

## What you should see

Healthy startup usually includes:
- `COINS | ...`
- `ARMED | ...`
- exchange/account mode summary
- TUI visible in the terminal

The current branch starts an Ink terminal dashboard, not a web dashboard. You should see:
- backfill progress while candles are loading
- account, scanner, system, positions, and watchlist panels after warmup
- positions and setup state refreshing roughly once per second

### Logs

Watch for:
- `ARMED` status = required timeframes loaded and pipeline active
- `STATUS` line every 60s = system alive
- `SETUP` logs = trade setups detected
- `WARNING` with staleness = data feed issues

### Telegram bot

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, the bot should respond to commands like:
- `/help`
- `/status`
- `/positions`
- `/risk`

## Quick reference

| Command | Purpose |
|---|---|
| `bun run start` | Start live runtime |
| `bun run test:run` | Run full test suite once |
| `bun run typecheck` | Strict TS validation |
| `bun test` | Watch-mode tests |
| `docker-compose up -d` | Start DB |
| `docker-compose down` | Stop DB |
| `docker-compose logs -f` | Tail DB logs |

## Exchange notes

### Hyperliquid

- REST is weight-limited, so bootstrap/backfill goes through the repo rate limiter
- WS provides real-time updates, not full historical recovery
- Agent wallet signs orders; main account address is used for account info queries

### Bybit

- Current runtime uses one shared Bybit exchange service per process
- TUI price display uses the latest 1m candle close as the mark-price proxy in BB mode
- On shutdown in live BB mode, the runtime attempts cancel-all for open orders

## Troubleshooting

### DB won't come up

```bash
lsof -i :5432
docker-compose ps
docker-compose logs -f
```

### Startup stops with no tracked coins

- Coin selection returned an empty ranked list
- Check network access, exchange availability, and exchange-specific credentials where relevant

### TUI opens but data looks stale

- Backfill may still be running
- Later in runtime, stale-feed warnings point to feed/orderbook connectivity rather than the UI itself

### Live mode account bootstrap fails

- For `HL`, paper mode can continue without wallet bootstrap
- For `BB`, exchange bootstrap failure is treated as fatal at startup

### Telegram commands do nothing

- Confirm both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set
- The bot is optional; the runtime still works without it

## Repo map

- `src/index.ts` — thin runtime entrypoint
- `src/runtime/` — lifecycle orchestration
- `src/feed/` — HL/BB feeds, coin selection, in-memory store
- `src/strategy/` — pure setup generation and orchestration layer
- `src/agent/` — stateful trading logic and reconciliation
- `src/execution/` — exchange adapters and shared wallet pool
- `src/db/` — persistence and migrations
- `src/ui/` — terminal dashboard
- `src/backtest/` — replay, simulator, optimization, reports

For historical architecture details and older roadmap context, see `docs/archive/spec/architecture.md`.
