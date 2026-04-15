# Minh (明) — Sprint 1: Layered Analysis Engine

> Archive note (2026-04-15): historical sprint plan only. The current branch no longer uses this file as the implementation source of truth; see `README.md` and the active docs in `docs/`.

## Goal

Refactor the flat 8-detector scanner into a **Layered Decision Framework**: 5 layers tuần tự + regime context song song. Add HTF cross-reference, Order Flow data (Funding + Trades + L2 Book), confluence scoring, and risk filtering.

**No trading. No wallet. No HTTP server. Read-only analysis with layered pipeline.**

## Prerequisites

- Bun >= 1.0
- Internet connection (HL mainnet API)
- Tue source code at `~/Downloads/Personal/gettueapp/` (reference for golden test fixtures)

## Architecture

```
WS candle tick (closed-candle gate)
  │
  ├── Readiness Gate: all TFs backfilled? → if not, skip
  │
  ├─────────────────────────────┐
  │                             │
  ▼                             ▼
REGIME CONTEXT (parallel)  LAYER 1: BIAS
  detectRegime()             Wyckoff phase + SMC BOS/CHoCH + HTF query
  → BULL/BEAR/SIDE/VOL       → bias = long | short | neutral
  (modulate confidence)       neutral → STOP
  │                             │
  │                             ▼
  │                        LAYER 2: STRUCTURE
  │                          PA classifySwings + structural bias
  │                          → confirm | neutral | deny
  │                          deny → STOP
  │                             │
  │                             ▼
  │                        LAYER 3: ZONES
  │                          SMC OB/FVG + S&D key zones
  │                          filtered by bias direction
  │                          empty → STOP
  │                             │
  │                             ▼
  │                        LAYER 4: VOLUME CONFIRM
  │                          VSA signals + VP levels + Delta + Book
  │                          → boost/penalty per zone
  │                             │
  │                             ▼
  │                        LAYER 5: TRIGGER
  │                          PA candlestick patterns at zone
  │                          no pattern → null (zone waits)
  │                             │
  │                             ▼
  └──────────────────────► CONFLUENCE + REGIME + RISK
                              grade C → skip, B/A/A+ → alert
                              risk filter: zone distance → size/RR
                              regime modifier: ×1.0/×0.8/×0.3
                                │
                                ▼
                           TRACK + ALERT + INVALIDATE
```

---

## Phase A: Layered Pipeline (OHLCV only)

### Step 0: Pre-implementation ✅ DONE (2026-03-29)

```bash
git init && git add -A && git commit -m "chore: initial commit — flat architecture baseline"
```

- [x] Sync `docs/archive/ref/domain-knowledge.md` — sections 11+12 already present (verified 2026-03-30)
- [x] Export `classifySwings`, `detectStructuralBias`, `compileKeyZones` from `indicators/structure.ts` ← Done in Step 1
- [x] `findPivots` already exported in `indicators/smc.ts`
- [x] Verify: `bun test --run` passes (79 pass, 3 skip)

### Step 1: Types + Config extensions ✅ DONE (2026-03-29)

**`src/types.ts`** — extend (not rewrite):

```typescript
// New types for layered pipeline
interface BiasResult {
  bias: 'long' | 'short' | 'neutral'
  confidence: number
  source: string           // 'wyckoff+smc', 'wyckoff-only', etc.
  htfBias?: 'long' | 'short' | 'neutral'
}

type StructureVerdict = 'confirm' | 'neutral' | 'deny'

interface ZoneConfirmation {
  zone: KeyZone
  vsaBoost: number         // 0 to 0.20
  vpBoost: number          // -0.10 to 0.15
  throughZone: boolean     // Spring/Sweep detected
  confirmed: boolean
}

type ConfluenceGrade = 'C' | 'B' | 'A' | 'A+'

interface RiskAssessment {
  tradeable: boolean
  reason?: string
  suggestedSize: 'full' | 'standard' | 'partial' | 'skip'
  minRR: number
  stopMethod: 'structure' | 'atr' | 'skip'
}

// Extend Signal with optional layered fields
interface Signal {
  // ... existing fields ...
  biasSource?: string
  confluenceGrade?: ConfluenceGrade
  confluenceCount?: number
  zoneOrigin?: string
  riskAssessment?: RiskAssessment
}
```

**`src/config.ts`** — add:

```typescript
export const HTF_MAP: Record<CandleInterval, CandleInterval> = {
  '1m': '15m', '5m': '1h', '15m': '4h', '1h': '4h', '4h': '1d', '1d': '1d',
} as const

export const CONFLUENCE_MIN = 3          // minimum grade B to alert
export const SIMULATED_ACCOUNT = 10_000  // for risk filter (Sprint 1, no wallet)

export const ZONE_RISK = {
  near: { maxDistance: 0.02, minRR: 1.5 },      // < 2%
  medium: { maxDistance: 0.05, minRR: 2.0 },     // 2-5%
  far: { maxDistance: 0.08, minRR: 3.0 },        // 5-8%
  skip: { maxDistance: 0.10 },                    // > 10% → skip
} as const
```

**`src/indicators/smc.ts`** — add Premium/Discount Zone + OTE:

```typescript
export function premiumDiscount(swingHigh: number, swingLow: number, price: number):
  'premium' | 'discount' | 'equilibrium' {
  const eq = (swingHigh + swingLow) / 2
  if (price > eq * 1.005) return 'premium'
  if (price < eq * 0.995) return 'discount'
  return 'equilibrium'
}

export function oteZone(swingA: number, swingB: number):
  { top: number; bottom: number } {
  // OTE = Fib 62% to 79% retracement of impulse A→B
  const range = Math.abs(swingB - swingA)
  if (swingB > swingA) {  // bullish impulse
    return { top: swingB - range * 0.62, bottom: swingB - range * 0.79 }
  } else {  // bearish impulse
    return { top: swingB + range * 0.79, bottom: swingB + range * 0.62 }
  }
}
```

### Step 2: Scanner layers ✅ DONE (2026-03-29)

**Deleted**: `src/scanner/entries/` (7 files) + `src/scanner/engine.ts` + `test/entries.test.ts` + `test/engine.test.ts`

**Created** — 9 new files:

#### `src/scanner/layers/bias.ts` — Layer 1

```
determineBias(candles, idx, htfCandles, pivots):

  1. wyckoff = detectWyckoff(candles, idx)
  2. breaks = detectStructureBreaks(candles, idx)
  3. latestCHoCH = breaks.findLast(b => b.kind === 'choch')
  4. latestBOS = breaks.findLast(b => b.kind === 'bos')

  Conflict resolution (Section 11 rules):
    Accumulation + bearish BOS, no CHoCH yet → neutral (STOP, chờ SOS)
    Accumulation + bullish CHoCH → long (Spring confirmed)
    Distribution + bullish BOS, no CHoCH yet → neutral
    Distribution + bearish CHoCH → short (UTAD confirmed)
    Invalidation: close < Spring low - ATR×1.5 → flip short (Re-distribution)

  5. HTF check: query htfCandles → HTF bias
     HTF opposes → neutral (STOP)
     HTF aligns → confidence boost +0.15
     HTF empty (startup) → fallback current TF only (no boost)

  Return BiasResult | null
```

#### `src/scanner/layers/structure.ts` — Layer 2

```
confirmStructure(candles, idx, bias, pivots, swings):

  1. swings = classifySwings(candles, idx) — OR use pre-computed swings
  2. { bias: structBias, confidence } = detectStructuralBias(swings)

  3. Match:
     bias.bias='long' + structBias='bullish'  → 'confirm'
     bias.bias='long' + structBias='neutral'  → 'neutral' (proceed, lower confluence)
     bias.bias='long' + structBias='bearish'  → 'deny' (STOP)
     bias.bias='short' + structBias='bearish' → 'confirm'
     bias.bias='short' + structBias='neutral' → 'neutral'
     bias.bias='short' + structBias='bullish' → 'deny' (STOP)

  Return StructureVerdict
```

#### `src/scanner/layers/zones.ts` — Layer 3

```
findEntryZones(candles, idx, bias, pivots):

  1. { demandZones, supplyZones } = compileKeyZones(candles, idx)
  2. Filter by bias:
     bias='long'  → demandZones only
     bias='short' → supplyZones only
  3. Sort by proximity to current price

  Return KeyZone[] — empty = STOP
```

#### `src/scanner/layers/confirm.ts` — Layer 4

```
isAtZone(candle, zone, atr):
  buffer = atr × 0.3
  demand zone:
    wickTouch  = candle.low <= zone.top AND candle.low >= zone.bottom
    nearZone   = candle.close >= (zone.bottom - buffer) AND candle.close <= (zone.top + buffer)
    throughZone = candle.low < zone.bottom AND candle.close > zone.bottom  ← Spring/Sweep
  supply zone:
    wickTouch  = candle.high >= zone.bottom AND candle.high <= zone.top
    nearZone   = candle.close <= (zone.top + buffer) AND candle.close >= (zone.bottom - buffer)
    throughZone = candle.high > zone.top AND candle.close < zone.top

confirmZones(candles, idx, zones):
  For each zone:
    if not isAtZone → skip
    VSA: detectVSA(candles, idx) → stopping volume? test? no supply?
      → vsaBoost: +0.10 to +0.20
    VP: buildVolumeProfile → zone overlaps HVN/POC/VAL/VAH?
      → vpBoost: -0.10 to +0.15
    throughZone → extra confluence bonus

  Return ZoneConfirmation[]
```

#### `src/scanner/layers/trigger.ts` — Layer 5

```
findTrigger(candles, idx, confirmedZones, bias):
  For each zone with isAtZone:
    patterns = detectPriceAction(candles, idx)
    Filter: only patterns matching bias direction
      bias='long' → bullish engulfing, pin bar bull, hammer, tweezer bottom, dragonfly
      bias='short' → bearish engulfing, pin bar bear, shooting star, tweezer top, gravestone
    Pick strongest by strength

  Return Signal | null (null = zone waits for trigger)
```

#### `src/scanner/confluence.ts`

```
scoreConfluence(bias, structureVerdict, zone, trigger, regime):
  count = 0
  +1 if bias.confidence >= 0.6        (Layer 1 clear)
  +1 if structureVerdict == 'confirm'  (Layer 2 confirms)
  +0.5 if structureVerdict == 'neutral'
  +1 if zone has multiple origins      (Layer 3 multi-source)
  +1 if zone.vsaBoost > 0             (Layer 4 VSA)
  +1 if zone.vpBoost > 0              (Layer 4 VP)
  +1 if trigger exists                 (Layer 5 PA)
  +1 if regime aligned                 (Regime context)

  Grade: C(< 3), B(3-4), A(5-6), A+(7)
  Confidence: base zone.strength + boosts + trigger.strength

  Return { grade, count, confidence }
```

#### `src/scanner/regime.ts`

```
applyRegimeModifier(confidence, side, regime):
  aligned (Long+BULL, Short+BEAR): × 1.0
  neutral (SIDEWAYS, VOLATILE):    × 0.8
  counter (Long+BEAR, Short+BULL): × 0.3

  Return clamped confidence (NaN → 0)
```

#### `src/scanner/risk-filter.ts`

```
assessRisk(signal, zone, currentPrice, atrValue):
  distance = |currentPrice - midOf(zone)| / currentPrice
  rr = |tp - entry| / |entry - sl|

  if distance < 0.02: full size, minRR = 1.5
  if distance < 0.05: standard, minRR = 2.0
  if distance < 0.08: partial, minRR = 3.0
  if distance >= 0.10: skip

  Skip if ANY:
    rr < minRR
    |entry - sl| > atrValue × 3
    (SIMULATED_ACCOUNT × 0.01) / stopDistance < SIMULATED_ACCOUNT × 0.001  (size too small)

  Return RiskAssessment { tradeable, suggestedSize, minRR, stopMethod }
```

#### `src/scanner/pipeline.ts`

```typescript
// Shared context computed once per tick
const pivots = findPivots(candles, idx, 3)

// Regime (parallel)
const regime = detectRegime(candles, idx)

// Layer 1: Bias
const htfCandles = getCandles(coin, HTF_MAP[interval], INDICATOR_WINDOW)
const bias = determineBias(candles, idx, htfCandles, pivots)
if (!bias || bias.bias === 'neutral') return

// Layer 2: Structure
const verdict = confirmStructure(candles, idx, bias, pivots)
if (verdict === 'deny') return

// Layer 3: Zones
const zones = findEntryZones(candles, idx, bias, pivots)
if (zones.length === 0) return

// Layer 4: Confirm
const confirmed = confirmZones(candles, idx, zones)

// Layer 5: Trigger
const signal = findTrigger(candles, idx, confirmed, bias)
if (!signal) return

// Confluence + Risk + Regime
const { grade, confidence } = scoreConfluence(bias, verdict, ...)
if (grade === 'C') return

const risk = assessRisk(signal, zone, currentPrice, atrValue)
if (!risk.tradeable) return

const finalConf = applyRegimeModifier(confidence, signal.side, regime)
if (finalConf < MIN_CONFIDENCE) return

// Track + Alert + Invalidate
```

**Readiness Gate** (trong `src/index.ts`):

```
Startup:
  For each coin:
    Backfill ALL intervals (parallel per interval, sequential per coin)
    Only subscribe WS AFTER all intervals ready
    Log: "[ARMED] BTC: all 6 TFs ready, pipeline active"

  If synth HTF needed during warmup:
    aggregate 1m candles → approximate 15m/4h (Option C fallback)
```

### Step 3: Console Output ✅ DONE (2026-03-29)

```
[14:30:00] Minh (明) v1.0.0 — Layered Decision Framework
[14:30:00] Config: BTC,ETH,SOL × 1m,5m,15m,1h,4h,1d | min:0.4 | confluence:3+ | regime:1.0/0.8/0.3
[14:30:01] BACKFILL | BTC 1m: 5000 candles
...
[14:30:09] ARMED | BTC: 6/6 TFs ready | ETH: 6/6 ready | SOL: 6/6 ready
[14:32:05] SETUP | BTC 4H | LONG OB at demand zone | grade:A (5/7) | conf:0.72 | BULL aligned
           entry:67250 sl:66100 tp:69500 | R:R 1:1.94 | bias:wyckoff+smc | structure:confirm
           VSA:stopping-vol(+0.20) VP:HVN(+0.15) | trigger:bullish-engulfing | risk:full
[14:33:00] STATUS | BTC BULL A5 1setup | ETH SIDE — 0 | SOL BEAR — 0
[14:35:12] INVALID | BTC 4H | OB Long | closed below zone | lived 3 bars
[14:36:00] WARNING | ETH 1m | stale 65s — no candle update
```

### Step 4: Tests (Phase A) ✅ DONE (2026-03-29)

| File | What | Key cases |
|---|---|---|
| `test/layers/bias.test.ts` | Layer 1 | Wyckoff+SMC agree, conflict→neutral, CHoCH rule, Spring invalidation (close < low-ATR×1.5), HTF gate, HTF empty fallback |
| `test/layers/structure.test.ts` | Layer 2 | confirm/neutral/deny, < 4 swings→neutral |
| `test/layers/zones.test.ts` | Layer 3 | Bias-filtered zones, no zones→empty, multi-source zones |
| `test/layers/confirm.test.ts` | Layer 4 | isAtZone (wickTouch/nearZone/throughZone), VSA boosts, VP boosts, no confirm→base |
| `test/layers/trigger.test.ts` | Layer 5 | PA at zone, no PA→null, opposite direction→skip, strongest pick |
| `test/confluence.test.ts` | Scoring | Grade boundaries C(2)/B(3)/A(5)/A+(7) |
| `test/risk-filter.test.ts` | Risk | Distance thresholds, R:R minimums, skip conditions |
| `test/pipeline.test.ts` | Integration | Each STOP point (5 paths), end-to-end signal, closed-candle gate (migrated) |
| Keep: `test/indicators.test.ts`, `test/invalidation.test.ts`, `test/store.test.ts`, `test/feed.test.ts` |

Delete: `test/entries.test.ts`, `test/engine.test.ts`

---

## Phase B: New HL Data Feeds ✅ DONE (2026-03-29)

### Goal

Add Funding Rate, Trades Stream, L2 Order Book from Hyperliquid. Create order-flow indicator. Integrate into Layer 4 confirm.

### Session B-1: Types + Config + Order Flow Indicator ✅ DONE

**`src/types.ts`** — added 3 new types:
```typescript
interface FundingSnapshot { coin: string; rate: number; premium: number; timestamp: number }
interface DeltaState { delta: number; cumDelta: number; buyVol: number; sellVol: number; barTs: number }
interface OrderBookSnapshot { coin: string; bids: [number, number][]; asks: [number, number][]; imbalance: number; timestamp: number }
```

**`src/types.ts`** — extended `ZoneConfirmation` with optional Phase B fields:
- `deltaBoost?: number` (-0.10 to +0.15)
- `bookBoost?: number` (-0.10 to +0.20)
- `fundingBoost?: number` (0 to +0.10)

**`src/config.ts`** — added Phase B constants:
- `FUNDING_POLL_INTERVAL_MS`, `FUNDING_HISTORY_HOURS`, `DELTA_AGGREGATE_INTERVAL_MS`
- `BOOK_DEPTH_LEVELS`, `BOOK_STALENESS_MS`
- `DELTA_STRONG_THRESHOLD` (0.6), `BOOK_IMBALANCE_THRESHOLD` (0.3), `FUNDING_CONTRARIAN_THRESHOLD` (-0.0001)

**`src/indicators/order-flow.ts`** — [ASSUMED] pure functions:
- `computeDelta(trades)` → `{delta, buyVol, sellVol}` — side "B"=buy, "A"=sell
- `cumulativeDelta(history, n)` → sum of delta over last N bars
- `deltaConfirm(delta, zone)` → boost -0.10 to +0.15 (aligned=+0.15, divergence=-0.10)
- `bidAskImbalance(bids, asks)` → ratio -1 to +1
- `bookConfirm(imbalance, zone)` → boost -0.10 to +0.20 (absorption=+0.20)
- `fundingConfirm(rate, side)` → boost 0 to +0.10 (contrarian only)

### Session B-2: Feed Layer ✅ DONE

**`src/feed/ws.ts`** — exported `getWsClient()` + `registerSubscription()` for shared WS connection

**`src/feed/funding.ts`** — REST polling:
- `startFundingPolling(coins)` → initial fetch + setInterval(60s)
- `stopFundingPolling()` → clearInterval
- `getLatestFunding(coin)` → `FundingSnapshot | null`
- Error: try/catch per coin, NaN filter on API response

**`src/feed/trades.ts`** — WS trades stream:
- `subscribeTrades(coin)` → accumulates delta per coin
- `getLatestDelta(coin)` → `DeltaState | null`
- `resetDelta(coin)` → reset accumulators, preserve cumDelta
- Raw trades NOT stored — only running DeltaState per coin

**`src/feed/orderbook.ts`** — WS L2 book:
- `subscribeOrderBook(coin)` → cap top 20 levels, compute imbalance
- `getLatestBook(coin)` → `OrderBookSnapshot | null`
- `checkBookStaleness()` → WARNING after BOOK_STALENESS_MS (30s)

### Session B-3: Layer 4 Integration ✅ DONE

**`src/scanner/layers/confirm.ts`**:
- Added `OrderFlowContext` interface: `{ delta?, book?, funding?, signalSide? }`
- `confirmZones()` accepts optional 4th param `orderFlow`
- Computes deltaBoost, bookBoost, fundingBoost per zone
- `confirmed` flag updated to include order flow boosts

**`src/scanner/layers/trigger.ts`**:
- Includes deltaBoost/bookBoost/fundingBoost in confidence calculation
- Stores new boosts in `patternData` for log output

**`src/scanner/confluence.ts`** — updated scoring:
- `+1` if `zone.deltaBoost > 0`
- `+1` if `zone.bookBoost > 0`
- `+0.5` if `zone.fundingBoost > 0`
- Grade boundaries adjusted: C(<3), B(3-5), A(6-7), A+(8+) ← was C/B/A/A+(7+)

**`src/scanner/pipeline.ts`**:
- Builds `OrderFlowContext` per tick from live feeds
- Passes to `confirmZones()` in Layer 4
- `logSetupAlert()` shows `Δ(+0.15)`, `Book(+0.10)`, `Fund(+0.10)` in SETUP line

**`src/index.ts`**:
- `subscribeTrades(coin)` + `subscribeOrderBook(coin)` in WS subscribe phase
- `startFundingPolling([...COINS])` after backfill
- `checkBookStaleness()` added to staleness setInterval
- `stopFundingPolling()` added to SIGINT handler

### Tests (Phase B) ✅ DONE (175 pass / 3 skip / 0 fail)

| File | Tests | Status |
|---|---|---|
| `test/indicators/order-flow.test.ts` | 39 tests — all 6 functions | ✅ |
| `test/feed/funding.test.ts` | null contract, stop safety | ✅ |
| `test/feed/trades.test.ts` | null contract, reset safety, side mapping note | ✅ |
| `test/feed/orderbook.test.ts` | null contract, depth cap, staleness safety | ✅ |
| `test/layers/confirm.test.ts` | +5 tests for order flow boosts | ✅ |
| `test/confluence.test.ts` | Updated grade A/A+ for new boundaries | ✅ |

### Known deviations

- `order-flow.ts` is new logic (not in Tuệ) → golden test fixture not applicable. [ASSUMED] correctness from unit tests against spec.
- `detectAbsorption()` from original spec not implemented as separate function — absorption detection folded into `bookConfirm()` via `imbalance >= threshold × 2 → +0.20` rule. Simpler, same outcome.
- Feed tests are contract tests (null/safety) rather than live API tests — live behavior verified at runtime only.

---

## Error Handling

| Codepath | Error | Action |
|---|---|---|
| Layer 1 HTF empty | Startup race | Readiness Gate — don't scan until all TFs ready |
| Layer 1 Wyckoff null | < 50 candles | Return neutral → STOP |
| Layer 1 conflict | Wyckoff vs SMC disagree | CHoCH rule → neutral until resolved |
| Layer 4 VP null | Degenerate price range | Skip VP boost, keep base score |
| Pipeline NaN | Bad indicator output | Clamp to 0 |
| Phase B trades burst | High volatility | Aggregate per-second |
| Phase B L2 stale | No updates 30s | Staleness watchdog WARNING |
| All existing feed errors | REST 429, WS disconnect, etc. | Existing handling unchanged |
| WS connection drop | SDK throws WebSocketRequestError | Auto-reconnect with exponential backoff (1s→30s max) |

## Definition of Done

Sprint 1 is complete when:
- [x] `bun test --run` passes all test files (indicators + layers + pipeline + feed + invalidation + store) — **175 pass / 3 skip / 0 fail**
- [x] `bun run src/index.ts` starts, backfills, shows ARMED for all 3 coins — [CONFIRMED] 2026-03-30 live run
- [x] STATUS lines print with regime + bias + confluence grade every 60s — [CONFIRMED] 2026-03-30 live run
- [ ] SETUP alerts show grade (B/A/A+), layer count, VSA/VP boosts ← needs live run `[CARRIED]` → Sprint 2
- [ ] Each STOP point verified: neutral bias → no scan, structure deny → no zones ← pipeline tests cover this `[CARRIED]` → Sprint 2
- [ ] HTF gate works: LTF counter-HTF signals blocked ← covered by bias.test.ts `[CARRIED]` → Sprint 2
- [x] Phase B: Delta, Book imbalance, Funding rate integrated into Layer 4 + visible in SETUP logs
- [ ] Staleness WARNING fires when WiFi disconnected 60s ← needs live run `[CARRIED]` → Sprint 2
- [ ] INVALID fires when active setup pattern broken ← covered by invalidation.test.ts `[CARRIED]` → Sprint 2

### Post-Sprint Fix: WS Reconnection (2026-03-30)

Live run exposed crash on WS disconnect (`WebSocketRequestError: WebSocket connection closed`). Added:
- `src/config.ts`: `WS_RECONNECT_INITIAL_MS` (1s), `WS_RECONNECT_MAX_MS` (30s), `WS_RECONNECT_BACKOFF` (2x)
- `src/index.ts`: `runWithReconnect()` loop — on error: cleanup (clear intervals, stop polling, close WS) → backoff delay → re-run `main()` (fresh subscriptions + backfill)
- `src/feed/ws.ts`: `closeAll()` now clears `lastCandleTime` to avoid false staleness warnings post-reconnect

**Remaining before Sprint 1 fully done:** live run verification of remaining 3 items (SETUP alert, staleness WARNING, INVALID)
