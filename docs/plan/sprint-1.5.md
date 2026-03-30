# Minh (明) — Sprint 1.5: Scale to 50 Coins + Feed Optimization

## Goal

Scale Minh from 5 hardcoded coins to **50 dynamic coins** fetched live from Hyperliquid by OI. Optimize the scanner and feed layer to handle 10× the load without violating sub-10ms SLA. Add market-wide signals (`activeAssetCtx`) to enrich Layer 4 confluence.

**No execution. No wallet. Analysis engine only.**

---

## Why 1.5 and not 2?

Sprint 2 is the autonomous trading agent. Sprint 1.5 unblocks it by:

1. Making coin selection data-driven, not hardcoded
2. Ensuring scanner SLA holds at 50 coins (required before execution layer)
3. Adding OI/funding signals that will feed into agent risk decisions

Sprint 1.5 ships before any Sprint 2 work begins.

---

## Architecture Changes

### Before (Sprint 1)

```
COINS = ['BTC','ETH','SOL','HYPE','TAO'] as const   ← hardcoded
WS tick → runPipeline(ALL 5 coins × ALL 6 TFs)       ← scan-all per tick
REST backfill → sequential per coin/TF               ← slow startup
```

### After (Sprint 1.5)

```
startup → fetchTopCoins(50) from HL metaAndAssetCtxs ← dynamic, no hardcode
  topCoins: top 50 by OI, filter delisted
  trackedCoins: topCoins ∪ {coins with active setups} ← never drop mid-setup

WS tick for BTC/1m → runPipeline(BTC, 1m) only       ← incremental, per-coin
REST backfill → parallel N=20 concurrent             ← fast startup (~5s)

activeAssetCtx WS per coin                           ← OI + funding real-time
  → OI spike signal → Layer 4 confluence boost
  → Funding squeeze signal → bias confirmation
```

### Coin Lifecycle

```
fetchTopCoins(50) → topCoins
                         ↓
              ┌──────────┴───────────┐
              │                     │
     coin in topCoins         coin leaves topCoins
              │                     │
        subscribe +          has active setup?
        backfill             ├── YES → keep tracking (trackedCoins)
                             └── NO  → unsubscribe + store cleanup
```

---

## Phase A: Scanner Incremental

**Goal**: Refactor `runPipeline` from scan-all to scan per-coin/per-TF on each WS tick.

### Current behavior

```typescript
// index.ts — called on EVERY WS candle tick
for (const coin of COINS) {
  for (const tf of TIMEFRAMES) {
    runPipeline(coin, tf)   // 5 × 6 = 30 calls per tick
  }
}
```

### Target behavior

```typescript
// index.ts — called ONLY for the coin/TF that received a new candle
subscribeCandles(coin, interval, (coin, interval, candle) => {
  appendCandle(coin, interval, candle)
  runPipeline(coin, interval)  // 1 call per tick
})
```

### Changes

**`src/index.ts`**:
- Move `runPipeline(coin, tf)` call inside the `onCandle` callback
- Remove the outer `for (const coin of COINS)` loop triggered per tick
- `runPipeline` is now called exactly once per new candle, for that coin/TF only

**`src/scanner/pipeline.ts`**:
- No structural changes needed — already accepts `(coin, interval)` params
- Verify: pipeline does not iterate coins internally

**Tests**:
- `test/pipeline.test.ts` — verify single-coin invocation behavior unchanged
- Benchmark: 50 coins × 6 TFs, confirm no scan-all regression

### Definition of Done — Phase A

- [ ] `runPipeline` called per-tick per-coin, not scan-all
- [ ] `bun test --run` passes (all existing tests)
- [ ] Console log confirms: `[TICK] BTC 1m → pipeline` (not 50 lines per tick)

---

## Phase B: Dynamic Coin Selector

**Goal**: Replace hardcoded `COINS` constant with live top-50 from HL. Maintain `trackedCoins` to prevent mid-setup drops.

### Phase B-1: `fetchTopCoins` + config

**`src/config.ts`** — replace `COINS` constant:

```typescript
// Remove:
export const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'TAO'] as const
export type Coin = typeof COINS[number]

// Add:
export const TOP_COINS_LIMIT = 50
export const COIN_REFRESH_INTERVAL_MS = 3_600_000  // 1h
export type Coin = string
```

**`src/feed/coin-selector.ts`** — new file, pure fetch function + stateful selector:

```typescript
/**
 * Fetch top N coins from HL ranked by open interest.
 * Filters delisted coins. Returns string[] sorted OI desc.
 * Returns [] on error (caller falls back to current list).
 */
export async function fetchTopCoins(limit: number): Promise<string[]>

/**
 * Stateful coin selector.
 * topCoins: latest top N from HL (refreshed every COIN_REFRESH_INTERVAL_MS)
 * trackedCoins: topCoins ∪ {coins with active setups} — never drops mid-setup
 */
export interface CoinSelector {
  getTopCoins(): string[]
  getTrackedCoins(): string[]
  refresh(): Promise<void>   // fetch new topCoins, diff vs current, return {added, dropped}
  startRefreshLoop(): void
  stopRefreshLoop(): void
}

export function createCoinSelector(
  getActiveSetupCoins: () => string[],   // injected — scanner tells us what's active
): CoinSelector
```

Key logic in `refresh()`:
```
newTop = fetchTopCoins(TOP_COINS_LIMIT)
added  = newTop - currentTracked          → subscribe + backfill
dropped = currentTop - newTop             → check active setups
  hasActiveSetup(coin) → keep in trackedCoins
  noActiveSetup(coin)  → unsubscribe + clearStore(coin)
currentTop = newTop
```

**`src/scanner/pipeline.ts`** — export `getActiveCoins()`:
```typescript
export function getActiveSetupCoins(): string[]  // coins with at least 1 active setup
```

### Phase B-2: Startup + refresh wiring

**`src/index.ts`**:
```
1. createCoinSelector(getActiveSetupCoins)
2. await selector.refresh()                    ← initial top-50 fetch
3. backfill all trackedCoins (parallel)
4. subscribe WS for all trackedCoins
5. selector.startRefreshLoop()                 ← refresh every 1h
   on refresh: subscribe new coins, unsubscribe dropped (no active setup)
```

**Error handling**:
- `fetchTopCoins` fails at startup → throw (cannot start without coin list)
- `fetchTopCoins` fails during refresh → log WARNING, keep current list, retry next interval
- Coin added mid-run → backfill then subscribe (gap between backfill and subscribe is acceptable, WS fills it)

### Tests — Phase B

| File | Cases |
|---|---|
| `test/feed/coin-selector.test.ts` | fetchTopCoins mock: sorted by OI, delisted filtered, error→[] |
| `test/feed/coin-selector.test.ts` | refresh: added coins detected, dropped coins with no setup unsubscribed |
| `test/feed/coin-selector.test.ts` | refresh: coin with active setup kept in trackedCoins despite leaving top50 |
| `test/feed/coin-selector.test.ts` | refresh fails: keeps current list, no crash |

### Definition of Done — Phase B

- [ ] `COINS` constant removed from `config.ts`
- [ ] Startup fetches top 50 from HL, no hardcoded list
- [ ] Active-setup coins never dropped during refresh
- [ ] Dropped coins (no setup) properly unsubscribed + store cleared
- [ ] `bun test --run` passes

---

## Phase C: REST Backfill Parallelism

**Goal**: Parallel backfill at startup to reduce 50 coins × 6 TFs from ~2 min sequential to ~5-10s.

### Current: sequential

```typescript
// O(coins × TFs) sequential = 300 REST calls × 0.5s avg = 150s
for (const coin of COINS) {
  for (const tf of TIMEFRAMES) {
    await fetchCandles(coin, tf, startTime)
  }
}
```

### Target: parallel with concurrency cap

```typescript
// Parallel N=20, respect rate limit 800 req/min
// Priority: small TFs first (1m/5m) → scanner starts earlier
// 300 calls ÷ 20 concurrent × ~0.3s avg = ~5s
await backfillAllCoins(coins, { concurrency: 20 })
```

**`src/feed/rest.ts`** — add:
```typescript
export async function backfillAllCoins(
  coins: string[],
  options: { concurrency: number }
): Promise<void>
// Uses a semaphore/queue — at most N concurrent fetchCandles at any time
// TF order: ['1m','5m','15m','1h','4h','1d'] — small TFs first
// On failure: log + skip (don't block other coins)
```

**Config**:
```typescript
export const BACKFILL_CONCURRENCY = 20
```

### Tests — Phase C

| File | Cases |
|---|---|
| `test/feed/backfill.test.ts` | Concurrency cap respected (mock: count simultaneous calls) |
| `test/feed/backfill.test.ts` | TF priority order: 1m before 1d |
| `test/feed/backfill.test.ts` | Single coin failure doesn't block others |

### Definition of Done — Phase C

- [x] Backfill completes without 429 errors (rate limiter: burst 45 + 1 req/1.2s sustained)
- [x] Concurrency cap enforced — token bucket prevents bursts
- [x] `bun test --run` passes

---

## Phase D: Market-wide Signals (`activeAssetCtx`)

**Goal**: Subscribe to `activeAssetCtx` WS per coin. Extract OI spike and funding squeeze signals. Feed into Layer 4 confluence.

### What `activeAssetCtx` provides (per coin, real-time)

```typescript
{
  openInterest: string      // total OI in USD
  markPx: string            // mark price
  oraclePx: string          // oracle price
  funding: string           // current funding rate
  premium: string           // mark/oracle divergence
}
```

### New signals

**OI Spike**: OI increases > threshold vs previous snapshot
- Long setup + OI spike → bullish momentum confirmation → `oiBoost: +0.10`
- Short setup + OI spike → bearish momentum confirmation → `oiBoost: +0.10`

**Funding Squeeze**: funding rate extreme (positive extreme + long setup = warning; negative extreme + short setup = warning)
- Funding extreme aligned with setup → `fundingBoost: +0.05` (contrarian confirmation)
- Already partially handled by `fundingConfirm()` in order-flow.ts — extend, don't duplicate

**Mark/Oracle Divergence**: `|markPx - oraclePx| / oraclePx > threshold`
- Large divergence → potential cascade risk → `divergenceWarning: true` in signal

### Changes

**`src/types.ts`** — add:
```typescript
interface AssetCtxSnapshot {
  coin: string
  openInterest: number
  markPrice: number
  oraclePrice: number
  funding: number
  premium: number
  timestamp: number
}
```

**`src/feed/asset-ctx.ts`** — new file:
```typescript
export function subscribeAssetCtx(coin: string): Promise<void>
export function getLatestAssetCtx(coin: string): AssetCtxSnapshot | null
export function getOiDelta(coin: string): number | null  // % change vs previous snapshot
```

**`src/config.ts`** — add:
```typescript
export const OI_SPIKE_THRESHOLD = 0.05   // 5% OI increase → spike signal
export const MARK_ORACLE_DIVERGENCE_THRESHOLD = 0.005  // 0.5%
```

**`src/scanner/layers/confirm.ts`** — extend `OrderFlowContext`:
```typescript
interface OrderFlowContext {
  delta?: DeltaState
  book?: OrderBookSnapshot
  funding?: FundingSnapshot
  assetCtx?: AssetCtxSnapshot   // NEW
  signalSide?: 'long' | 'short'
}
```
Add `oiBoost` and `divergenceWarning` to `ZoneConfirmation`.

**`src/scanner/confluence.ts`** — update scoring:
```
+0.5 if oiBoost > 0    (OI spike confirms direction)
```

### Tests — Phase D

| File | Cases |
|---|---|
| `test/feed/asset-ctx.test.ts` | null contract, snapshot stored, OI delta computed |
| `test/feed/asset-ctx.test.ts` | OI spike: delta > threshold → spike detected |
| `test/layers/confirm.test.ts` | +3 tests: oiBoost applied, divergenceWarning set, no ctx → base score |

### Definition of Done — Phase D

- [ ] `activeAssetCtx` subscribed per coin alongside candles
- [ ] OI spike visible in SETUP log: `OI(+0.10)`
- [ ] `bun test --run` passes

---

## WS Connection Pool (conditional) — SKIPPED [CONFIRMED]

**Empirical test (2026-03-30)**: Subscribed 300 candle topics (50 coins × 6 TFs) on a single `SubscriptionClient`.

**Results**:
- 300/300 subscriptions: **0 errors**
- 1,626 candle events received in 90s
- 44/50 coins received events (264/300 topics active)
- 6 missing coins (HMSTR, BLAST, NOT, RSR, PURR, SAGA) are low-volume ($10K-$237K daily), no trades during test window — not a cap issue
- All 6 TFs uniformly received 44/50 coins — no TF-dependent drop

**Verdict**: HL handles 300+ subscriptions on one connection. **No WS pool needed.**

Test script preserved at `scripts/test-ws-cap.ts` for re-verification.

---

## Session Roadmap

| Session | Phase | Task | Est. |
|---|---|---|---|
| S1 | B-1 | `fetchTopCoins` + `CoinSelector` + config | 30-40 min |
| S2 | B-2 | Startup wiring + refresh loop + subscribe/unsubscribe | 30-40 min |
| S3 | C | Parallel backfill with concurrency cap | 25-35 min |
| S4 | D | `activeAssetCtx` feed + OI/divergence signals | 30-40 min |
| S5 | — | WS pool (conditional on cap test) | 25-35 min |

Phase A (scanner incremental) was already implemented in Sprint 1 — `onCandleTick` routes per-coin/per-TF via WS callback. Removed from roadmap.

**Total: 4-5 sessions, ~2.5-3.5 hours estimated**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | DONE | 2026-03-30 | fetchTopCoins + CoinSelector + config. Phase A skipped (already done). 192 tests pass. |
| S2 | DONE | 2026-03-30 | CoinSelector wired into index.ts. Per-coin unsub in ws/trades/orderbook/funding. Dynamic subscribe/unsubscribe on refresh. /review: fixed fallback bug + duplicate import. 192 tests pass. |
| S3 | DONE | 2026-03-30 | Parallel backfill with concurrency cap (20). TF priority 1m→1d. Failure isolation per coin. BackfillResult type. 197 tests pass (+5 new). /review clean. |
| S4 | DONE | 2026-03-30 | Phase D: asset-ctx REST polling (30s), OI spike + divergence signals. oiConfirm pure fn (+0.05/+0.10). OI boost in confirm→confluence→pipeline (+0.5 weight). 214 tests pass (+17 new). /review clean (1 informational: side param unused in oiConfirm). |
| S5 | DONE | 2026-03-30 | WS cap test: 300/300 subs, 0 errors, 1626 events in 90s. No cap detected → WS pool SKIPPED. Test script at scripts/test-ws-cap.ts. |

---

## Definition of Done

Sprint 1.5 is complete when:

- [x] `COINS` hardcode removed — top 30 fetched from HL on startup (volume >= $500K filter)
- [ ] Active-setup coins never dropped during coin refresh
- [ ] Scanner runs per-coin per-tick, not scan-all
- [ ] Backfill completes without 429 errors (HL weight limit: ~2.7 min for 30 coins)
- [ ] `activeAssetCtx` subscribed — OI spike visible in SETUP logs
- [x] WS pool: tested experimentally — no cap, pool not needed [CONFIRMED]
- [ ] `bun test --run` passes — all Sprint 1 tests + new Sprint 1.5 tests
- [ ] Live run: `[ARMED] 50 coins: all 6 TFs ready` log confirmed
- [ ] STATUS line shows 50 coins with regime/grade per coin

## Post-Sprint Fix: REST Rate Limiter (2026-03-30)

Live run with 30 coins exposed heavy 429 errors during backfill. Root cause:

**HL REST rate limit is weight-based** (1200 weight/min per IP), not simple request count.
- Info requests: weight 20 each
- `candleSnapshot`: weight 20 + extra per 60 items returned
- `fundingHistory`: weight 20 + extra per 20 items returned
- Effective: ~45 burst + ~1 req/1.2s sustained

**Fix applied:**
- `src/feed/rate-limiter.ts`: Token bucket — burst 45 tokens + even-spaced queue at 1 req/1.2s. Tokens refill at 1/1.2s.
- `src/config.ts`: `REST_BURST_TOKENS=45`, `REST_REFILL_MS=1200`
- All REST callers wired through `acquire()`: rest.ts, funding.ts, asset-ctx.ts, coin-selector.ts
- `selector.refresh(true)` skips callback at startup → uses efficient batch path in `main()`
- Startup backfill (180 requests) now takes ~2.7 min — expected, not a bug
- Source: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

**DoD update:** "50-coin backfill completes in < 30s" → revised to "backfill completes without 429 errors (~2.7 min for 30 coins)"

---

## HL API Audit Notes (2026-03-30)

Full audit of Hyperliquid docs vs current codebase. Items noted for future sprints.

### REST Weight Optimization

| Endpoint | Current weight | Alternative |
|---|---|---|
| `metaAndAssetCtxs` (OI poll) | 20 per call (every 30s = 40/min) | WS `activeAssetCtx` per coin (free) |
| `l2Book` REST | 2 (cheap) | Already using WS — good |
| `allMids` REST | 2 (cheap) | Not needed — have L2 book |

**Recommendation:** Migrate OI polling to WS `activeAssetCtx` subscription. Saves 40 weight/min. Trade-off: +30 subscriptions (270/1000 = 27%, safe).

### WS Limits to Track

| Limit | Value | Current usage | Status |
|---|---|---|---|
| Max subscriptions | 1000 | 240 (30 coins × 8 feeds) | Safe (24%) — no guard |
| Max connections | 10 | 1 | Safe |
| New connections/min | 30 | 1 (reconnect only) | Safe |
| Messages to platform/min | 2000 | ~240 subscribes at startup | Safe |

**Recommendation:** Add subscription count guard in `registerSubscription()` if scaling past 100 coins.

### Unused WS Feeds (potential value)

| Feed | Benefit | Subscriptions cost |
|---|---|---|
| `activeAssetCtx` per coin | Real-time OI/mark/oracle — replaces REST polling | +30 (270 total) |
| `bbo` per coin | Best bid/offer only — lighter than full L2 | Replaces l2Book (same count) |
| `allMids` (global) | All mid prices in 1 subscription | +1 |
| `allDexsAssetCtxs` (global) | All asset contexts in 1 subscription | +1 (replaces per-coin) |

**Key finding:** `allDexsAssetCtxs` WS subscription sends ALL coins' asset context in a single subscription — could replace both per-coin `activeAssetCtx` AND the REST `metaAndAssetCtxs` polling. Only costs 1 subscription slot.

### Not Needed

- **HL MCP Server**: Does not exist in registry. Not needed — `@nktkas/hyperliquid` SDK covers all endpoints directly.
- **Pagination for candleSnapshot**: `BACKFILL_CANDLE_COUNT=5000` matches API max. Older coins may have fewer candles — handled gracefully (returns what's available).

---

## Carried to Sprint 2

These items are out of scope for Sprint 1.5 and picked up in Sprint 2:

- `clearinghouseState`, `userFills`, `userFillsByTime`, `openOrders` — address-level data for when Minh trades real positions
- `userEvents` WS, `orderUpdates` WS — real-time order/fill tracking for execution layer
- TimescaleDB candle persistence (Sprint 2 infrastructure)

## Carried to Future Sprint (Feed Optimization)

From HL API audit (2026-03-30):

- [ ] **Migrate OI poll to WS `allDexsAssetCtxs`** — 1 subscription replaces REST polling (saves 40 weight/min)
- [ ] **Add WS subscription count guard** — prevent exceeding 1000 limit if scaling past 100 coins
- [ ] **Consider `bbo` over full L2 book** — if only bid/ask spread needed (lighter data)
