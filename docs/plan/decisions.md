# Minh (明) — Decision Log

All architectural and engineering decisions made during plan reviews.

---

## Original Plan Review (Flat Architecture — superseded)

Các quyết định dưới đây được đưa ra cho kiến trúc flat 8-detector ban đầu. Nhiều quyết định vẫn valid (C1, C2, C3, C7-C9, E1-E2, E4-E9). Một số đã thay đổi do chuyển sang Layered Decision Framework.

### CEO Review

| # | Decision | Choice | Rationale | Status |
|---|----------|--------|-----------|--------|
| C1 | Regime filter mode | **Soft filter** — reduce confidence, never block | Counter-trend setups still valid with lower confidence | ✓ Vẫn đúng — regime modulate, không gate |
| C2 | Strength threshold | **0.4** after regime penalty | Sweet spot for filtering | ✓ Vẫn đúng |
| C3 | Persistence | **No SQLite** — in-memory only | Sprint 1 read-only, backfill acceptable | ✓ Vẫn đúng cho Sprint 1 |
| C4 | HTTP server | **No Elysia** — pure CLI | Terminal sufficient for Sprint 1 | ✓ Vẫn đúng |
| C5 | Exit strategies | **Deferred to Sprint 2** | Read-only Sprint 1 | ✓ Vẫn đúng |
| C6 | HTF cross-reference | ~~Deferred~~ → **Sprint 1 Layer 1** | **CHANGED**: HTF bias là core của Layer 1, không phải enhancement | ✗ Overridden |
| C7 | WS disconnect | **Auto-reconnect only** | ReconnectingWebSocket handles retries | ✓ Vẫn đúng |
| C8 | Candle dedup | **Upsert by timestamp** | WS overwrite with real-time close | ✓ Vẫn đúng |
| C9 | TF subscription | **WS subscribe per TF** | HL supports all intervals natively | ✓ Vẫn đúng |

### Eng Review

| # | Issue | Choice | Rationale | Status |
|---|-------|--------|-----------|--------|
| E1 | WS permanent failure | **Staleness watchdog** | Zero silent failures | ✓ Vẫn đúng |
| E2 | Backfill ordering | **Sequential** | Safe against rate limit | ✓ Vẫn đúng |
| E3 | Entries file structure | ~~Per-domain entries~~ → **Layered pipeline** | **CHANGED**: entries/ replaced by layers/ | ✗ Overridden |
| E4 | Types port | **Clean type subset** | No dead types from Tuệ | ✓ Vẫn đúng |
| E5 | Indicator port strategy | **Rewrite fresh, Tuệ as spec** | Clean room implementation | ✓ Vẫn đúng |
| E6 | Regime multipliers | **In config.ts** | Configurable tuning | ✓ Vẫn đúng |
| E7 | Test scope | ~~6 test files~~ → **~12 test files** | **CHANGED**: per-layer tests + pipeline integration | ✗ Expanded |
| E8 | Golden tests | **Snapshot fixtures from Tuệ** | Proves algorithmic equivalence | ✓ Vẫn đúng |
| E9 | Store getCandles | **slice() now** | Ring buffer when needed | ✓ Vẫn đúng |

---

## Domain Knowledge Analysis (Layered Framework)

Quyết định từ phiên phân tích domain knowledge — refactor từ flat sang layered.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Architecture | **Layered Decision Framework** — 5 layers tuần tự + regime song song | Flat 8-detector sai taxonomy: 5/8 detector ở sai vai trò (VSA/VP = confirm, PA = trigger, Wyckoff = bias) |
| D2 | knowledge-spec.md | **Tổ chức theo trường phái** thay vì "Domain 1,2,3,4" | Đúng bản chất: Wyckoff, SMC, Price Action, S&D, VSA, Order Flow, Indicator-Based |
| D3 | Volume Profile | **Thuộc Order Flow** — không phải domain riêng | Section 1.9 domain knowledge: VP là 1/6 tools trong Order Flow family |
| D4 | detectRegime | **Indicator-Based, regime context** — không phải Layer 1 bias | Indicator-Based lag tại inflection point. Wyckoff+SMC mới là true bias |
| D5 | detectStructuralBias | **Price Action, Layer 2** — không phải SMC | HH/HL/LH/LL là PA thuần, có trước SMC hàng thập kỷ |
| D6 | Docs structure | **3 thư mục**: plan/ spec/ ref/ | plan = sprint plans, spec = architecture + knowledge-spec, ref = domain knowledge |
| D7 | Domain knowledge file | **Copy source vào project** (docs/ref/) + cross-reference | knowledge-spec (HOW) + domain-knowledge (WHY) — 2 file, 2 vai trò |

---

## CEO Plan Review — Layered Framework (HOLD SCOPE)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| L1 | Sprint 1 scope | **Phase A + Phase B** | Phase A: layered pipeline (OHLCV). Phase B: new data feeds (Funding+Trades+L2). Reduce blast radius |
| L2 | Bias conflict | **CHoCH rule** | Accumulation + bearish BOS → chờ CHoCH. Trước CHoCH = neutral. Spring invalidation: close < low - ATR×1.5 → Re-distribution |
| L3 | Zone distance | **Risk filter, NOT Layer 3 STOP** | Zone xa → giảm size + tăng min R:R (Section 12). Không block signal, điều chỉnh risk |
| L4 | HTF scope | **Sprint 1** (không defer Sprint 2) | HTF bias là Layer 1 core, thiếu = layered framework không đầy đủ |
| L5 | SMC concepts mới | **Sprint 1** — Premium/Discount Zone + OTE | Nâng chất lượng Layer 3 zones ngay từ đầu |
| L6 | HL data scope | **Full**: Funding + Trades + L2 Book | Layer 4 cần true Order Flow, không chỉ OHLCV approximation |
| L7 | domain-knowledge.md sync | **Sync ngay** — sections 11+12 missing | Conflict resolution + risk management rules cần cho Sprint 1 |
| L8 | L2 book safety | **Cap top 20 levels** bid/ask | Prevent memory exhaustion từ deep book |
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
