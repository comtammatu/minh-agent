# Features — Minh (明) Greenfield

**Current.** Verify against `src/` before treating `docs/archive/` as implemented.

## Runtime

| Feature | Status | Notes |
|---|---|---|
| Single-process Bun runtime | Live | `bun run start` → composition root |
| Active exchange `HL` \| `BB` | Live | Process-wide; one exchange per process |
| Paper / live execution | Live | `EXECUTION_MODE=paper` (default) or `live` |
| PostgreSQL + TimescaleDB | Live | Hybrid in-memory hot store + PG |
| Dynamic coin selection | Live | HL / BB selectors |
| WS-first boot → PG → gap-fill | Live | Do not reorder casually |
| Strategy **`minh`** (only) | Live | Canonical id `"minh"` (renamed from `minh`) |
| Trading agent + orders + positions | Live | Journal + reconcile + DMS/watchdog |
| Deterministic advisor | Live | `ADVISOR_MODE=off\|shadow\|active` (default **shadow**) |
| Trade memory | Live | `trade_outcome`, `pattern_insight` |

## Operator surfaces (Presence)

| Surface | Role | Notes |
|---|---|---|
| **Ink TUI (Body)** | Local realtime presence | Buddy + Case board; monitor |
| **Telegram Bot API (Voice)** | Remote/mobile | Case cards, alerts, confirm-gated control |

No browser dashboard / PWA / Mini App.

## Research / offline

| Feature | Status |
|---|---|
| Backtest / optimize / walk-forward | Live — same `onCandleTick` / `minh` path |
| Pipeline latency bench + CI | Live |

## Explicitly removed (Greenfield)

- Browser dashboard SPA / Bun.serve operator UI
- LLM / RAG advisor, embeddings
- Multi-exchange or multi-wallet in one process
- Strategy plugin registry / second strategy
- DESIGN Proposed Bloomberg / SSE / JWT

## Docs

| Doc | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Pipeline + Presence + ports |
| [exchanges/HL.md](exchanges/HL.md) | Hyperliquid Keep surface |
| [exchanges/BB.md](exchanges/BB.md) | Bybit Keep surface |
| [WORKFLOW.md](WORKFLOW.md) | Local loop |
| [TODOS.md](../TODOS.md) | Active backlog |
