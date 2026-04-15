---
paths: src/feed/**/*.ts
---
# Feed Rules (I/O Boundary)

- Feed code is the market-data I/O boundary (REST, WebSocket, stream coordination)
- Other side effects still live at the runtime, execution, Telegram, DB, and UI edges
- Error handling required: timeout, 429 rate limit, empty response, malformed data
- Store upserts by timestamp (candle dedup — WS may resend same timestamp as REST)
- Staleness watchdog: track `lastCandleTime` per coin/tf, WARNING after 60s silence
- `getCandles(coin, tf, count)` uses `arr.slice(-count)` — O(count), no full scan
