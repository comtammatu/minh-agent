# Architecture — Minh (明) Greenfield

**SSOT** for how the runtime is oriented. Verify against `src/`. Archive is not requirements.

## Operating mechanism

- One Bun process = one daemon.
- `ACTIVE_EXCHANGE=HL|BB` process-wide.
- One strategy: **`minh`**.
- Safe default: `EXECUTION_MODE=paper`.
- Operator edges only: **Ink TUI (Body)** + **Telegram Bot API (Voice)**.

```text
Exchange REST + WS
  → FeedPort (HL | BB)
  → candle store + market ctx
  → orchestrator → minh → Case bus
  → Agent + advisor → ExchangePort (paper | HL | BB)
  → CrashGuard (HL DMS | BB watchdog)
  → journal / memory
  → Presence Body + Voice
```

## Layers

| Layer | Path | Rule |
|---|---|---|
| App | `src/app/` | Boot + wire only |
| Domain | `src/domain/` | strategy/minh, agent, advisor, case — no Telegram/Ink |
| Ports | `src/ports/` | FeedPort, ExchangePort, CrashGuardPort, OperatorPort, QueryPort |
| Adapters | `src/adapters/` | feed/hl, feed/bb, exchange/hl\|bb\|paper, db, telegram, tui |
| Presence | `src/presence/` | body, voice, gate, case-card |
| Research | `src/research/backtest/` | Same onCandleTick path |

Until cutover completes, legacy paths under `src/feed`, `src/execution`, `src/ui`, `src/alert` may still exist as adapters migrate.

## Presence

- **Body:** Ink TUI — monitor, Buddy mood, Case board.
- **Voice:** Telegram long-poll Bot API — Case cards, briefing, confirm → OperatorPort.
- Voice must not call OrderManager/agent singletons directly.

## Exchange ports

Domain depends on ports only. See [exchanges/HL.md](exchanges/HL.md), [exchanges/BB.md](exchanges/BB.md).

Lifecycle:

```text
feed.connect → subscribe candles+ctx → [live] exchange.init → CrashGuard.arm
shutdown → CrashGuard.disarm → cancelAll → feed.close
```

## Capabilities

**Can:** HL or BB (one), paper/live, minh setups, advisor shadow/active, TUI + Telegram ops, backtest parity.

**Cannot:** multi-exchange one process, LLM advisor, browser dashboard, second strategy.

## Boot order (invariant)

Migrations → coin select → WS subscribe → TUI → PG load → gap-fill → write-through → pool/agent → Telegram → pipeline subscribe → steady state.
