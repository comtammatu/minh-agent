# Minh (明) — Sprint 1.5: Scale to 30 Coins + Feed Optimization

## Goal

Scale Minh from 5 hardcoded coins to **30 dynamic coins** fetched live from Hyperliquid by OI (volume >= $500K filter). Optimize the scanner and feed layer to handle 6× the load without violating sub-10ms SLA. Add market-wide signals (`allDexsAssetCtxs` WS) to enrich Layer 4 confluence.

**No execution. No wallet. Analysis engine only.**

---

## Why 1.5 and not 2?

Sprint 2 is the autonomous trading agent. Sprint 1.5 unblocks it by:

1. Making coin selection data-driven, not hardcoded
2. Ensuring scanner SLA holds at 30 coins (required before execution layer)
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
startup → fetchTopCoins(30) from HL metaAndAssetCtxs ← dynamic, no hardcode
  topCoins: top 30 by OI, filter delisted + volume >= $500K
  trackedCoins: topCoins ∪ {coins with active setups} ← never drop mid-setup

WS tick for BTC/1m → runPipeline(BTC, 1m) only       ← incremental, per-coin
REST backfill → parallel N=20 concurrent             ← ~2.7 min (rate-limited)

allDexsAssetCtxs WS (single subscription)            ← OI + mark/oracle real-time
  → OI spike signal → Layer 4 confluence boost
  → Mark/oracle divergence → cascade risk warning
```

### Coin Lifecycle

```
fetchTopCoins(30) → topCoins
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
- Benchmark: 30 coins × 6 TFs, confirm no scan-all regression

### Definition of Done — Phase A

- [x] `runPipeline` called per-tick per-coin, not scan-all [CONFIRMED] — `onCandleTick` WS callback
- [x] `bun test --run` passes (all existing tests)
- [x] Per-coin tick routing via WS callback (not scan-all loop)

---

## Phase B: Dynamic Coin Selector

**Goal**: Replace hardcoded `COINS` constant with live top-30 from HL (volume >= $500K). Maintain `trackedCoins` to prevent mid-setup drops.

### Phase B-1: `fetchTopCoins` + config

**`src/config.ts`** — replace `COINS` constant:

```typescript
// Remove:
export const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'TAO'] as const
export type Coin = typeof COINS[number]

// Add:
export const TOP_COINS_LIMIT = 30
export const MIN_24H_VOLUME = 500_000  // $500K min daily volume
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
newTop = fetchTopCoins(TOP_COINS_LIMIT)  // 30, with volume >= $500K filter
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
2. await selector.refresh()                    ← initial top-30 fetch
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
| `test/feed/coin-selector.test.ts` | refresh: coin with active setup kept in trackedCoins despite leaving top30 |
| `test/feed/coin-selector.test.ts` | refresh fails: keeps current list, no crash |

### Definition of Done — Phase B

- [x] `COINS` constant removed from `config.ts` [CONFIRMED] — replaced with `FALLBACK_COINS`
- [x] Startup fetches top 30 from HL (volume >= $500K), no hardcoded list [CONFIRMED]
- [x] Active-setup coins never dropped during refresh [CONFIRMED] — `coin-selector.ts:113-118`
- [x] Dropped coins (no setup) properly unsubscribed + store cleared [CONFIRMED] — `index.ts:onCoinsRefreshed()`
- [x] `bun test --run` passes

---

## Phase C: REST Backfill Parallelism

**Goal**: Parallel backfill at startup to reduce 30 coins × 6 TFs from ~2 min sequential to manageable time.

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

## Phase D: Market-wide Signals (`allDexsAssetCtxs` WS)

**Goal**: Subscribe to `allDexsAssetCtxs` WS (single subscription for all coins). Extract OI spike and mark/oracle divergence signals. Feed into Layer 4 confluence.

### Implementation

Initially implemented as REST polling (30s interval, `metaAndAssetCtxs()`). Migrated to WS `allDexsAssetCtxs` — single subscription, real-time updates, saves 40 weight/min.

**`src/feed/asset-ctx.ts`**:
- `startOiFeed(coins)` — fetches `meta.universe` once for index→name mapping, subscribes to `allDexsAssetCtxs` WS
- `stopOiFeed()` — unsubscribes WS
- `getLatestAssetCtx(coin)` / `getOiDelta(coin)` / `hasDivergence(coin)` — pure getters, unchanged
- `addOiCoin(coin)` / `removeOiCoin(coin)` — dynamic tracking

**Signals**:

**OI Spike**: OI increases > 5% vs previous snapshot → `oiBoost: +0.05/+0.10`
- Computed by `oiConfirm()` pure function in `indicators/order-flow.ts`

**Mark/Oracle Divergence**: `|markPx - oraclePx| / oraclePx > 0.5%`
- `hasDivergence(coin)` → `divergenceWarning: true` in pipeline

**Config** (`src/config.ts`):
```typescript
export const OI_SPIKE_THRESHOLD = 0.05   // 5% OI increase → spike signal
export const MARK_ORACLE_DIVERGENCE_THRESHOLD = 0.005  // 0.5%
```

**Pipeline integration**:
- `confirm.ts`: `oiConfirm(oiDelta, signalSide)` → `oiBoost` in `ZoneConfirmation`
- `confluence.ts`: `+0.5 if oiBoost > 0` (OI spike confirms direction)
- `pipeline.ts`: `getOiDelta(coin)` + `hasDivergence(coin)` → `OrderFlowContext`

### Definition of Done — Phase D

- [x] `allDexsAssetCtxs` WS subscribed (single sub for all coins) [CONFIRMED]
- [x] OI spike signals in pipeline: `oiConfirm()` → `oiBoost` → confluence [CONFIRMED]
- [x] Mark/oracle divergence warning in pipeline [CONFIRMED]
- [x] `bun test --run` passes — 216 pass

---

## WS Connection Pool (conditional) — SKIPPED [CONFIRMED]

**Empirical test (2026-03-30)**: Subscribed 300 candle topics (50 coins × 6 TFs — intentionally over-provisioned vs runtime 30) on a single `SubscriptionClient`.

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
- [x] Active-setup coins never dropped during coin refresh [CONFIRMED] — `coin-selector.ts:113-118` filters via `getActiveSetupCoins()`, tested in `coin-selector.test.ts`
- [x] Scanner runs per-coin per-tick, not scan-all [CONFIRMED] — `onCandleTick` callback per WS message, no scan-all loop
- [x] Backfill completes without 429 errors [CONFIRMED] — token bucket rate limiter (`rate-limiter.ts`), all REST callers wired through `acquire()`
- [x] `activeAssetCtx` — OI spike signals in pipeline [CONFIRMED] — REST polling 30s (`asset-ctx.ts`), `oiConfirm()` pure fn, `oiBoost` in confirm→confluence→pipeline
- [x] WS pool: tested experimentally — no cap, pool not needed [CONFIRMED]
- [x] `bun test --run` passes — 216 pass, 3 skip, 0 fail (Sprint 1 + Sprint 1.5 tests)
- [ ] Live run: `[ARMED] 30 coins: all 6 TFs ready` log confirmed — [ASSUMED] code-complete, needs network verification
- [ ] STATUS line shows 30 coins with regime/grade per coin — [ASSUMED] code-complete, needs network verification

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
| `metaAndAssetCtxs` (OI poll) | ~~20 per call (every 30s = 40/min)~~ **MIGRATED** | WS `allDexsAssetCtxs` (free, real-time) |
| `l2Book` REST | 2 (cheap) | Already using WS — good |
| `allMids` REST | 2 (cheap) | Not needed — have L2 book |

**Status:** DONE — migrated to `allDexsAssetCtxs` WS (1 subscription, not per-coin). Saves 40 weight/min. Only +1 subscription (241/1000 = 24%, safe).

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

- [x] **Migrate OI poll to WS `allDexsAssetCtxs`** — DONE (Sprint 1.5 closure). 1 WS sub replaces REST polling, saves 40 weight/min.
- [x] **Add WS subscription count guard** — DONE (2026-03-30). `registerSubscription()` blocks at 1000, warns at 80%
- [ ] **Consider `bbo` over full L2 book** — if only bid/ask spread needed (lighter data)
