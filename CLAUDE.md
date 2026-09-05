# Minh (明) — Greenfield Trading Runtime

Exchange-aware Bun trading runtime for Hyperliquid (HL) and Bybit (BB).

Live process = market data → PostgreSQL + store → **`minh`** strategy → trading agent → exchange execution → journal + memory → advisor (shadow default) → **Ink TUI (Body)** + **Telegram Voice**.

**SSOT:** this file. Entry: [AGENTS.md](AGENTS.md) → here.  
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/FEATURES.md](docs/FEATURES.md) · [docs/WORKFLOW.md](docs/WORKFLOW.md) · [docs/exchanges/](docs/exchanges/) · [docs/presence/VOICE.md](docs/presence/VOICE.md)

## Commands

```bash
bun install
bun run start              # live runtime (= bun run dev)
bun run test:run
bun run typecheck
bun run lint
bun run deadcode
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
```

## Architecture

```text
HL | BB REST + WS
  → FeedPort → store
  → orchestrator → minh → Case bus
  → Agent + advisor → ExchangePort (paper | HL | BB)
  → CrashGuard → journal
  → Presence Body (TUI) + Voice (Telegram)
```

## Layout (Greenfield target)

| Path | Purpose |
|---|---|
| `src/app/` | Composition root (boot/wire) |
| `src/ports/` | FeedPort, ExchangePort, CrashGuard, Operator, Query |
| `src/domain/` | strategy/minh, agent, advisor, case |
| `src/adapters/` | feed/hl\|bb, exchange/hl\|bb\|paper, db |
| `src/presence/` | body (TUI), voice (Telegram), gate, case-card |
| `src/research/backtest/` | Replay / optimize |
| `src/config.ts` / `src/types.ts` | Thresholds + contracts |

Legacy folders may remain during strangler migration.

## Core Constraints

- TypeScript **7.x** strict; no unjustified `any`
- Indicators / pure strategy: zero I/O
- Thresholds in `src/config.ts`
- Never commit secrets
- `bun run test:run` must pass before complete
- Commit: `<type>(<scope>): <description>`

## Runtime Invariants

- **Active exchange process-wide:** `ACTIVE_EXCHANGE=HL|BB`
- **Single strategy:** `minh` only (`CANONICAL_STRATEGY_ID`)
- **Single wallet** per process
- **Boot order** preserved (WS-first → PG → gap-fill → agent subscribe)
- **Paper default;** advisor default **shadow**
- **Operator surfaces:** Ink TUI + Telegram only (no browser dashboard)
