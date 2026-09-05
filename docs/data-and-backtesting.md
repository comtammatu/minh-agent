# Data, Backtesting, And Ops

Persistence, research parity, analytics, operator surfaces. Overview: [ARCHITECTURE.md](ARCHITECTURE.md).

## Candle lifecycle

1. WS subscribe early (bootstrap buffer)
2. PG load → memory
3. REST gap-fill / backfill (bulk upsert)
4. Live write-through on persist callback

Upsert: `ON CONFLICT (coin, interval, t) DO UPDATE`. Bulk batches ~500 rows.

## Backtest / optimize

- Clear pipeline + store + params
- Replay chronologically through **`onCandleTick`**
- `TradeSimulator` consumes same setups (multi-exit or single-exit)
- `finally` always clears state — bypassing `runBacktest` risks contamination
- Async variant yields every chunk for operator-loop friendliness

## Analytics

- Matviews sourced from **journal exit** rows (migration 013+)
- `MetricsService.onTradeClose` fire-and-forget
- Advisor insights write `pattern_insight` memories; journal exits write `trade_outcome`

## Operator surfaces

| Surface | Role |
|---|---|
| Ink TUI (Body) | Primary real-time operator UI |
| Telegram (Voice) | Remote commands + Case cards (optional) |

Greenfield presence = Ink TUI + Telegram only.

## Local loop

See [WORKFLOW.md](WORKFLOW.md): `bun run start` (Ink TUI + optional Telegram).

## Blast radius

- `candle-repo` upsert semantics
- `backtest/engine` must keep production `onCandleTick` parity
- Migrations are startup-path critical

