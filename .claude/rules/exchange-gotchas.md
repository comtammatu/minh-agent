---
paths: src/execution/**/*.ts, src/feed/**/*.ts
---
# Exchange Gotchas (HL + Bybit)

Single source of truth for exchange-specific landmines. Anything that's "obvious from the SDK" but actually wrong in practice lives here.

## Hyperliquid

### Numerics
- All numeric values from the SDK are strings — `parseFloat()` everywhere
- Asset ID is the index from `meta.universe`, NOT the coin name

### REST rate limits (weight-based, 1200 weight/min per IP)
- `info` = 20 weight
- `candleSnapshot` = 20 + ceil(items / 60) surcharge — 500 candles ≈ 29w, 5000 candles ≈ 104w
- `l2Book` / `allMids` / `clearinghouseState` / `orderStatus` = 2 weight
- `exchange` = 1 weight
- ALL REST callers MUST go through `feed/rate-limiter.ts`. Direct `fetch` to HL REST is a bug.

### Candle history
- Max 5000 per request
- Per-TF backfill counts in config `BACKFILL_CANDLE_COUNTS`: 500 for 1m/5m, 5000 for 15m+
- WS is real-time only — history comes from REST/PG bootstrap, never WS replay

### Address rate limit (separate from IP)
- 1 request per 1 USDC cumulative traded volume
- Initial buffer 10K requests
- Stale `expiresAfter` cancels cost **5× weight** — don't spam cancels with old timestamps

### Order precision
- Prices: max 5 significant figures + `(6 - szDecimals)` decimals
- Sizes: rounded to `szDecimals`
- Remove trailing zeroes before submit
- Minimum order value: $10

### Signing
- Two schemes: `l1_action` vs `user_signed_action`. Field order matters.
- Addresses MUST be lowercase
- Wrong signature → opaque "missing wallet" error
- Use the SDK. Do NOT hand-roll signing.

### Agent wallet vs main account
- Bot signs with **agent wallet PK** (`PRIVATE_KEY` env)
- Bot queries account info with **main account address** (`ACCOUNT_ADDRESS` env)
- Agent wallet CAN trade, CANNOT withdraw
- Nonces tracked per agent address

### Unified account balance
- Balance lives in **spot** (`spotClearinghouseState`), not perp (`clearinghouseState`)
- `getAccountState()` queries both and returns `effectiveBalance = perp + spot USDC`
- Don't read perp clearinghouse alone and assume that's wallet balance

### Open Interest cap
- Some assets are at OI cap → cannot open new positions
- Check `perpsAtOpenInterestCap()` before placing

### Dead man's switch
- `scheduleCancel(timestamp)` auto-cancels all orders after `timestamp`
- Max 10 schedule updates per day
- Critical for bot safety on crash/disconnect — keep it armed

### WS limits
- 1000 subscriptions per connection
- 10 connections per IP
- 2000 messages/min per connection
- Subscription budget scales with dynamic coin count × per-coin feeds — see `feed/hl/ws-subscriber.ts`

## Bybit

### Feed differences from HL
- **No separate mark-price stream** in the current runtime
- TUI uses the latest 1m candle close as the price proxy on BB
- Treat this as a known limitation, not a bug

### Safety
- **No native dead man's switch** like HL's `scheduleCancel`
- Current runtime attempts cancel-all on graceful shutdown in live BB mode
- Crash/SIGKILL during a live BB session can leave orders open — don't assume parity with HL safety semantics
