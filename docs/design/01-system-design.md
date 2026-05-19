# 01 — System Design

Runtime architecture, data flow, boundary rules, concurrency. This document defines **what the process is** and **what it is allowed to do at each layer**.

For per-layer detail (subscriptions, persistence, reconnect), see [docs/runtime-and-feed.md](../runtime-and-feed.md), [docs/strategy-engine.md](../strategy-engine.md), [docs/agent-and-execution.md](../agent-and-execution.md), [docs/data-and-backtesting.md](../data-and-backtesting.md).

---

## Process model

- **Single process** per running instance. No fork, no worker pool, no IPC.
- **Single active exchange** chosen at startup via `ACTIVE_EXCHANGE=HL|BB`. The exchange identity is process-wide; there is no per-coin mixed-exchange runtime.
- **Single wallet / account** per process. One shared `ExchangeService` instance covers all coins.
- **Single strategy path** active: `smc-sd`. No active registry, no `strategyId` dimension at runtime. (Backtest may parametrize, live does not.)
- **Paper mode is the safe default.** `.env.example` sets `PAPER_TRADE=true`. Live execution requires explicit credentials.

The process is a long-lived event loop, not a request handler. Its inputs are exchange feeds (REST + WS) and operator commands (Telegram, HTTP). Its outputs are exchange orders, persisted journal events, and UI updates.

---

## Data flow

```text
                ┌─────────────────────────────────────────┐
                │  Hyperliquid / Bybit  (REST + WS)        │
                └────┬───────────────────────────┬────────┘
                     │                           │
                     ▼                           ▼
        ┌────────────────────┐         ┌─────────────────────┐
        │  src/feed/         │         │  src/execution/     │
        │  REST + WS         │         │  HL or BB adapter   │
        │  rate-limiter      │         │  (signing, retries) │
        └────────┬───────────┘         └──────────▲──────────┘
                 │ candles, asset ctx              │ place / cancel
                 ▼                                 │
        ┌────────────────────┐                     │
        │  in-memory store   │─── persist ───────► PostgreSQL
        │  (hot window)      │   write-through    + TimescaleDB
        └────────┬───────────┘                     ▲
                 │ getCandles(coin, tf, count)     │
                 ▼                                 │
        ┌────────────────────┐                     │
        │  src/strategy/     │                     │
        │  setup engine      │                     │
        │  (pure, zero I/O)  │                     │
        └────────┬───────────┘                     │
                 │ Setup events                    │
                 ▼                                 │
        ┌────────────────────────────────────┐    │
        │  src/agent/                         │   │
        │  TradingAgent + OrderManager +      │───┘
        │  PositionMonitor + Invalidation     │
        │  (side effects, retries, state)     │
        └────────┬─────────────┬──────────────┘
                 │             │
        journal events   ┌─────┴────────┐
                 │       ▼              ▼
                 │  Telegram         TUI (Ink) +
                 │  bot              Browser dashboard
                 ▼                   (src/server/ HTTP + WS)
            PostgreSQL
```

Backtest, optimization, and walk-forward all reuse the same strategy path. They differ only in the candle source (replay vs live store) and the execution sink (simulator vs exchange).

---

## Boundary rules

Layers are stratified by I/O permission. Violations make the system harder to test and reason about.

| Layer | Path | I/O permission | Notes |
|---|---|---|---|
| Pure indicators | `src/indicators/` | ❌ none | Pure functions, return values, never mutate inputs. Return `null` for invalid input. Golden-tested. |
| Pure strategy helpers | `src/strategy/` (most) | ❌ none | Setup detection, scoring, regime classification. Side effects belong in the orchestrator only. |
| Strategy orchestrator | `src/strategy/orchestrator.ts` | 🟡 read store | May read in-memory candle store. May NOT call REST/WS, DB, or exchange. |
| Feed | `src/feed/` | ✅ REST + WS | Network I/O boundary. Must handle timeout, 429, empty, malformed. Upsert dedup by timestamp. |
| DB | `src/db/` | ✅ PG | Connection pool, migrations, repos. No business logic. |
| Execution | `src/execution/` | ✅ exchange | Signing, rate limits, cloid management, retries. One adapter per exchange. |
| Agent | `src/agent/` | ✅ orchestrates side effects | Calls feed reads, DB writes, exchange writes. Owns state transitions. |
| Runtime | `src/runtime/` | ✅ lifecycle | Boot, reconnect, shutdown. Wires layers together. |
| UI (TUI + dashboard) | `src/ui/`, `src/server/`, `dashboard/` | ✅ read-only by default | UI does not mutate strategy/agent state. Operator commands go via Telegram or HTTP endpoint, which call into agent. |
| Telegram | `src/alert/telegram/` | ✅ network | Bot is an operator interface, not a data path. |

**Hard rule**: `try/catch` lives at I/O boundaries only (feed, DB, execution, telegram). Pure code raises through.

---

## Concurrency model

- **1 writer, N readers** for the candle store and PG.
  - WS ingest is the sole writer for hot candles.
  - REST backfill writes only during boot, finishes before steady-state.
  - Agent, dashboard, telegram, backtest are readers.
- **PG access**: connection pool from `src/db/connection.ts`. Writes are short transactions. Reads are not transactional.
- **In-process events**: function callbacks and async iterators. No external bus (no Redis pub/sub, no NATS). Adding one requires a system-design decision recorded here first.
- **No locks needed** for the candle store — single-writer, append-only by timestamp, upsert semantics.

---

## Boot order

This sequence is enforced in `src/runtime/app.ts:runRuntime()`. Reordering is a behavioral change, not cleanup.

1. **Load config** and select active exchange.
2. **Run migrations** (`src/db/migrate.ts`).
3. **Coin selection** (HL: top native perps + optional HIP-3; BB: own ranked list).
4. **WS subscribe FIRST**, before any backfill — guarantees no gap between bootstrap candles and live stream.
5. **PG load** hot window from disk.
6. **REST gap-fill** between latest PG candle and current time.
7. **Write-through persistence enabled** — only after step 6 completes.
8. **Polling**, **agent**, **TUI**, **dashboard server**, **Telegram bot** start in steady-state mode.

The TUI mounts *before* backfill finishes — it shows boot progress, then transitions to the main dashboard after `setBackfillDone()`.

---

## Failure modes

| Failure | Response |
|---|---|
| WS disconnect | Coarse-grained reconnect: tear down subscriptions, polling, Telegram, TUI; sleep; restart `runRuntime()`. |
| REST 429 | Retry with longer wait budget (`feed/rest.ts`). |
| REST 500 | Back-off + bounded retries. After exhaustion, return `null` to caller. |
| Coin has no backfill data | Drop from current round, replace from ranked list, retry bounded rounds. |
| Exchange order rejected | Logged to journal as `event_type=order_reject`. Agent decides whether to retry per policy. |
| Process crash | HL: dead-man-switch auto-cancels orders (10/day cap). BB: cancel-all on graceful shutdown only — crash can leak orders. |

See [.claude/rules/exchange-gotchas.md](../../.claude/rules/exchange-gotchas.md) for exchange-specific landmines.

---

## What the system intentionally does NOT do

These are non-goals. Do not add without first updating this section.

- **No multi-exchange in a single process.** Run two processes if you need both.
- **No multi-wallet.** One wallet per process.
- **No active strategy registry.** One concrete path. Switching the path is a code change, not a config flag.
- **No distributed mode.** No clustering, no leader election, no replication.
- **No request-handler model.** This is an event-loop daemon. HTTP server (`src/server/`) only serves the dashboard and operator endpoints; it is not the primary input surface.
- **No PWA / offline mode.** Dashboard is desktop-only. Mobile is Telegram.
