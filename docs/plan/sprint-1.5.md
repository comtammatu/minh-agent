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

- [ ] 50 coins backfill completes in < 30s on good connection
- [ ] Concurrency cap enforced — no rate limit bursts
- [ ] `bun test --run` passes

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

## WS Connection Pool (conditional)

**Do first**: manually test HL subscription cap — subscribe 300 topics (50 coins × 6 TFs) on a single `SubscriptionClient`, observe if HL silently drops or errors.

**If HL allows 300+ subscriptions on one connection** → no pool needed. Skip this section entirely.

**If HL has a cap** (observed experimentally) → implement:

```typescript
// src/feed/ws-pool.ts
export function createWsPool(maxPerConnection: number): WsPool
// Distributes subscriptions evenly across N connections
// Reconnect per-connection independently
// Coin A on connection 1 drop → re-backfill coin A only, not all 50
```

This is gated on empirical test. Do not implement speculatively.

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

---

## Definition of Done

Sprint 1.5 is complete when:

- [ ] `COINS` hardcode removed — top 50 fetched from HL on startup
- [ ] Active-setup coins never dropped during coin refresh
- [ ] Scanner runs per-coin per-tick, not scan-all
- [ ] 50-coin backfill completes in < 30s
- [ ] `activeAssetCtx` subscribed — OI spike visible in SETUP logs
- [ ] WS pool: tested experimentally, implemented if needed
- [ ] `bun test --run` passes — all Sprint 1 tests + new Sprint 1.5 tests
- [ ] Live run: `[ARMED] 50 coins: all 6 TFs ready` log confirmed
- [ ] STATUS line shows 50 coins with regime/grade per coin

## Carried to Sprint 2

These items are out of scope for Sprint 1.5 and picked up in Sprint 2:

- `clearinghouseState`, `userFills`, `userFillsByTime`, `openOrders` — address-level data for when Minh trades real positions
- `userEvents` WS, `orderUpdates` WS — real-time order/fill tracking for execution layer
- TimescaleDB candle persistence (Sprint 2 infrastructure)
