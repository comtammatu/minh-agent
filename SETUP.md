# Setup Guide — Minh (明) Trading Analysis Engine

Step-by-step guide to get the project running from scratch.

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

This starts a TimescaleDB container with:
- **User**: `minh`
- **Password**: `minh_dev`
- **Database**: `minh`
- **Port**: `5432`

Verify it's running:

```bash
docker-compose ps
# Should show minh-timescaledb as "Up (healthy)"
```

> Database migrations run automatically on startup (`src/index.ts` calls `runMigrations()`).

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

# Hyperliquid Agent Wallet
PRIVATE_KEY=0x...your_agent_wallet_private_key...
ACCOUNT_ADDRESS=0x...your_main_account_address...

# Logging
LOG_LEVEL=INFO

# === OPTIONAL ===

# HTTP API auth token (protects /api endpoints)
MINH_API_TOKEN=your_secret_token

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

---

## Step 4 — Run Tests

Verify everything compiles and passes:

```bash
bun test --run
```

All tests should pass. If database tests fail, ensure TimescaleDB is running (Step 2).

---

## Step 5 — Start the Engine

```bash
bun run src/index.ts
```

### Startup Sequence

The engine performs these steps automatically:

1. Run DB migrations
2. Fetch top 15 coins by Open Interest from Hyperliquid
3. Backfill historical candles (REST API) → store in DB + memory
4. Subscribe to WebSocket (live candles, trades, order book)
5. Start funding rate + OI polling
6. Initialize trading agent, order manager, position monitor
7. Start HTTP server on `http://127.0.0.1:3000`
8. Start Telegram bot (if configured)
9. Begin scanning for trade setups

You should see log output indicating each step completing. The system is ready when you see the `STATUS` line printing every 60 seconds.

---

## Step 6 — Verify Running State

### HTTP API

```bash
# Health check
curl http://127.0.0.1:3000/health

# System status (requires API token if configured)
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:3000/api/status
```

### Logs

Watch for:
- `ARMED` status = system ready to detect setups
- `STATUS` line every 60s = system alive
- `SETUP` logs = trade setups detected
- `WARNING` with staleness = data feed issues

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run src/index.ts` | Start the engine |
| `bun test` | Run tests (watch mode) |
| `bun test --run` | Run tests (single run) |
| `docker-compose up -d` | Start TimescaleDB |
| `docker-compose down` | Stop TimescaleDB |
| `docker-compose logs -f` | View DB logs |

---

## Configuration

All trading thresholds and parameters live in `src/config.ts`. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `TOP_COINS_LIMIT` | 15 | Number of coins to track (by OI) |
| `TIMEFRAMES` | 1m,5m,15m,1h,4h,1d | Candle timeframes |
| `MIN_CONFIDENCE` | 0.4 | Minimum setup confidence to alert |
| `maxRiskPerTrade` | 1% | Max risk per trade (% of account) |
| `maxConcurrentPositions` | 3 | Max open positions |
| `maxDailyLoss` | 3% | Daily loss → pause trading |
| `SERVER_PORT` | 3000 | HTTP API port |
| `PAPER_TRADE` | false | Simulate fills (no real orders) |

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

```
Hyperliquid REST (backfill) + WS (live)
           │
           ▼
   In-memory Store ──► PostgreSQL/TimescaleDB
           │
           ▼
   Scanner Pipeline (pure functions)
   Bias → Structure → Zones → Confirm → Trigger → Confluence → Regime
           │
           ▼
   Trading Agent (state machine)
           │
           ▼
   Order Manager ──► Hyperliquid Exchange API
           │
           ▼
   Position Monitor + Risk Management
           │
           ▼
   Alerts (HTTP SSE + Telegram)
```

For full architecture details, see `docs/spec/architecture.md`.
