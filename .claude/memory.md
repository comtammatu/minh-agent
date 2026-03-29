# Minh (明) — Session Memory

## Current State (2026-03-29)

### Sprint 1 Progress
- **Step 0**: PARTIAL — exports done, domain-knowledge sections 11+12 deferred, no git init
- **Step 1**: DONE — types, config, premiumDiscount, oteZone, structure exports
- **Step 2**: DONE — 9 new scanner files, pipeline.ts, old entries/ + engine.ts deleted
- **Step 3**: DONE — banner, BACKFILL, ARMED, STATUS compact format
- **Step 4**: DONE — 8/8 test files (5 layers + confluence + risk-filter + pipeline)
- **Phase B**: DONE — order flow feeds + indicator + Layer 4 integration (2026-03-29)

### Test Baseline
- 175 pass, 3 skip, 0 fail (17 test files)
- test/smc-new.test.ts: 10 tests (premiumDiscount + oteZone)
- test/layers/: 5 test files (bias 7, structure 8, zones 5, confirm 13, trigger 5)
- test/confluence.test.ts (7), test/risk-filter.test.ts (8)
- test/pipeline.test.ts (8): closed-candle gate, STOP points, status shape, clearState
- test/indicators/order-flow.test.ts (39): computeDelta, cumulativeDelta, deltaConfirm, bidAskImbalance, bookConfirm, fundingConfirm
- test/feed/funding.test.ts, trades.test.ts, orderbook.test.ts: contract + safety tests

### Current File Structure

```
src/
├── indicators/
│   ├── core.ts, smc.ts, price-action.ts, vsa.ts, wyckoff.ts
│   ├── volume-profile.ts, structure.ts
│   └── order-flow.ts    ← NEW Phase B: computeDelta, deltaConfirm, bookConfirm, fundingConfirm
├── feed/
│   ├── rest.ts, ws.ts (+ getWsClient/registerSubscription exports), store.ts
│   ├── funding.ts       ← NEW Phase B: REST polling 60s
│   ├── trades.ts        ← NEW Phase B: WS trades → DeltaState
│   └── orderbook.ts     ← NEW Phase B: WS L2 book → OrderBookSnapshot + staleness
└── scanner/
    ├── layers/
    │   ├── bias.ts        ← Layer 1: determineBias (Wyckoff+SMC+HTF)
    │   ├── structure.ts   ← Layer 2: confirmStructure (3-state)
    │   ├── zones.ts       ← Layer 3: findEntryZones (bias-filtered)
    │   ├── confirm.ts     ← Layer 4: isAtZone + confirmZones (VSA/VP + OrderFlowContext)
    │   └── trigger.ts     ← Layer 5: findTrigger (PA at zone, includes order flow in patternData)
    ├── pipeline.ts        ← Orchestrator (builds OrderFlowContext per tick)
    ├── confluence.ts      ← Grade C/B/A/A+ — boundaries: B(3-5), A(6-7), A+(8+)
    ├── regime.ts          ← Soft regime modifier
    ├── risk-filter.ts     ← Zone distance → size/RR/skip
    └── invalidation.ts    ← TTL-based pattern invalidation
```

### Deleted Files (Step 2)
- src/scanner/entries/ (7 files: index, smc, pa, vsa, wyckoff, breakout, volume-profile)
- src/scanner/engine.ts
- test/entries.test.ts
- test/engine.test.ts

### Key API (pipeline.ts → index.ts)
- `onCandleTick(coin, interval, candle)` — called by WS subscription
- `getStatus()` → StatusSnapshot[] (with confluenceGrade field)
- `getActiveSetups()` → ActiveSetup[]
- `clearPipelineState()` — for tests

### Available Indicator Exports (for layers)
- core.ts: sma, ema, atr, rsi, volumeRatio, volumeTrend, adx, detectRegime
- smc.ts: detectFVG, scanFVGs, detectOrderBlocks, findPivots, detectStructureBreaks, detectLiquiditySweep, premiumDiscount, oteZone
- wyckoff.ts: detectWyckoff → WyckoffResult { phase, confidence, event }
- structure.ts: classifySwings, detectStructuralBias, compileKeyZones, analyzeStructure
- volume-profile.ts: buildVolumeProfile
- vsa.ts: detectVSA → VSASignal[]
- price-action.ts: detectPriceAction → CandlePattern[]

### Gotchas
- HL SDK: all numerics are strings → parseFloat() everywhere
- Floating point: 90 * 1.005 = 90.449999... not 90.45
- WS sends 0 historical candles — REST backfill first
- Store upserts by timestamp (dedup)
- HTF_MAP: 1d→1d means no HTF check for daily (same TF = empty htfCandles)
- StatusSnapshot now includes confluenceGrade (nullable)
- HL trades side: "B" = buyer aggressor (buy), "A" = seller aggressor (sell)
- ZoneConfirmation.deltaBoost/bookBoost/fundingBoost are optional (?) — default 0 when no order flow

### Pending (Sprint 1 Definition of Done)
- git init + checkpoint commit (codebase has no version control yet)
- Live run verification: `bun run src/index.ts` → ARMED → SETUP logs
- Sprint 2 planning after live run confirmed