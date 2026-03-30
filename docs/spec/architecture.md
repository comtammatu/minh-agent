# Minh (明) — Architecture

> **v2.0.0 (Sprint 2 complete, 2026-03-30)** — Autonomous trading agent. Sprint 1 analysis engine + Sprint 2 agent/execution/persistence layers.

## System Overview — Layered Decision Framework (Sprint 1)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Minh (明) Process                            │
│                                                                     │
│  ┌──────────────┐                                                   │
│  │  config.ts   │  COINS, TIMEFRAMES, REGIME_MULTIPLIERS,           │
│  │              │  HTF_MAP, ZONE_RISK, CONFLUENCE_MIN               │
│  └──────┬───────┘                                                   │
│         │                                                           │
│  ┌──────▼───────┐                                                   │
│  │  index.ts    │  Orchestrator                                     │
│  │              │  1. Backfill ALL TFs  2. Readiness Gate            │
│  │              │  3. Subscribe WS  4. Status loop                  │
│  └──┬───────┬───┘                                                   │
│     │       │                                                       │
│  ┌──▼────┐ ┌▼──────┐                                               │
│  │ REST  │ │  WS   │  @nktkas/hyperliquid                          │
│  │backfill│ │stream │  InfoClient / SubscriptionClient              │
│  │seq 18 │ │+stale │  + staleness watchdog                         │
│  └──┬────┘ └┬──────┘                                               │
│     │       │                                                       │
│     └───┬───┘                                                       │
│         │                                                           │
│  ┌──────▼───────┐                                                   │
│  │    STORE     │  Map<"BTC:4h", Candle[]>                          │
│  │  in-memory   │  upsert by timestamp                              │
│  │  slice(−200) │  getCandles returns last N                        │
│  └──────┬───────┘                                                   │
│         │  onCandleTick(coin, tf, candle) — closed-candle gate      │
│         │                                                           │
│         ├── Readiness Gate: all TFs backfilled? → if not, skip      │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │                  LAYERED PIPELINE                         │       │
│  │                                                           │       │
│  │  ┌─────────────────────────────────────────────────────┐ │       │
│  │  │              INDICATORS (pure functions)             │ │       │
│  │  │                                                     │ │       │
│  │  │  core.ts ─── sma, ema, atr, rsi, adx, volRatio,   │ │       │
│  │  │              detectRegime                           │ │       │
│  │  │  smc.ts ──── FVG, OB, BOS/CHoCH, sweep,           │ │       │
│  │  │              premiumDiscount, oteZone               │ │       │
│  │  │  price-action.ts ── 12 candlestick patterns        │ │       │
│  │  │  vsa.ts ──── 8 volume-spread signals               │ │       │
│  │  │  wyckoff.ts ── 4 phases + spring + UTAD            │ │       │
│  │  │  volume-profile.ts ── POC, VAH, VAL, HVN, LVN     │ │       │
│  │  │  structure.ts ── swings, bias, key zones           │ │       │
│  │  │  order-flow.ts ── delta, cumDelta, absorption      │ │       │
│  │  └─────────────────────────────────────────────────────┘ │       │
│  │                          │                                │       │
│  │  ┌───────────────────────┼─────────────────────────────┐ │       │
│  │  │  Shared context: pivots = findPivots(candles)       │ │       │
│  │  └───────────────────────┼─────────────────────────────┘ │       │
│  │                          │                                │       │
│  │  ┌─────────────┐  ┌─────▼─────────────────────────────┐ │       │
│  │  │ REGIME      │  │ LAYER 1: BIAS                     │ │       │
│  │  │ (parallel)  │  │ Wyckoff phase + SMC BOS/CHoCH     │ │       │
│  │  │ detectRegime│  │ + HTF cross-reference              │ │       │
│  │  │ →BULL/BEAR/ │  │ → bias = long | short | neutral   │ │       │
│  │  │  SIDE/VOL   │  │ neutral → STOP                    │ │       │
│  │  └──────┬──────┘  └─────┬─────────────────────────────┘ │       │
│  │         │               │                                │       │
│  │         │         ┌─────▼─────────────────────────────┐ │       │
│  │         │         │ LAYER 2: STRUCTURE                 │ │       │
│  │         │         │ PA classifySwings + structuralBias │ │       │
│  │         │         │ → confirm | neutral | deny         │ │       │
│  │         │         │ deny → STOP                        │ │       │
│  │         │         └─────┬─────────────────────────────┘ │       │
│  │         │               │                                │       │
│  │         │         ┌─────▼─────────────────────────────┐ │       │
│  │         │         │ LAYER 3: ZONES                     │ │       │
│  │         │         │ SMC OB/FVG + S&D key zones        │ │       │
│  │         │         │ filtered by bias direction         │ │       │
│  │         │         │ empty → STOP                       │ │       │
│  │         │         └─────┬─────────────────────────────┘ │       │
│  │         │               │                                │       │
│  │         │         ┌─────▼─────────────────────────────┐ │       │
│  │         │         │ LAYER 4: VOLUME CONFIRM            │ │       │
│  │         │         │ VSA signals + VP levels            │ │       │
│  │         │         │ + Delta + Book imbalance           │ │       │
│  │         │         │ → boost/penalty per zone           │ │       │
│  │         │         └─────┬─────────────────────────────┘ │       │
│  │         │               │                                │       │
│  │         │         ┌─────▼─────────────────────────────┐ │       │
│  │         │         │ LAYER 5: TRIGGER                   │ │       │
│  │         │         │ PA candlestick patterns at zone    │ │       │
│  │         │         │ no pattern → null (zone waits)     │ │       │
│  │         │         └─────┬─────────────────────────────┘ │       │
│  │         │               │                                │       │
│  │         └───────┬───────┘                                │       │
│  │                 ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────┐ │       │
│  │  │         CONFLUENCE + REGIME + RISK                   │ │       │
│  │  │                                                     │ │       │
│  │  │  confluence.ts: grade C(skip)/B/A/A+                │ │       │
│  │  │  regime.ts: ×1.0/×0.8/×0.3 confidence modifier     │ │       │
│  │  │  risk-filter.ts: zone distance → size/RR/skip       │ │       │
│  │  │  Threshold: confidence ≥ 0.4 after regime modifier  │ │       │
│  │  └─────────────────────────────────────────────────────┘ │       │
│  │                          │                                │       │
│  │                          ▼                                │       │
│  │  ┌─────────────────────────────────────────────────────┐ │       │
│  │  │              INVALIDATION ENGINE                     │ │       │
│  │  │                                                     │ │       │
│  │  │  Per-pattern rules (8 types × long/short)           │ │       │
│  │  │  Pattern TTL (5–25 bars depending on type)          │ │       │
│  │  │  Active setup tracking (Map<id, ActiveSetup>)       │ │       │
│  │  └─────────────────────────────────────────────────────┘ │       │
│  │                          │                                │       │
│  └──────────────────────────┼────────────────────────────────┘       │
│                             │                                        │
│                             ▼                                        │
│                      console.log()                                   │
│                      SETUP | INVALID | STATUS | WARNING              │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Startup (one-time)

```
For each coin in [BTC, ETH, SOL] (sequential):
  For each tf in [1m, 5m, 15m, 1h, 4h, 1d] (sequential):

    ┌──────────┐     candleSnapshot(5000)     ┌──────────┐
    │  HL REST │ ───────────────────────────→  │  STORE   │
    │  API     │     Candle[] (strings→float)  │  Map<>   │
    └──────────┘                               └──────────┘
         │                                          │
         │ on success:                              │
         │ log "[BACKFILL] BTC 4h: 5000 candles"   │
         │                                          │
         │ on error:                                │
         │ retry 2x → skip if still failing         │
         ▼                                          │
    ┌──────────┐     subscribe(coin, tf)       ┌───▼──────┐
    │  HL WS   │ ──────────────────────────→   │ pipeline │
    │  API     │     onCandle callback          │ .onTick  │
    └──────────┘                               └──────────┘

Total: 18 sequential REST calls (~9s) → 18 WS subscriptions
Readiness Gate: [ARMED] BTC: 6/6 TFs ready — pipeline active
```

### Runtime (per candle tick) — Layered Pipeline

```
WS candle event (closed-candle gate)
    │
    ▼
store.appendCandle(coin, tf, candle)   ← upsert by timestamp
    │
    ▼
candles = store.getCandles(coin, tf, 200)   ← slice(-200)
    │
    ├── candles.length < 50? → return (skip scan)
    ├── Readiness Gate: all TFs backfilled? → if not, skip
    │
    ▼
pivots = findPivots(candles, idx, 3)        ← shared context (computed once)
regime = detectRegime(candles, idx)          ← parallel: BULL/BEAR/SIDE/VOL
    │
    ▼
LAYER 1 — BIAS (Wyckoff + SMC + HTF)
    │
    ├── wyckoff = detectWyckoff(candles, idx)
    ├── breaks = detectStructureBreaks(candles, idx)
    ├── HTF check: htfCandles = getCandles(coin, HTF_MAP[tf])
    ├── Conflict resolution: CHoCH rule (Section 11)
    │     Accumulation + bearish BOS → neutral (chờ SOS)
    │     Accumulation + bullish CHoCH → long (Spring confirmed)
    │     HTF opposes → neutral (STOP)
    │
    ├── bias = null or neutral? → STOP (no further layers)
    │
    ▼
LAYER 2 — STRUCTURE (Price Action)
    │
    ├── swings = classifySwings(candles, idx)
    ├── { bias: structBias } = detectStructuralBias(swings)
    ├── Match bias vs structBias → confirm | neutral | deny
    │
    ├── verdict = 'deny'? → STOP
    │
    ▼
LAYER 3 — ZONES (SMC + S&D)
    │
    ├── zones = compileKeyZones(candles, idx)
    ├── Filter by bias direction (long→demand, short→supply)
    ├── Sort by proximity to current price
    │
    ├── zones.length === 0? → STOP
    │
    ▼
LAYER 4 — VOLUME CONFIRM (VSA + VP + Order Flow)
    │
    ├── For each zone:
    │     isAtZone(candle, zone, atr)?
    │     VSA: detectVSA → vsaBoost (+0.10 to +0.20)
    │     VP: buildVolumeProfile → vpBoost (-0.10 to +0.15)
    │     Delta: positive at demand → boost +0.15
    │     Book: bid-heavy at demand → boost +0.10
    │     throughZone (Spring/Sweep) → extra confluence
    │
    ▼
LAYER 5 — TRIGGER (Price Action candlesticks)
    │
    ├── patterns = detectPriceAction(candles, idx)
    ├── Filter: only patterns matching bias direction
    ├── Pick strongest by strength
    │
    ├── no trigger? → null (zone waits for next candle)
    │
    ▼
CONFLUENCE + REGIME + RISK
    │
    ├── { grade, confidence } = scoreConfluence(bias, verdict, zone, trigger, regime)
    │     Count factors: bias clear, structure confirms, zone multi-source,
    │     VSA confirms, VP confirms, PA trigger, regime aligned
    │     Grade: C(< 3 skip), B(3-4), A(5-6), A+(7)
    │
    ├── grade === 'C'? → STOP (skip)
    │
    ├── risk = assessRisk(signal, zone, currentPrice, atrValue)
    │     distance < 2%: full, minRR 1.5
    │     distance < 5%: standard, minRR 2.0
    │     distance < 8%: partial, minRR 3.0
    │     distance >= 10%: skip
    │
    ├── !risk.tradeable? → STOP
    │
    ├── finalConf = applyRegimeModifier(confidence, side, regime)
    │     aligned: ×1.0 | neutral: ×0.8 | counter: ×0.3
    │
    ├── finalConf < 0.4? → STOP
    │
    ▼
┌──────────────────────────────────────┐
│ Track + Alert + Invalidate           │
│   → SETUP log + track in activeSetups│
│   → invalidation engine monitors     │
└──────────────────────────────────────┘
```

## Dependency Graph — Layered Pipeline (Sprint 1 target)

```
types.ts (0 deps)
    │
    ├── indicators/core.ts
    ├── indicators/smc.ts ──────── self-contained + premiumDiscount, oteZone
    ├── indicators/price-action.ts ── uses atr from core
    ├── indicators/vsa.ts ────────── uses volumeRatio, atr from core
    ├── indicators/wyckoff.ts ────── uses sma, atr, volumeRatio from core
    ├── indicators/volume-profile.ts (only types)
    ├── indicators/structure.ts ──── uses findSwingPoints, detectOB, scanFVGs from smc
    │                                uses atr, detectRegime from core
    └── indicators/order-flow.ts ─── pure functions (delta, absorption)
    │
    ├── scanner/layers/bias.ts ────── uses wyckoff, smc (BOS/CHoCH), structure
    ├── scanner/layers/structure.ts ── uses structure (classifySwings, structuralBias)
    ├── scanner/layers/zones.ts ───── uses structure (compileKeyZones)
    ├── scanner/layers/confirm.ts ─── uses vsa, volume-profile, order-flow
    └── scanner/layers/trigger.ts ─── uses price-action
    │
    ├── scanner/confluence.ts ──── scoring logic (grade C/B/A/A+)
    ├── scanner/regime.ts ─────── applyRegimeModifier
    ├── scanner/risk-filter.ts ── assessRisk (zone distance → size/RR)
    ├── scanner/invalidation.ts ── uses types only (unchanged)
    └── scanner/pipeline.ts ────── orchestrates all layers + confluence + regime + risk
    │
    ├── feed/rest.ts ──── @nktkas/hyperliquid InfoClient
    ├── feed/ws.ts ─────── @nktkas/hyperliquid SubscriptionClient
    ├── feed/store.ts ──── types only
    ├── feed/funding.ts ── REST polling funding rate (Phase B)
    ├── feed/trades.ts ─── WS trades → delta per bar (Phase B)
    └── feed/orderbook.ts ── WS l2Book → imbalance (Phase B)
    │
    └── index.ts ── wires feed + scanner/pipeline + config
```

## Regime Detection Decision Tree

```
                     candles.length < 50?
                     ┌──── YES ──→ SIDEWAYS
                     │
                     NO
                     │
                     ▼
               ATR(7)/ATR(30) > 1.8?
               ┌──── YES ──────────→ VOLATILE
               │
               NO
               │
               ▼
               ADX(14) < 20?
               ┌──── YES ──────────→ SIDEWAYS
               │
               NO
               │
               ▼
         SMA(7)/SMA(30) > 1.01?
         ┌──── YES ────────┐
         │                 ▼
         │       ADX > 30 OR ratio > 1.02
         │       OR volume trend > 0.1?
         │       ┌── YES ──→ BULL
         │       └── NO  ──→ SIDEWAYS
         │
         NO
         │
         ▼
   SMA(7)/SMA(30) < 0.99?
   ┌──── YES ────────┐
   │                 ▼
   │       ADX > 30 OR ratio < 0.98
   │       OR volume trend > 0.1?
   │       ┌── YES ──→ BEAR
   │       └── NO  ──→ SIDEWAYS
   │
   NO ──────────────→ SIDEWAYS
```

## Soft Regime Filter Matrix

```
                  Signal Side
                  LONG          SHORT
Regime  ┌─────────────────┬─────────────────┐
BULL    │  ×1.0 (aligned) │  ×0.3 (counter) │
        ├─────────────────┼─────────────────┤
BEAR    │  ×0.3 (counter) │  ×1.0 (aligned) │
        ├─────────────────┼─────────────────┤
SIDEWAYS│  ×0.8 (neutral) │  ×0.8 (neutral) │
        ├─────────────────┼─────────────────┤
VOLATILE│  ×0.8 (neutral) │  ×0.8 (neutral) │
        └─────────────────┴─────────────────┘

Threshold: confidence ≥ 0.4 after multiplication

Examples:
  OB Long (conf 0.72) in BULL   → 0.72 × 1.0 = 0.72 ✓ PASS
  OB Long (conf 0.72) in BEAR   → 0.72 × 0.3 = 0.22 ✗ FAIL
  FVG Short (conf 0.55) in SIDE → 0.55 × 0.8 = 0.44 ✓ PASS
  VSA Long (conf 0.50) in BEAR  → 0.50 × 0.3 = 0.15 ✗ FAIL
  Spring (conf 0.85) in BEAR    → 0.85 × 0.3 = 0.26 ✗ FAIL (even strong counter fails)
```

## Pattern Invalidation State Machine

```
              ┌──────────┐
              │ DETECTED │
              └────┬─────┘
                   │
          ┌────────┼────────┐
          │        │        │
          ▼        ▼        ▼
    ┌──────────┐ ┌────┐ ┌─────────┐
    │INVALIDATED│ │LIVE│ │ EXPIRED │
    └──────────┘ └─┬──┘ └─────────┘
                   │
                   │ (Sprint 2: trigger → fill → close)
                   ▼
              ┌─────────┐
              │ TERMINAL │
              └─────────┘

Sprint 1: DETECTED → LIVE → INVALIDATED or EXPIRED
  - INVALIDATED: pattern rule broken (close beyond zone)
  - EXPIRED: TTL bars exceeded without trigger

Invalidation rules per pattern type:
  order-block (20 bars): close beyond OB zone
  fvg (10 bars):         FVG fully filled (close beyond bottom/top)
  spring (15 bars):      new low below spring × 0.99
  demand-zone (25 bars): close beyond swing low/structure level
  breakout (5 bars):     retrace 0.5% beyond break level
  vsa-signal (8 bars):   close beyond SL price
  price-action (6 bars): close beyond pattern extreme
  volume-profile (12 bars): close beyond VA boundary
```

## Memory Layout

```
Store: Map<string, Candle[]>
  "BTC:1m"  → [5000 candles] × 48 bytes = 240 KB
  "BTC:5m"  → [5000 candles]             = 240 KB
  "BTC:15m" → [5000 candles]             = 240 KB
  "BTC:1h"  → [5000 candles]             = 240 KB
  "BTC:4h"  → [5000 candles]             = 240 KB
  "BTC:1d"  → [5000 candles]             = 240 KB
  × 3 coins
  ─────────────────────────────────────────
  Total: 18 × 240 KB = ~4.3 MB

ActiveSetups: Map<string, ActiveSetup>
  Typically < 20 setups at any time = negligible

Total memory: < 10 MB
```
