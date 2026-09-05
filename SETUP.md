# Setup Guide — Minh (明)

Single Bun process with:
- one active exchange (`HL` or `BB`)
- PostgreSQL/TimescaleDB
- Ink TUI (Body)
- optional Telegram (Voice)

Canonical local loop: [docs/WORKFLOW.md](docs/WORKFLOW.md). Pipeline: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Features: [docs/FEATURES.md](docs/FEATURES.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Bun | >= 1.3.14 | Runtime + tests |
| Docker Compose | recent | Local TimescaleDB |
| Git | recent | Clone + workflow |

## 1. Install

```bash
git clone <repo-url> minh-agent
cd minh-agent
bun install
```

## 2. Database

```bash
docker-compose up -d
docker-compose ps
```

Container: `minh-timescaledb` — user `minh` / password `minh_dev` / db `minh` / port `5432`.

Migrations run on process start via `runMigrations()`.

## 3. Environment

```bash
cp .env.example .env
```

Minimum safe `.env`:

```env
DATABASE_URL=postgres://minh:minh_dev@localhost:5432/minh
LOG_LEVEL=INFO
ACTIVE_EXCHANGE=HL
EXECUTION_MODE=paper
# ADVISOR_MODE=shadow
```

### Live credentials (only when `EXECUTION_MODE=live`)

Hyperliquid:

```env
PRIVATE_KEY=0x...
ACCOUNT_ADDRESS=0x...
```

Bybit:

```env
ACTIVE_EXCHANGE=BB
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
```

Optional Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

Notes:
- Prefer `EXECUTION_MODE` over legacy `PAPER_TRADE`
- `ACTIVE_EXCHANGE` is process-wide

## 4. Verify

```bash
bun run typecheck
bun run test:run
```

## 5. Start

```bash
bun run start
# alias: bun run dev
```

## Startup sequence

`src/index.ts` → `src/app/boot.ts` → `src/runtime/app.ts`:

1. wire Greenfield ports (feed, exchange, crashGuard, operator)
2. choose exchange + coin selector
3. DB migrations
4. ranked coins
5. websocket subscribe
6. start Ink TUI (Body)
7. load PG candles → memory
8. REST gap-fill/backfill
9. PG write-through
10. funding/OI polling
11. exchange pool + CrashGuard (DMS)
12. agent / orders / positions / invalidation bridge
13. advisor (if not off)
14. Telegram Voice if configured
15. pipeline bootstrap → steady state

Do not casually reorder this.

## Healthy signals

- `COINS | …`, `ARMED | …`
- Ink TUI visible in terminal
- `STATUS` every ~60s; `SETUP` on detections

Telegram (if configured): `/help`, `/status`, `/positions`, `/risk`, `/advisor`

## Commands

| Command | Purpose |
|---|---|
| `bun run start` / `dev` | Full runtime |
| `bun run test:run` | Full tests |
| `bun run typecheck` | Strict TS 7.x |
| `docker-compose up -d` | Start DB |

## Troubleshooting

**DB down:** `docker-compose ps` / `docker-compose logs -f`

**No coins:** network / exchange / credentials

**Stale TUI:** backfill still running, or feed staleness later

**Live bootstrap fails:** HL paper can continue without wallet; BB live bootstrap failure is fatal

**Telegram silent:** both token and chat id required; bot is optional

## Repo map

See [CLAUDE.md](CLAUDE.md) and [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).
