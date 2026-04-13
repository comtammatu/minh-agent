# Minh (明) — Architecture

> **v4.5.2 (post-S12 cleanup, 2026-04-13)** — Autonomous trading agent with multi-strategy state/risk isolation and a single shared exchange wallet per process.
>
> - Sprint 1: Layered analysis engine (scanner pipeline, indicators, invalidation)
> - Sprint 2: Agent execution (state machine, order manager, position monitor, circuit breakers, HL exchange, PostgreSQL/TimescaleDB)
> - Sprint 3: Backtest engine, analytics metrics, SSE streaming, dashboard MVP (React + Vite)
> - Sprint 4: Telegram bot (command interface), backtest-from-browser, comparison view, journal detail, mobile layout, dark/light theme
> - Sprint 4.5: Multi-strategy architecture (IStrategy interface, StrategyRegistry fan-out, shared ExchangePool, PortfolioRiskManager, dashboard strategy selector, Telegram /strategy commands)

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
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  AGENT (Sprint 2) — TradingAgent state machine               │    │
│  │    IDLE → WATCHING → ENTERING → IN_POSITION → EXITING        │    │
│  │    + OrderManager + PositionMonitor + CircuitBreakers         │    │
│  │    + InvalidationBridge + ExchangeService (HL L1)             │    │
│  │    + Journal (PostgreSQL trade_journal)                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                             │                                        │
│              ┌──────────────┼──────────────┐                         │
│              ▼              ▼              ▼                         │
│         Elysia API     Telegram Bot   SSE Stream                    │
│         (Sprint 3)     (Sprint 4)     (Sprint 3)                    │
│              │              │              │                         │
│              └──────────────┼──────────────┘                         │
│                             ▼                                        │
│                      Dashboard (React+Vite)                          │
│                      (Sprint 3–4)                                    │
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

Total: ~90 sequential REST calls (15 coins × 6 TFs, ~45s)
  → ~121 WS subscriptions (candles + trades + orderbook)
  → PostgreSQL write-through for candle persistence
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

## Dependency Graph — Full System (Sprint 1–4)

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
    ├── strategy/orchestrator.ts ──── onCandleTick, activeSetups, statusState
    ├── strategy/diagnostics.ts ───── PipelineStats, formatPipelineStats
    ├── strategy/registry.ts ──────── IStrategy interface + StrategyRegistry
    ├── strategy/shared/regime.ts ─── applyRegimeModifier
    ├── strategy/shared/invalidation.ts ── TTL + invalidation rules
    │
    ├── strategy/strategies/layered/
    │   ├── index.ts ──────── LayeredStrategyAdapter (wraps pipeline)
    │   ├── pipeline.ts ───── 5-layer Wyckoff/SMC pipeline
    │   ├── confluence.ts ─── scoring logic (grade C/B/A/A+)
    │   ├── risk-filter.ts ── assessRisk (zone distance → size/RR)
    │   └── layers/ ───────── bias, structure, zones, confirm, trigger
    │
    ├── strategy/strategies/quant/
    │   ├── index.ts ──────── QuantStrategyAdapter
    │   └── pipeline.ts ───── EMA trend + RSI pullback
    │
    └── strategy/strategies/smc-sd/
        └── index.ts ──────── SMC + S&D Zone Bounce
    │
    ├── feed/rest.ts ──── @nktkas/hyperliquid InfoClient
    ├── feed/ws.ts ─────── @nktkas/hyperliquid SubscriptionClient
    ├── feed/store.ts ──── types only
    ├── feed/funding.ts ── REST polling funding rate (Phase B)
    ├── feed/trades.ts ─── WS trades → delta per bar (Phase B)
    └── feed/orderbook.ts ── WS l2Book → imbalance (Phase B)
    │
    │
    ├── db/connection.ts ──── postgres (npm) client
    ├── db/migrate.ts ─────── schema migrations
    ├── db/candle-repo.ts ─── upsert, bulk, load, gap-fill
    │
    ├── agent/trading-agent.ts ── state machine (per-coin)
    ├── agent/order-manager.ts ── order lifecycle (place/fill/cancel/timeout)
    ├── agent/position-monitor.ts ── track open positions + exit reconciliation
    ├── agent/circuit-breakers.ts ── daily loss, consecutive loss, drawdown limits
    ├── agent/correlation-guard.ts ── block correlated entries
    ├── agent/invalidation-bridge.ts ── pipeline invalidation → agent actions
    ├── agent/self-healing.ts ── health monitor + auto-recovery
    ├── agent/journal.ts ──── trade journal persistence (PostgreSQL)
    ├── agent/close-all.ts ── emergency close-all (DI-enabled)
    ├── agent/portfolio-risk.ts ── global exposure + per-strategy allocation (Sprint 4.5)
    ├── agent/trading-orchestrator.ts ── per-strategy state dispatch (Sprint 4.5)
    │
    ├── execution/exchange-service.ts ── HL ExchangeClient (place/cancel/modify)
    ├── execution/exchange-pool.ts ──── shared exchange service routing (single wallet per process)
    │
    ├── backtest/engine.ts ── backtest orchestrator
    ├── backtest/simulator.ts ── fill simulation (paper trade)
    ├── backtest/metrics.ts ── equity curve, trade stats
    │
    ├── analytics/metrics.ts ── win rate, PF, Sharpe, drawdown
    ├── analytics/metrics-service.ts ── PostgreSQL-backed analytics queries
    │
    ├── server/index.ts ── Elysia HTTP API (status, backtest, analytics, compare)
    ├── server/sse.ts ───── SSE event streaming
    │
    ├── alert/telegram/ ── Telegram bot (polling + command router + 10 commands)
    │
    ├── dashboard/ ── React + Vite + Recharts (backtest, journal, compare, mobile)
    │
    └── index.ts ── wires feed + strategy + agent + server + telegram
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
  "BTC:1m"  → [500 candles]  × 48 bytes = 24 KB
  "BTC:5m"  → [500 candles]              = 24 KB
  "BTC:15m" → [5000 candles]             = 240 KB
  "BTC:1h"  → [5000 candles]             = 240 KB
  "BTC:4h"  → [5000 candles]             = 240 KB
  "BTC:1d"  → [5000 candles]             = 240 KB
  × 15 coins (dynamic top by OI, refreshed hourly)
  ─────────────────────────────────────────
  Total: 15 × ~1 MB = ~15 MB in-memory
  + PostgreSQL/TimescaleDB persistence (write-through)

ActiveSetups: Map<string, ActiveSetup>
  Typically < 50 setups at any time = negligible

Total memory: < 20 MB
```

## Sprint 3–4 Additions

```
Sprint 3:
  src/backtest/        ← Backtest engine (engine.ts, simulator.ts, metrics.ts)
  src/analytics/       ← Metrics service (win rate, PF, drawdown, Sharpe)
  src/server/          ← Elysia HTTP API + SSE streaming
  dashboard/           ← React + Vite + Recharts dashboard MVP

Sprint 4:
  src/alert/telegram/  ← Telegram bot (polling, command router, 10 commands)
  src/agent/close-all.ts ← Emergency close-all (shared by API + Telegram)
  dashboard extensions ← Backtest runner, compare view, journal detail,
                          mobile layout, dark/light theme
```

## Multi-Strategy Architecture (Sprint 4.5)

```
Feed Layer (shared — candles, L2, trades, funding)
    ↓
StrategyRegistry.runAll() — fan-out to ALL registered strategies
    ↓
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Layered Strategy │  │ Quant Strategy  │  │ Future Strategy │
│ (5-layer Wyckoff)│  │ (EMA+RSI)       │  │ (e.g. SMC+S&D)  │
│ Agent Wallet A   │  │ Agent Wallet B  │  │ Agent Wallet C  │
│ % allocation     │  │ % allocation    │  │ % allocation    │
│ Own GlobalContext │  │ Own GlobalContext│  │ Own GlobalContext│
│ Own CircuitBreaker│  │ Own CircuitBreaker│ │ Own CircuitBreaker│
└────────┬─────────┘  └────────┬─────────┘  └────────┬────────┘
         └────────────────┬────┘                      │
                    PortfolioRiskManager ──────────────┘
                    (global exposure cap)
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `IStrategy` | `src/strategy/registry.ts` | Interface: `scan()`, `minCandles`, `clearState()` |
| `StrategyRegistry` | `src/strategy/registry.ts` | Register/fan-out/activate strategies |
| `LayeredStrategyAdapter` | `src/strategy/strategies/layered/index.ts` | Wraps existing 5-layer pipeline |
| `QuantStrategyAdapter` | `src/strategy/strategies/quant/index.ts` | Wraps EMA+RSI quant pipeline |
| `ExchangePool` | `src/execution/exchange-pool.ts` | Shared exchange service routing for the active exchange |
| `PortfolioRiskManager` | `src/agent/portfolio-risk.ts` | Global exposure cap, per-strategy allocation |
| `TradingOrchestrator` | `src/agent/trading-orchestrator.ts` | Per-strategy state, coin:strategyId keying |

### Isolation Model

- **State**: Agent state keyed by `coin:strategyId` — same coin can be traded by different strategies independently
- **Execution**: All strategies share one exchange wallet per process via `ExchangePool`; isolation is enforced in agent state/risk instead of per-strategy wallet routing
- **Risk**: Per-strategy circuit breakers + daily PnL limits. `PortfolioRiskManager` enforces global exposure cap
- **DB**: `strategy_id TEXT DEFAULT 'layered'` on orders, positions, trade_journal tables
- **API**: All endpoints accept `?strategy=` filter. `GET /api/strategies` lists registered strategies
- **Dashboard**: Global strategy selector dropdown filters all pages
- **Telegram**: `/strategy list|pause|resume` commands (E30: block disable if open positions)
- **Backward compat**: Historical `STRATEGY_WALLETS` planning was retired; current runtime is always single-wallet per process
