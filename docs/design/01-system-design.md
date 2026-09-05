# 01 — System Design

Process model, data flow, boundary rules, concurrency, boot.  
**Pipeline narrative SSOT:** [ARCHITECTURE.md](../ARCHITECTURE.md). This file stays the DESIGN-system companion for boundaries and non-goals.

Layer detail: [runtime-and-feed](../runtime-and-feed.md) · [strategy-engine](../strategy-engine.md) · [agent-and-execution](../agent-and-execution.md) · [data-and-backtesting](../data-and-backtesting.md).

---

## Process model

- **Single process** — no fork, worker pool, or IPC.
- **Single active exchange** — `ACTIVE_EXCHANGE=HL|BB`, process-wide.
- **Single wallet / account** — one shared execution service.
- **Single strategy path** — `minh` only at runtime.
- **Paper default** — `EXECUTION_MODE=paper`; live needs explicit mode + credentials.
- **Advisor** — deterministic `ADVISOR_MODE=off|shadow|active` (default shadow); not LLM.

Long-lived event loop. Primary inputs: exchange feeds + operator commands (Telegram / HTTP). Outputs: orders, journal, UI snapshots.

---

## Data flow (Current)

```text
Hyperliquid / Bybit (REST + WS)
        │
        ▼
  src/feed/  ──write-through──►  PostgreSQL / TimescaleDB
  in-memory hot store
        │
        ▼
  src/strategy/  (orchestrator + pure minh)
        │ Setup / invalidation events
        ▼
  src/agent/  (+ src/advisor/ gate)
  TradingAgent · OrderManager · PositionMonitor · InvalidationBridge
        │
        ├──► src/app/execution.ts (paper | HL | BB)
        ├──► journal / analytics
        └──► Ink TUI + Telegram Voice
```

Backtest / optimize / walk-forward reuse `onCandleTick` → same setups → simulator sink.

---

## Boundary rules

| Layer | Path | I/O |
|---|---|---|
| Pure indicators | `src/indicators/` | None |
| Pure strategy | most of `src/strategy/` | None |
| Orchestrator | `orchestrator.ts` | Read store only |
| Feed | `src/feed/` | REST + WS |
| DB | `src/db/` | PG |
| Execution | `src/execution/` | Exchange |
| Agent | `src/agent/` | Orchestrates side effects |
| Advisor pure | `src/advisor/stats.ts` | None; cache/job at edge |
| Runtime / UI / Telegram / server | edges | Lifecycle + operator |

`try/catch` at I/O boundaries only.

---

## Concurrency

- Candle store: **1 writer** (WS / boot REST), N readers; upsert by timestamp; no locks.
- PG: short writes; pool from `src/db/connection.ts`.
- In-process callbacks only — no Redis/NATS bus without a DESIGN decision.

---

## Boot order

Authoritative numbered list: [ARCHITECTURE.md §1](../ARCHITECTURE.md). Summary:

migrations → coins → **WS subscribe first** → TUI/dashboard → PG load → REST backfill → replay + WS flush → write-through → pool/DMS → agent wiring → advisor → pipeline subscribe → materialize → refresh + staleness.

TUI/dashboard start before backfill finishes (bootstrap phase → ready).

---

## Failure modes

| Failure | Response |
|---|---|
| WS / fatal runtime | Coarse reconnect: teardown → sleep → `runRuntime` again |
| REST 429 / 500 | Bounded retry / backoff; caller may skip coin |
| Coin zero-ready | Replace from ranked list (bounded rounds) |
| Order reject | Journal; agent policy |
| Process crash (live) | HL DMS; BB needs external watchdog |

---

## Non-goals

- Multi-exchange or multi-wallet in one process
- Runtime strategy registry / plugin fan-out
- Distributed clustering
- Request-handler-first architecture (HTTP is operator edge only)
- PWA / mobile-responsive dashboard
- Treating DESIGN 05–07 Proposed UI/API as already shipped
