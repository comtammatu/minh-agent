# Setup Guide — Minh (明) Trading Runtime

Step-by-step guide to get the current branch running from scratch.

> Status note: the current repo boots a Bun runtime with PostgreSQL, exchange feeds, a TUI, Telegram commands, and backtest tooling. It does **not** currently ship the historical `src/server/` or `dashboard/` layers mentioned in older sprint docs.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Bun** | >= 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** + Docker Compose | Latest | [docker.com](https://docs.docker.com/get-docker/) |
| **Git** | >= 2.x | Pre-installed on most systems |

> **Note**: This project uses **Bun** as runtime, NOT Node.js.

---

## Step 1 — Clone & Install Dependencies

```bash
git clone <repo-url> minh-agent
cd minh-agent
bun install
```

---

## Step 2 — Start PostgreSQL + TimescaleDB

The project uses TimescaleDB (PostgreSQL extension) for time-series candle storage.

```bash
docker-compose up -d
```

This starts a PostgreSQL + TimescaleDB container with:
- **User**: `minh`
- **Password**: `minh_dev`
- **Database**: `minh`
- **Port**: `5432`

Verify it's running:

```bash
docker-compose ps
# Should show minh-timescaledb as "Up (healthy)"
```

> Database migrations run automatically on startup.

---

## Step 3 — Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# === REQUIRED ===

# Database
DATABASE_URL=postgres://minh:minh_dev@localhost:5432/minh

# Exchange selection (one exchange per process)
ACTIVE_EXCHANGE=HL

# Hyperliquid live trading
PRIVATE_KEY=0x...your_agent_wallet_private_key...
ACCOUNT_ADDRESS=0x...your_main_account_address...

# Bybit live trading (only when ACTIVE_EXCHANGE=BB)
BYBIT_API_KEY=
BYBIT_API_SECRET=

# Logging
LOG_LEVEL=INFO

# === OPTIONAL ===

# Telegram alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Paper trading (simulated fills, no real orders)
PAPER_TRADE=true
PAPER_SLIPPAGE_PCT=0.0005
```

### Getting Hyperliquid Keys

1. Go to [app.hyperliquid.xyz](https://app.hyperliquid.xyz)
2. Connect your wallet
3. Go to **Settings > API / Agent Wallets**
4. Create an **Agent Wallet** (can trade but CANNOT withdraw)
5. Copy the agent wallet private key → `PRIVATE_KEY`
6. Copy your main account address → `ACCOUNT_ADDRESS`

> **IMPORTANT**: Start with `PAPER_TRADE=true` to test without risking real funds.
> The current runtime is single-exchange per process and uses one shared live wallet per process.

---

## Step 4 — Run Tests

Verify everything compiles and passes:

```bash
bun test --run
```

All tests should pass. If database tests fail, ensure TimescaleDB is running (Step 2).

## Step 4.5 — Verify Performance Gate

This repo now treats pipeline latency as a maintained quality gate.

```bash
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
```

This should pass on a healthy local setup. CI compares against a GitHub-hosted-runner baseline, so local numbers will usually be faster.

---

## Step 5 — Start the Engine

```bash
bun run src/index.ts
```

### Startup Sequence

The runtime performs these steps automatically:

1. Run DB migrations
2. Select the active exchange and tracked coins
3. Subscribe WebSocket feeds first
4. Load candles from PostgreSQL into memory
5. Gap-fill and REST backfill missing history
6. Enable write-through candle persistence
7. Start funding or asset-context polling as needed
8. Start the TUI and health/status loops
9. Wire strategy pipeline, agent, order manager, and position monitor
10. Start Telegram bot if configured
11. Begin live scanning and management

You should see log output indicating each step completing. The system is ready when the TUI transitions out of backfill mode and the `STATUS` line begins printing every 60 seconds.

---

## Step 6 — Verify Running State

### TUI

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

### Telegram Bot

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, the bot should respond to commands like:

- `/help`
- `/status`
- `/positions`
- `/risk`

> There is no built-in HTTP `/health` or `/api/status` surface on the current branch.

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run src/index.ts` | Start the engine |
| `bun test` | Run tests (watch mode) |
| `bun test --run` | Run tests (single run) |
| `bun run typecheck` | Type-check runtime code |
| `ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci` | Run pipeline latency budget gate |
| `docker-compose up -d` | Start TimescaleDB |
| `docker-compose down` | Stop TimescaleDB |
| `docker-compose logs -f` | View DB logs |

---

## Configuration

All trading thresholds and parameters live in `src/config.ts`. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `TOP_COINS_LIMIT` | 20 | Number of native HL coins to track (by OI) |
| `TIMEFRAMES` | 1m,5m,15m,1h,4h,1d | Candle timeframes |
| `MIN_CONFIDENCE` | 0.58 | Minimum setup confidence to alert |
| `RISK_PER_POSITION` | 2% | Max equity at risk per trade |
| `ACTIVE_EXCHANGE` | HL | Exchange for this process (`HL` or `BB`) |
| `PAPER_TRADE` | true in example | Simulate fills (no real orders) |

---

## Troubleshooting

### TimescaleDB won't start
```bash
# Check if port 5432 is already in use
lsof -i :5432
# Kill conflicting process or change port in docker-compose.yml
```

### Rate limit errors from Hyperliquid
- The engine has a built-in weight-based rate limiter (`src/feed/rate-limiter.ts`)
- If you see 429 errors, the backfill is too aggressive — it should self-recover with backoff
- HL limit: 1200 weight/min per IP

### WebSocket disconnects
- Auto-reconnects with exponential backoff (1s → 30s max)
- Check internet connection and HL status at [status.hyperliquid.xyz](https://status.hyperliquid.xyz)

### Tests fail on fresh clone
```bash
# Ensure TimescaleDB is running
docker-compose up -d
# Wait for healthy status
docker-compose ps
# Re-run tests
bun test --run
```

### Agent wallet expired
- Agent wallets have an expiry — check Hyperliquid UI
- Create a new agent wallet and update `PRIVATE_KEY` in `.env`
- Never reuse deregistered agent addresses

---

## Architecture Overview

```text
Hyperliquid or Bybit REST/WS
           │
           ▼
 PostgreSQL/TimescaleDB + In-memory Store
           │
           ▼
 Strategy Orchestrator / Registry
           │
           ▼
 Trading Agent + Order Manager + Position Monitor
           │
           ├──► Exchange execution service
           ├──► Telegram operator surface
           └──► Ink TUI
```

For historical architecture details and older roadmap context, see `docs/archive/spec/architecture.md`.

Contributor workflow and CI expectations are documented in `CONTRIBUTING.md`.
