---
paths: src/feed/**/*.ts
---
# Feed Rules (I/O Boundary)

Feed code is the market-data I/O boundary (REST, WebSocket, stream coordination). Other side effects still live at the runtime, execution, Telegram, DB, and UI edges.

## Invariants
- Error handling REQUIRED: timeout, 429 rate limit, empty response, malformed data
- Store upserts by timestamp (candle dedup — WS may resend the same `t` as REST bootstrap)
- Staleness watchdog: track `lastCandleTime` per `coin/tf`; WARNING after configured silence window
- `getCandles(coin, tf, count)` uses `arr.slice(-count)` — O(count), not a full scan
- HL REST goes through `feed/rate-limiter.ts`. No direct `fetch` to HL endpoints.

## Hot store
- In-memory store is authoritative for the **hot window** only
- Cold history lives in PG; runtime loads PG first, then REST gap-fills, then live WS appends
- Write-through to PG is enabled AFTER backfill, not during

## Staleness vs silence
- A quiet feed is not the same as a dead feed — checks fire on intervals
- Stale data WARNS; never silently trust a dead stream

## See also
- Pipeline SSOT: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- Deep dive: [docs/runtime-and-feed.md](../../docs/runtime-and-feed.md)
- HL/BB landmines: [exchange-gotchas.md](exchange-gotchas.md)
- Quality gates: [quality-gates.md](quality-gates.md)
