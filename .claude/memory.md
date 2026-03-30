# Minh (明) — Session Memory

## Current State (2026-03-30)

### Sprint Overview
- **Sprint 1**: DONE ✅ — Analysis engine, 175 tests pass
- **Sprint 2**: PLANNED — Algorithmic Agent Trading (PostgreSQL+TimescaleDB, Elysia, State Machine)
- **Sprint 3**: PLANNED — Validate + Visualize (Backtest, Analytics, Dashboard MVP)

### Sprint 1 Progress (Complete)
- **Step 0**: DONE — exports, domain-knowledge sections 11+12, git init
- **Step 1**: DONE — types, config, premiumDiscount, oteZone, structure exports
- **Step 2**: DONE — 9 scanner files, pipeline.ts, old entries/ + engine.ts deleted
- **Step 3**: DONE — banner, BACKFILL, ARMED, STATUS compact format
- **Step 4**: DONE — 8/8 test files (5 layers + confluence + risk-filter + pipeline)
- **Phase B**: DONE — order flow feeds + indicator + Layer 4 integration

### Sprint 2 Key Decisions (2026-03-30)
- S1: Stay Bun/TS — rule-based algo agent, not ML
- S2: PostgreSQL + TimescaleDB — replaces bun:sqlite (ACID + time-series from start)
- S3: Elysia — replaces Bun.serve() (validation + auth for execution endpoints)
- S4: Agent Trading focus — state machine, order lifecycle, circuit breakers
- S5: ClickHouse rejected — async mutations, batch-only
- S6: QuestDB rejected — no relational support
- S7: Direct to PostgreSQL — no throwaway SQLite layer

### Sprint 3 Key Decisions (2026-03-30)
- T1: LLM = Advisor only, never executor
- T2: Anthropic Claude API for trade analysis
- T5: ~~CCXT~~ REVOKED — Hyperliquid-only, no multi-exchange
- T7: React + Lightweight Charts for dashboard
- Sprint progression: SEE (S1) → ACT (S2) → VALIDATE (S3) → EXPAND (S4) → ADVISE (S5) → REMEMBER (S6-7)

### Test Baseline
- 175 pass, 3 skip, 0 fail (17 test files)

### Current File Structure

```
src/
├── indicators/
│   ├── core.ts, smc.ts, price-action.ts, vsa.ts, wyckoff.ts
│   ├── volume-profile.ts, structure.ts
│   └── order-flow.ts    ← Phase B: computeDelta, deltaConfirm, bookConfirm, fundingConfirm
├── feed/
│   ├── rest.ts, ws.ts, store.ts
│   ├── funding.ts       ← Phase B: REST polling 60s
│   ├── trades.ts        ← Phase B: WS trades → DeltaState
│   └── orderbook.ts     ← Phase B: WS L2 book → OrderBookSnapshot
└── scanner/
    ├── layers/
    │   ├── bias.ts        ← Layer 1: determineBias (Wyckoff+SMC+HTF)
    │   ├── structure.ts   ← Layer 2: confirmStructure (3-state)
    │   ├── zones.ts       ← Layer 3: findEntryZones (bias-filtered)
    │   ├── confirm.ts     ← Layer 4: isAtZone + confirmZones (VSA/VP + OrderFlowContext)
    │   └── trigger.ts     ← Layer 5: findTrigger (PA at zone)
    ├── pipeline.ts        ← Orchestrator
    ├── confluence.ts      ← Grade C/B/A/A+
    ├── regime.ts          ← Soft regime modifier
    ├── risk-filter.ts     ← Zone distance → size/RR/skip
    └── invalidation.ts    ← TTL-based pattern invalidation
```

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
- HTF_MAP: 1d→1d means no HTF check for daily
- HL trades side: "B" = buyer aggressor (buy), "A" = seller aggressor (sell)
- ZoneConfirmation.deltaBoost/bookBoost/fundingBoost are optional — default 0

### Live Run Verification (2026-03-30)
- [CONFIRMED] git init + commit: `14bd08a`
- [CONFIRMED] ARMED: BTC 6/6, ETH 6/6, SOL 6/6 TFs ready
- [CONFIRMED] STATUS: prints every 60s (BTC/ETH/SOL SIDEWAYS — 0setup)
- [CONFIRMED] domain-knowledge.md sections 11+12 present (933 lines)
- Pending: SETUP alerts, Staleness WARNING, INVALID (market/network dependent)

### Workflow (updated 2026-03-30)
- Full workflow in `.claude/rules/session-protocol.md`
- Sprint Kickoff → Session (Task Contract → Build → /review → Commit) → Phase Complete → Sprint Close
- gstack skills: /review (every session), /cso (wallet/execution), /retro (phase/sprint boundaries)

### Next
- Sprint 2 Session S1: PostgreSQL + TimescaleDB setup
- Sprint 2 has 16 sessions across 5 phases (2A-2E), ~8-10h estimated
