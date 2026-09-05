# Runtime And Feed

Market-data and lifecycle edge for Minh. Pipeline overview: [ARCHITECTURE.md](ARCHITECTURE.md).

## Role

- `src/index.ts` — thin entry
- `src/runtime/app.ts` — boot, reconnect, shutdown, wiring
- `src/feed/` — HL/BB REST+WS, coin selection, staleness, in-memory store

## Boot (market-data critical path)

1. Migrations + coin selection (+ HL probe)
2. **WS subscribe first** with bootstrap buffer
3. TUI + `Bun.serve` dashboard (warming)
4. PG → memory load
5. REST gap-fill/backfill; replace failed coins
6. Strategy replay hydrate; flush WS buffer via `onCandleTick`
7. Enable PG write-through; funding/OI polling
8. Rest of agent/execution wiring (see ARCHITECTURE)

Do not reorder WS-before-backfill or write-through-after-backfill.

## Store

- `src/feed/store.ts`: per exchange/coin/TF arrays, upsert by `t`, trim to `HOT_CACHE_CAP_BARS`
- Optional `setOnPersist` — runtime injects PG upsert after boot
- `getCandles` uses `slice(-count)`

## Exchange adapters

- HL: `HLFeed` + `rest.ts` / `ws.ts` + rate limiter; asset-ctx / funding / OI
- BB: thin `BybitFeed` over `bybit-rest` / `bybit-ws`; funding refresh interval; TUI may use 1m close as mark proxy

## Failure / recovery

- Empty coin list at startup → fatal
- Partial backfill → unsubscribe + replace (bounded rounds)
- REST 429/500 → retry then `null` / skip
- Reconnect → full teardown then restart loop (coarse, intentional)

## Blast radius

- `store.ts` → live scans, persistence, paper, backtests
- `app.ts` → every subsystem readiness order

## Rules

[.claude/rules/feed.md](../.claude/rules/feed.md) · [.claude/rules/exchange-gotchas.md](../.claude/rules/exchange-gotchas.md)
