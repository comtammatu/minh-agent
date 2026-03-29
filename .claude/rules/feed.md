---
paths: src/feed/**/*.ts
---
# Feed Rules (I/O Boundary)

- This is the ONLY place with side effects (REST, WebSocket, console)
- Error handling required: timeout, 429 rate limit, empty response, malformed data
- Store upserts by timestamp (candle dedup — WS may resend same timestamp as REST)
- Staleness watchdog: track `lastCandleTime` per coin/tf, WARNING after 60s silence
- `getCandles(coin, tf, count)` uses `arr.slice(-count)` — O(count), no full scan