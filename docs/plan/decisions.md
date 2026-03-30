# Minh (明) — Decision Log

All architectural and engineering decisions made during plan reviews.

---

## Original Plan Review (Flat Architecture — superseded)

Decisions below were made for the original flat 8-detector architecture. Many remain valid (C1, C2, C3, C7-C9, E1-E2, E4-E9). Some changed due to the shift to Layered Decision Framework.

### CEO Review

| # | Decision | Choice | Rationale | Status |
|---|----------|--------|-----------|--------|
| C1 | Regime filter mode | **Soft filter** — reduce confidence, never block | Counter-trend setups still valid with lower confidence | ✓ Still valid — regime modulates, never gates |
| C2 | Strength threshold | **0.4** after regime penalty | Sweet spot for filtering | ✓ Still valid |
| C3 | Persistence | **No SQLite** — in-memory only | Sprint 1 read-only, backfill acceptable | ✓ Still valid for Sprint 1. **Superseded by S2** for Sprint 2 |
| C4 | HTTP server | **No Elysia** — pure CLI | Terminal sufficient for Sprint 1 | ✓ Still valid for Sprint 1. **Superseded by S3** for Sprint 2 |
| C5 | Exit strategies | **Deferred to Sprint 2** | Read-only Sprint 1 | ✓ Still valid |
| C6 | HTF cross-reference | ~~Deferred~~ → **Sprint 1 Layer 1** | **CHANGED**: HTF bias is core of Layer 1, not an enhancement | ✗ Overridden |
| C7 | WS disconnect | **Auto-reconnect only** | ReconnectingWebSocket handles retries | ✓ Still valid |
| C8 | Candle dedup | **Upsert by timestamp** | WS overwrite with real-time close | ✓ Still valid |
| C9 | TF subscription | **WS subscribe per TF** | HL supports all intervals natively | ✓ Still valid |

### Eng Review

| # | Issue | Choice | Rationale | Status |
|---|-------|--------|-----------|--------|
| E1 | WS permanent failure | **Staleness watchdog** | Zero silent failures | ✓ Still valid |
| E2 | Backfill ordering | **Sequential** | Safe against rate limit | ✓ Still valid |
| E3 | Entries file structure | ~~Per-domain entries~~ → **Layered pipeline** | **CHANGED**: entries/ replaced by layers/ | ✗ Overridden |
| E4 | Types port | **Clean type subset** | No dead types from Tuệ | ✓ Still valid |
| E5 | Indicator port strategy | **Rewrite fresh, Tuệ as spec** | Clean room implementation | ✓ Still valid |
| E6 | Regime multipliers | **In config.ts** | Configurable tuning | ✓ Still valid |
| E7 | Test scope | ~~6 test files~~ → **~12 test files** | **CHANGED**: per-layer tests + pipeline integration | ✗ Expanded |
| E8 | Golden tests | **Snapshot fixtures from Tuệ** | Proves algorithmic equivalence | ✓ Still valid |
| E9 | Store getCandles | **slice() now** | Ring buffer when needed | ✓ Still valid |

---

## Domain Knowledge Analysis (Layered Framework)

Decisions from domain knowledge analysis session — refactoring from flat to layered architecture.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Architecture | **Layered Decision Framework** — 5 sequential layers + parallel regime | Flat 8-detector had wrong taxonomy: 5/8 detectors in wrong roles (VSA/VP = confirm, PA = trigger, Wyckoff = bias) |
| D2 | knowledge-spec.md | **Organized by trading school** instead of "Domain 1,2,3,4" | Correct nature: Wyckoff, SMC, Price Action, S&D, VSA, Order Flow, Indicator-Based |
| D3 | Volume Profile | **Part of Order Flow** — not a separate domain | Section 1.9 domain knowledge: VP is 1/6 tools in Order Flow family |
| D4 | detectRegime | **Indicator-Based, regime context** — not Layer 1 bias | Indicator-Based lags at inflection points. Wyckoff+SMC are true bias |
| D5 | detectStructuralBias | **Price Action, Layer 2** — not SMC | HH/HL/LH/LL is pure PA, predates SMC by decades |
| D6 | Docs structure | **3 directories**: plan/ spec/ ref/ | plan = sprint plans, spec = architecture + knowledge-spec, ref = domain knowledge |
| D7 | Domain knowledge file | **Copy source into project** (docs/ref/) + cross-reference | knowledge-spec (HOW) + domain-knowledge (WHY) — 2 files, 2 roles |

---

## CEO Plan Review — Layered Framework (HOLD SCOPE)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| L1 | Sprint 1 scope | **Phase A + Phase B** | Phase A: layered pipeline (OHLCV). Phase B: new data feeds (Funding+Trades+L2). Reduce blast radius |
| L2 | Bias conflict | **CHoCH rule** | Accumulation + bearish BOS → wait for CHoCH. Before CHoCH = neutral. Spring invalidation: close < low - ATR×1.5 → Re-distribution |
| L3 | Zone distance | **Risk filter, NOT Layer 3 STOP** | Far zone → reduce size + raise min R:R (Section 12). Don't block signal, adjust risk |
| L4 | HTF scope | **Sprint 1** (not deferred to Sprint 2) | HTF bias is Layer 1 core, missing = layered framework incomplete |
| L5 | New SMC concepts | **Sprint 1** — Premium/Discount Zone + OTE | Improve Layer 3 zone quality from the start |
| L6 | HL data scope | **Full**: Funding + Trades + L2 Book | Layer 4 needs true Order Flow, not just OHLCV approximation |
| L7 | domain-knowledge.md sync | **Sync immediately** — sections 11+12 missing | Conflict resolution + risk management rules needed for Sprint 1 |
| L8 | L2 book safety | **Cap top 20 levels** bid/ask | Prevent memory exhaustion from deep book |
| L9 | Trades stream safety | **Aggregate per-second** | Don't store raw individual trades — burst protection |

---

## Eng Plan Review — Layered Framework (BIG CHANGE — 9 issues)

| # | Issue | Choice | Rationale |
|---|-------|--------|-----------|
| E10 | Redundant findPivots | **Shared context** — compute 1 lần trong pipeline, truyền cho Layer 1/2/3 | DRY: findPivots tính 3 lần cho cùng data. HTF pivots Layer 1 tự tính riêng |
| E11 | "Tại zone" definition | **isAtZone logic** — wickTouch / nearZone / throughZone | throughZone = Spring/Sweep, tín hiệu mạnh nhất. Cần 3 conditions riêng biệt |
| E12 | HTF startup race | **Readiness Gate + synth HTF hybrid** | Backfill ALL TFs trước, subscribe WS sau. Synth HTF từ 1m fallback during warmup |
| E13 | confirmStructure return | **3-state**: 'confirm' / 'neutral' / 'deny' | Boolean thiếu — confluence cần biết confirm (+1) vs neutral (+0.5) vs deny (STOP) |
| E14 | Signal type | **Extend Signal** — thêm optional fields | biasSource, confluenceGrade, zoneOrigin, riskAssessment. Backward compatible, không break invalidation |
| E15 | DRY regime logic | **1 implementation trong regime.ts** | Engine.ts bị xóa, logic chuyển về regime.ts. Không duplicate |
| E16 | Risk filter no wallet | **SIMULATED_ACCOUNT = 10000** trong config.ts | Sprint 1 read-only, không có wallet. Sprint 2 thay bằng real balance |
| E17 | CHoCH test fixtures | **Hand-craft** 100+ candle scenarios | Layer 1 state transitions (Accumulation→BOS→CHoCH→invalidation) cần fixture thiết kế cẩn thận |
| E18 | Gate test migration | **Port 3 tests** từ engine.test.ts → pipeline.test.ts | Closed-candle gate logic reuse, tests phải migrate theo |

---

## Impact Summary (Updated)

### Sprint 1 — Phase A (Layered Pipeline)
- **Delete 8 files** (scanner/entries/* + engine.ts)
- **Create 9 files** (scanner/layers/* + pipeline + confluence + regime + risk-filter)
- **Modify 4 files** (structure.ts exports, smc.ts +Premium/Discount/OTE, types.ts, config.ts)
- **~12 test files** (8 new layer tests, keep 4 existing)

### Sprint 1 — Phase B (Order Flow Data)
- **Create 4 files** (feed/funding, feed/trades, feed/orderbook, indicators/order-flow)
- **Modify 2 files** (types.ts, layers/confirm.ts)
- **4 new test files**

### Indicators
- **7 indicator files unchanged** (building blocks, pure functions)
- **1 indicator file extended** (smc.ts: +Premium/Discount, +OTE)
- **1 indicator file added** (order-flow.ts)

### Key Architectural Shift
```
BEFORE (flat):     8 detectors → regime filter → alert
AFTER (layered):   Layer 1 bias → Layer 2 structure → Layer 3 zones → Layer 4 confirm → Layer 5 trigger → confluence + regime + risk → alert
```

---

## Sprint 2 Architecture Review (2026-03-30)

Decisions made during Sprint 2 planning — shift from "Trading Tool" to "Algorithmic Agent Trading".

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| S1 | Runtime stack | **Stay Bun/TS** | Rule-based agent = deterministic logic, type safety, 2-5ms/tick. Python ML ecosystem irrelevant for this use case. Hybrid sidecar later if ML needed |
| S2 | Database | **PostgreSQL + TimescaleDB** (replaces `bun:sqlite`) | Agent Trading needs ACID for orders/positions, time-series for candles, continuous aggregates for analytics. SQLite insufficient for scale (~80M rows/year) |
| S3 | HTTP framework | **Elysia** (replaces `Bun.serve()`) | Execution endpoints = real money. Need input validation (`t.Object()`), auth guards, centralized error handling, route grouping. `Bun.serve()` insufficient for 15+ routes with POST/DELETE |
| S4 | Sprint 2 focus | **Agent Trading** (replaces "Trading Tool") | Original Sprint 2 = manual y/n execution. Revised = autonomous agent with state machine, order lifecycle, circuit breakers. Tool vs Agent distinction |
| S5 | ClickHouse | **Rejected** for core storage | Async mutations (UPDATE/DELETE), batch-optimized writes, ops complexity. Trading needs real-time single-row ops. ClickHouse only useful as analytics sidecar |
| S6 | QuestDB | **Rejected** for core storage | No JOINs, no FK, no transactions, single writer. Trading agent needs mixed workload (candles + orders + positions + journal) |
| S7 | Storage migration | **Direct to PostgreSQL** | Original plan was SQLite → Postgres incremental. With Agent Trading scope, ACID needed from Sprint 2 start. No throwaway SQLite layer |

### Database Comparison Summary

| Criteria | PostgreSQL+TimescaleDB | QuestDB | ClickHouse |
|---|---|---|---|
| Write speed | ~300K/s | ~1M+/s | ~1M+/s (batch) |
| UPDATE/DELETE | Full ACID | Limited | Async, expensive |
| Mixed workload | Excellent | Poor | Poor |
| Bun driver | `postgres` | HTTP REST | `@clickhouse/client` |
| Ops complexity | Medium | Low | High |
| Verdict | **✅ Selected** | ❌ No relational | ❌ No real-time mutations |

---

## Sprint 3 Architecture Review (2026-03-30)

Preliminary decisions for Sprint 3 — Intelligence + Scale. Final review after Sprint 2 completion.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| T1 | LLM role | **Advisor only, never executor** | Deterministic execution (2-5ms) must not depend on LLM API (500-3000ms, non-deterministic, API dependency). LLM reads journal, suggests config, explains anomalies |
| T2 | LLM provider | **Anthropic Claude API** (`@anthropic-ai/sdk`) | Best reasoning for structured trade analysis, structured output support |
| T3 | LLM cost control | **Rate-limited**: 1 daily + 1 weekly review max | Estimated ~$5-15/month. Suggestions cached, not re-generated |
| T4 | LLM safety | **Human approval required** for all config changes | LLM suggests → backtest validates → owner approves via Telegram/Dashboard |
| T5 | ~~Multi-exchange~~ | ~~CCXT~~ → **REVOKED** | Removed — Hyperliquid-only focus. Complexity not justified for solo-operator agent |
| T6 | Backtest architecture | **Reuse Sprint 1+2 pipeline code** | Same indicators, same layers, same agent logic. Only mock execution layer |
| T7 | Dashboard frontend | **React 19 + Vite + Lightweight Charts + Tailwind** | Financial-grade charts (TradingView open-source), SSE from Elysia, same process |
| T8 | Dashboard deployment | **Single process** — Elysia serves static React build | No separate frontend deployment. Simplicity for solo dev |
| T9 | NL control safety | **Double confirmation for destructive actions** | "Close all positions" → "Are you sure? Type YES to confirm" |

---

## Session Log

### Session #1 — Step 0 (partial) + Step 1 (2026-03-29)

**Completed:**
- types.ts: +BiasResult, StructureVerdict, ZoneConfirmation, ConfluenceGrade, RiskAssessment. Signal extended with optional layered fields.
- config.ts: +HTF_MAP, CONFLUENCE_MIN, SIMULATED_ACCOUNT, ZONE_RISK. Added `import type { CandleInterval }`.
- smc.ts: +premiumDiscount() (premium/discount/equilibrium with 0.5% buffer), +oteZone() (Fib 62%-79% retracement, returns null for zero range).
- structure.ts: Exported classifySwings, detectStructuralBias, compileKeyZones (were private).
- test/smc-new.test.ts: 10 new tests (premiumDiscount + oteZone).

**Notes:**
- findPivots was already exported — Step 0 checklist was outdated.
- domain-knowledge.md sections 11+12 sync deferred — not blocking Step 2.
- Floating point: `90 * 1.005 = 90.449999...` not 90.45 — test fixed accordingly.
- Tests: 79 pass, 3 skip, 0 fail.

### Session #2 — Step 2 (2026-03-29)

**Sub-session 2A — Layer functions + helpers (8 files created):**
- scanner/layers/bias.ts: determineBias() — Wyckoff+SMC conflict resolution, CHoCH rule, Spring invalidation, HTF cross-ref
- scanner/layers/structure.ts: confirmStructure() — 3-state (confirm/neutral/deny) via swing classification
- scanner/layers/zones.ts: findEntryZones() — bias-filtered demand/supply zones from compileKeyZones
- scanner/layers/confirm.ts: isAtZone() (wickTouch/nearZone/throughZone) + confirmZones() with VSA/VP boosts
- scanner/layers/trigger.ts: findTrigger() — PA patterns filtered by bias direction, best pattern + best zone
- scanner/confluence.ts: scoreConfluence() — grade C/B/A/A+ from 7 factors
- scanner/regime.ts: applyRegimeModifier() — single implementation replacing engine.ts duplicate
- scanner/risk-filter.ts: assessRisk() — zone distance → size/RR/skip

**Sub-session 2B — Pipeline + rewire + cleanup:**
- scanner/pipeline.ts: Full orchestrator — closed-candle gate migrated from engine.ts, 5-layer sequential, shared context (pivots computed once), SETUP/INVALID/REPLACE log format
- index.ts: Rewired import from engine → pipeline
- Deleted: scanner/entries/ (7 files), scanner/engine.ts, test/entries.test.ts, test/engine.test.ts

**Notes:**
- Test count dropped 79 → 50 (29 old tests removed). New layer tests come in Step 4.
- Runtime verified: starts, backfills 18 coin×TF, WS active, no errors.
- invalidation.ts: UNCHANGED — imported by pipeline.ts.
- StatusSnapshot extended with confluenceGrade field.

---

## Sprint 1.5 — S5: WS Connection Pool Decision

| # | Decision | Choice | Rationale | Status |
|---|----------|--------|-----------|--------|
| S1.5-1 | WS connection pool | **Not needed** | Empirical test: 300 subs / 0 errors / 1626 events in 90s on single SubscriptionClient. 6 missing coins are low-volume ($10K-$237K daily), not cap-related. | [CONFIRMED] 2026-03-30 |
