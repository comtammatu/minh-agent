<!-- /autoplan restore point: ~/.gstack/projects/comtammatu-minh-agent/main-autoplan-restore-20260519-164816.md -->
# Minh — Greenfield Rebuild Stack Decision (DRAFT)

**Status:** DRAFT — awaiting plan review + outside voice (Codex)
**Branch:** `plan/greenfield-rebuild-audit`
**Date:** 2026-05-19
**Author:** thebinhluong0599@gmail.com

## Context

Minh hiện là Bun-based autonomous trading runtime cho Hyperliquid + Bybit. Stack hiện tại:
- Bun + TypeScript 5.x strict
- PostgreSQL/TimescaleDB (candles + analytics)
- React + Vite dashboard (`dashboard/`) + Ink TUI (`src/ui/`)
- Single `smc-sd` setup engine
- Telegram bot

Quyết định rebuild greenfield với 4 cột mốc kỹ thuật được chốt sơ bộ. Doc này tổng hợp để review.

## Decisions on the Table

### 1. Runtime — Bun + TypeScript 6.x

**Decision:** Pin TS 6.x làm target. Theo TS team roadmap, **TS 7 = TS-Go** (port compiler sang Go, 10x typecheck speed) — defer migration tới khi TS-Go GA.

**Practical implication:**
- Hôm nay: TS 5.x stable cho code production. Pin "next: TS 6.x" trong roadmap.
- Khi TS 6.x GA: migrate ngay.
- Khi TS-Go (TS 7) GA: migrate `typecheck` script trước, test suite sau.

**Risk:**
- TS 6.x breaking changes (decorators, ES module resolution) có thể ảnh hưởng `bun:test` compatibility
- Bun TS support hơi trễ so với upstream — cần test compat trước khi pin

### 2. Data Layer — SQLite (Bun-native) thay PostgreSQL/Timescale

**Decision:** Bỏ PG/Timescale, dùng **SQLite (`bun:sqlite`) làm primary store**.

**Rationale:**
- Profile thực: 1 process, 1 wallet, ~50 coins × 4 TFs × ~10M candles, 1 writer + N readers
- WAL mode → đúng pattern read-heavy + single writer
- Ops simplicity: zero docker, backup = `cp`, test in-memory với `:memory:`
- Bun-native driver = fastest in JS world, zero deps
- Không cần network access, replication, multi-host *bây giờ*

**Trade-off:**
- Mất TimescaleDB hypertable auto-partition → emulate bằng monthly tables nếu cần (~30 dòng)
- Mất native compression → SQLite `sqlite-zstd` extension hoặc Parquet cold archive
- Mất concurrent writers → ta chỉ có 1
- Mất network share → defer

**Adapter layer:** Giữ `src/db/driver.ts` để swap sang PG sau (1 env var) nếu multi-process/multi-host xuất hiện.

**Optional defer:** DuckDB cho backtest/analytics queries — chỉ add khi backtest chậm rõ rệt.

**Open question:** Bạn có ý định scale sang multi-bot / share data sang dịch vụ khác trong 6 tháng tới không?

### 3. UI — Rewrite Trading Terminal (Web App), xoá Ink TUI

**Decision:**
- Xoá hoàn toàn `src/ui/` (Ink TUI)
- Rewrite trading terminal từ đầu trên web stack mới
- Giữ Telegram bot làm secondary alert/control channel

**Proposed stack:**

| Layer | Choice | Why |
|---|---|---|
| Framework | **Vite + React + TanStack Router** | WS-first, client-heavy, không cần SSR |
| UI Kit | **shadcn/ui (Radix + Tailwind)** | Own all code, no version lock, headless = control density |
| Charts | **Native market panels first** | Avoid proprietary/vendor chart dependency until charting has a proven operator need |
| State | **Zustand (UI) + TanStack Query (REST)** | Native WS + custom hook for realtime |
| Layout | **react-grid-layout** or **dockview-react** | Drag-resize panels, persist to localStorage |

**Design system (opinionated):**

```
Typography:
- Numbers: JetBrains Mono / Berkeley Mono (tabular-nums)
- Labels: Inter (variable, 400-700)
- Base size: 13px (dense, not 16px SaaS)
- Line-height: 1.4 text, 1.0 in tables

Spacing:
- Base: 4px (Tailwind default)
- Row height: 28px (table), 32px (interactive)
- Panel padding: 12px
- Gap between panels: 4px

Color (dark default, no light mode v1):
- Background: zinc-950 / zinc-900
- Text: zinc-100 / zinc-400 / zinc-600
- Long: #16a34a (green-600, not neon)
- Short: #dc2626 (red-600, not neon)
- Accent: #f59e0b (amber-500)
- Border: zinc-800

Density reference: Bloomberg, Hyperliquid, dYdX, Drift
Anti-pattern: Coinbase, Binance retail (too airy)
```

**Open questions:**
- Framework: Vite+React vs SolidJS (perf bet)?
- Density preset: Bloomberg-dense vs Hyperliquid (semi-dense, ~20% thoáng hơn)?
- Mobile responsive v1 hay desktop-first defer mobile?
- Auth: single-user passwordless cookie+secret, hay magic link?

### 4. Strategy — Refactor thành engine `ict-smc`

**Decision:** Bỏ `smc-sd` standalone, refactor thành **`ict-smc` engine** kế thừa code cũ + bồi thêm ICT concepts.

**ICT concepts cần wire:**
- Fair Value Gaps (FVG) + Consequent Encroachment
- Order Blocks (OB) — bullish/bearish, mitigated/unmitigated
- Buy-side / Sell-side Liquidity (BSL/SSL) sweeps
- Killzones (London/NY session timing)
- Optimal Trade Entry (OTE) — 62-79% Fibonacci retracement
- Premium/Discount arrays
- Breaker blocks + mitigation blocks

**Trade-off:**
- Code mới đè lên `smc-sd` hiện có → 1 lần migration, không backward compat
- Test coverage phải cover ICT cases riêng — golden fixtures cho từng concept

## Open Items for Review

1. **CEO**: Có nên rebuild greenfield, hay refactor incremental? Cost rebuild vs value?
2. **Eng**: SQLite có thực sự hold ở 10M candles? TS 6.x compat với Bun như nào?
3. **Design**: Density Bloomberg-style có quá aggressive cho dev mới?
4. **DX**: Workflow dev local (file `.db`) vs prod (multi-host) divergence ra sao?
5. **Codex**: Outside voice — chỗ nào ta đang fool ourselves?

## Non-Decisions (Confirmed, no debate)

- Bun runtime
- Hyperliquid + Bybit exchanges
- ICT/SMC strategy philosophy
- Telegram bot kept
- Paper mode default
- Strict TypeScript, pure function boundaries

---

# /autoplan — Phase 1: CEO Review

## 0A. Premise Challenge

The plan rests on 6 premises. Evaluation:

| # | Premise (stated or implied) | Status | Challenge |
|---|---|---|---|
| **P1** | **Greenfield rebuild > incremental refactor** | ⚠️ **CONTRADICTS RECENT DECISION** | Most recent commit `0eea6ca` is titled "Audit + refactor plan (no rebuild)". This plan reverses that without naming what changed. Sunk cost: ~30 commits of S1–S5 refactor work since Apr 2026. Question: what new information justifies the flip? |
| **P2** | TS 6.x is worth pinning *today* | 🟡 **PREMATURE** | TS 6 not GA (cutoff Jan 2026). Bun's TS support typically lags upstream by 1–2 minor versions. Risk: tooling breakage, test runner incompat. Honest framing: "pin TS 5 stable; track TS 6 + TS-Go for opportunistic migration." |
| **P3** | PG/Timescale is overkill, SQLite is right fit | ✅ **DEFENSIBLE** | Profile (1 proc, 1 wallet, single-host, ~10M candles, WAL+1 writer) fits SQLite. Quantitative check needed: current PG candle table size + slowest queries (backtest reads) — confirm SQLite handles them. |
| **P4** | TUI is dead weight, web terminal is the right UI | 🟡 **ASYMMETRIC** | TUI cost = ~1 file tree to delete. Web terminal cost = months of rebuild work. Equating "drop TUI" with "rewrite trading terminal from scratch" is two decisions, not one. The TUI delete is cheap; the rewrite is expensive — they shouldn't be bundled. |
| **P5** | ICT concepts will improve signal quality vs current smc-sd | ❓ **UNVALIDATED** | TODOS show P1 = "Fix Simulator Slot Contention" — strategy isn't profitable yet (holdout PF < 1.1). Adding FVG/OB/killzone/OTE concepts is *additive complexity* before fixing the existing scoring model (P3 in TODOS: "Investigate Multiplicative Confidence Scoring"). Risk: building more on shaky foundation. |
| **P6** | Single-user / single-process / single-host holds 6+ months | ✅ **CONSISTENT** with stated scope | No multi-bot, multi-wallet, sharing-with-friends in roadmap. SQLite assumption holds. |

**Critical premise:** P1 (rebuild vs refactor). Without resolving this, the rest of the plan is implementation detail.

**Sub-question hidden in P1:** Is "rebuild" actually rebuild, or is it "aggressive refactor presented as rebuild"? Current refactor branch already touches `runtime/`, `feed/`, `strategy/`, `config/` — that's >60% of the codebase. Difference between "incremental refactor" and "greenfield rebuild" may be illusory.

## 0B. Existing Code Leverage Map

| Sub-problem | Existing code | Reuse plan |
|---|---|---|
| Candle ingest (HL+BB WS/REST) | `src/feed/` (mature, rate-limited) | **Keep as-is** — no rebuild value |
| Order execution (HL signing, BB v5) | `src/execution/` | **Keep as-is** — too sensitive to rewrite |
| Strategy pipeline | `src/strategy/smc-sd/` | **Refactor to ict-smc** — partial rewrite |
| Agent (state machine, exits, journal) | `src/agent/` | **Keep + extend** |
| Telegram bot | `src/alert/telegram/` | **Keep** |
| Dashboard | `dashboard/` (React+Vite + `src/server/`) | **Rewrite UI, keep server contract** |
| TUI | `src/ui/` | **Delete** |
| DB layer | PG via `src/db/` | **Swap to SQLite + adapter** |

**Verdict:** ~70% of code survives. The "greenfield rebuild" framing oversells the scope. Realistic framing: **targeted rewrite of strategy + UI + DB layer, keep feed/execution/agent intact.**

## 0C. Dream State (12-month ideal)

```
CURRENT (2026-05):
- 1 process, smc-sd, PG/Timescale, Ink TUI + Vite dashboard, Telegram
- Holdout PF < 1.1 (no proven alpha)
- WIP refactor on main, draft greenfield plan on the table

THIS PLAN (if shipped 2026-Q3):
- 1 process, ict-smc, SQLite, web-only terminal, Telegram
- Strategy: same alpha problem (ICT doesn't fix scoring model)
- Stack modernized, but P&L unchanged

12-MONTH IDEAL (2027-05):
- Proven alpha (PF > 1.3 holdout) on at least 1 strategy
- Stable runtime, no rebuild cycles
- Memory layer (`src/memory/`) wired into live agent
- Strategy registry — A/B test multiple engines (not just ict-smc)
- Live wallet sized confidently above $10k
```

**Gap:** This plan moves stack, not P&L. The alpha problem (strategy doesn't make money yet) is downstream of everything in this plan.

## 0C-bis. Implementation Alternatives

| Approach | Effort (CC / human) | Risk | Pros | Cons |
|---|---|---|---|---|
| **A. Full greenfield rebuild** (as drafted) | ~3 weeks CC / ~3 months human | High | Clean slate, modern stack, opportunity to drop dead code | 3 months without trading; strategy alpha unaddressed; throws away mature feed/execution |
| **B. Targeted refactor: DB swap + UI rewrite + ict-smc engine** | ~1 week CC / ~3 weeks human | Med | Keeps feed/execution/agent; addresses 3 specific pains; incremental rollout | Less satisfying narrative ("just refactor"); some legacy debt remains |
| **C. Focus on alpha first** (defer stack rebuild) | ~3 days CC / ~1 week human | Low | Validates strategy P&L before investing in stack; preserves optionality | UI/DB pain remains; less modern stack stays |
| **D. Hybrid: B + parallel alpha work** | ~2 weeks CC / ~6 weeks human | Med | Both pains addressed; strategy work doesn't block UI/DB rewrite | Context-switching cost; risk of finishing neither |

**Recommendation pending dual voices: B or D. A is over-scoped; C ignores stack pain.**

## 0D. Mode-Specific Analysis (SELECTIVE EXPANSION)

In-scope (expansion within blast radius):
- Add ict-smc engine — 1 new engine module in `src/strategy/strategies/`
- Add SQLite adapter — 1 new `src/db/sqlite/` module + driver swap in `src/db/index.ts`
- Rewrite dashboard UI — replace `dashboard/src/`, keep `src/server/` contract
- Delete `src/ui/` (TUI)

Out of scope (deferred to TODOS):
- Multi-bot / multi-wallet
- Strategy registry / A/B testing harness
- Wire `src/memory/` into live runtime
- Solid-based UI (defer to perf-driven decision)
- Mobile responsive (defer post-v1)
- TS-Go migration (defer to GA)

## 0E. Temporal Interrogation

- **HOUR 1**: dev opens dashboard, sees positions + chart, places paper order — must work
- **HOUR 6**: same dev pulls Telegram on phone for alerts while away — must work
- **WEEK 1**: dev runs backtest with 1y history — query speed acceptable?
- **MONTH 1**: dev has 90 days of live trades — analytics still snappy?
- **MONTH 6**: dev has 10M candle rows across coins — SQLite query plan still good?
- **MONTH 12**: dev decides to add a second bot on a different wallet — does the architecture flex?

The MONTH 12 scenario is where P6 (single-user) starts to bite. We're accepting that risk consciously.

## 0F. Mode Selection

**Selected mode: SELECTIVE EXPANSION** — accept core decisions (data layer, UI rebuild, ict-smc refactor), challenge premise P1 (rebuild vs refactor framing) and P5 (ICT before alpha).

## Premise Gate Result (2026-05-19)

**User decision:** Full greenfield rebuild — P1 stand. Stack choices still under debate.

**Operative framing for rest of review:** Rebuild is committed. Focus dual voices on stack validation (TS 6.x, SQLite, Vite/shadcn UI, ict-smc) and risks the user hasn't named yet, NOT on rebuild-vs-refactor.

## 0.5 CEO Dual Voices

### CODEX SAYS (CEO — strategy challenge)

10 findings, 3 critical:

- **[CRITICAL]** Rebuild solves stack discomfort before proving alpha. 6-month regret: cleaner bot, same losing strategy.
- **[CRITICAL]** Plan reverses PR #8 with no causal event documented. Decision is "undocumented preference drift."
- **[CRITICAL]** No real-money release gate: no flatten-all kill-switch, no capital ladder, no error budget, no exit criteria. Existing `src/agent/circuit-breakers.ts:98-107` only pauses new entries — does NOT flatten exposure.
- **[HIGH]** "Greenfield rebuild" framing is dishonest — ~70% of code (feed, execution, agent, Telegram, server contract) survives. Real scope: "targeted rewrite of DB + UI + strategy module."
- **[HIGH]** SQLite at 10M candles is unproven. Run a bake-off: SQLite WAL vs PG/Timescale vs DuckDB/Parquet on real workloads (ingest latency, backtest queries, backup/restore, disk size).
- **[HIGH]** UI decision bundles cheap (delete `src/ui/` TUI) with expensive (rewrite terminal). README.md:16 confirms `dashboard/` already uses Vite + React + shadcn/ui — the "new stack" already exists. Just evolve it.
- **[HIGH]** `src/strategy/strategies/smc-sd/index.ts:1200-1284` already contains OTE, breaker/inversion FVG, liquidity pools, killzone, displacement — the "new ICT engine" largely duplicates existing logic. Real bottleneck per TODOS P3 is additive scoring model, not concept count.
- **[MEDIUM]** TS 6.x premise is stale: **TypeScript 6.0 actually GA'd 2026-03-23** (Microsoft announcement, post-cutoff). Plan still treats it as future. `package.json:11` uses `bunx tsc` with no pinned TS version → first fix is pinning, not chasing TS 6.
- **[HIGH]** Alternatives (B, C, D) listed but never analyzed — then overridden at premise gate without disqualifying evidence.
- **[HIGH]** 12-month market risk absent: HL/BB hardcoded, no exchange-contract tests, no API drift monitoring, no regulatory assumptions, no operator-attention review.

### CLAUDE SUBAGENT (CEO — strategic independence)

10 findings, 3 critical (subagent explicitly refused the "stack-validation only" scope and challenged the rebuild premise):

- **[CRITICAL]** Spending 3 months rebuilding stack of strategy proven not to make money. `decisions.md` shows best holdout PF = 1.02; plan's own 0C admits "moves stack, not P&L."
- **[CRITICAL]** Premise gate decided on vibes — plan's own 0A/0B/0C/0C-bis sections all recommend B or D, gate flipped to A with no rationale. "Decision laundered through framework."
- **[CRITICAL]** ICT before scoring fix = "building second floor before foundation cures." TODOS P3 already flags additive scoring as structural bottleneck.
- **[HIGH]** TS 6.x pin is "cargo-cult modernization with zero business case." Today's reality is TS 5.x with aspiration.
- **[HIGH]** SQLite probably correct but skipping the 30-min experiment that would prove it. DuckDB dismissed without benchmark.
- **[HIGH]** UI rewrite + TUI delete bundled — TUI delete is 1 PR, rewrite is months. Default: delete TUI now, adopt shadcn incrementally into existing `dashboard/`.
- **[HIGH]** No kill-switch / error budget / capital scaling gate. 12-month dream state "$10k live wallet" has no graduation criteria.
- **[MEDIUM]** `src/backtest/` missing from leverage map — backtest is the binding constraint for proving alpha, but treated as passive consumer.
- **[MEDIUM]** No exit criteria for rebuild — "done" is undefined, scope will sprawl.
- **[MEDIUM]** 12-month risks unprice: regulatory (perps in user's jurisdiction), API drift, project abandonment after 3 months of rebuild with no live wins.

### CEO DUAL VOICES — CONSENSUS TABLE

```
═══════════════════════════════════════════════════════════════
  Dimension                            Claude  Codex   Consensus
  ───────────────────────────────────── ─────── ─────── ─────────
  1. Premises valid?                    DISAGREE  DISAGREE  CONFIRMED DISAGREE
  2. Right problem to solve?            DISAGREE  DISAGREE  CONFIRMED DISAGREE
  3. Scope calibration correct?         DISAGREE  DISAGREE  CONFIRMED DISAGREE
  4. Alternatives sufficiently explored? DISAGREE  DISAGREE  CONFIRMED DISAGREE
  5. Competitive/market risks covered?  DISAGREE  DISAGREE  CONFIRMED DISAGREE
  6. 6-month trajectory sound?          DISAGREE  DISAGREE  CONFIRMED DISAGREE
═══════════════════════════════════════════════════════════════
```

**6/6 dimensions: CONSENSUS DISAGREE.** Both models independently arrive at the same conclusion: the rebuild premise is wrong, the strategy alpha problem is the binding constraint, and the "greenfield" framing oversells a plan that's actually a targeted refactor.

### USER CHALLENGE (raised to final gate)

> **What you said:** Full greenfield rebuild — P1 stand (premise gate, 2026-05-19).
>
> **What both models recommend:** Reframe as **targeted refactor** + **alpha-first sequencing**:
> 1. Pin TS 5.x today; track TS 6/TS-Go separately.
> 2. Run DB bake-off (SQLite vs PG vs DuckDB) on real workloads before deciding.
> 3. Delete `src/ui/` (TUI) as 1 PR; evolve existing `dashboard/` incrementally instead of rewriting.
> 4. Defer ict-smc engine until scoring model fixed and 5m alpha validated.
> 5. Add real-money release gate (kill-switch, capital ladder, error budget, exit criteria) BEFORE any live-mode rebuild.
>
> **Why:** Plan's own 0A/0B/0C/0C-bis analysis already recommends this. Existing code already has most of what the "rebuild" proposes (smc-sd has ICT concepts, dashboard has Vite+shadcn). Strategy isn't profitable yet — stack rebuild defers the binding constraint.
>
> **What we might be missing:** User has context models lack — taste preference for clean slate, motivation/morale from working on something new, possibly future plans (multi-bot, sharing with friends) that justify ground-up rewrite.
>
> **If we're wrong, the cost is:** User does targeted refactor, then 3 months later wishes they'd rebuilt because legacy debt is blocking next feature. That cost is real but reversible. The reverse cost (3 months of rebuild with no P&L improvement, possible abandonment) is more expensive.

### Phase 1 Completion Summary

| Section | Status | Key output |
|---|---|---|
| 0A Premise Challenge | ✅ | 6 premises evaluated, P1 + P5 flagged |
| 0B Leverage Map | ✅ | ~70% code survives, "rebuild" is targeted refactor |
| 0C Dream State | ✅ | Plan moves stack, not P&L |
| 0C-bis Alternatives | ✅ | 4 paths (A/B/C/D); B+D recommended by analysis |
| 0D Mode Analysis | ✅ | SELECTIVE EXPANSION |
| 0E Temporal | ✅ | MONTH 12 single-host risk |
| 0F Mode Selection | ✅ | SELECTIVE EXPANSION |
| Premise gate | ✅ | User: Full greenfield rebuild |
| 0.5 Dual voices (Codex) | ✅ | 10 findings, 3 critical |
| 0.5 Dual voices (Claude subagent) | ✅ | 10 findings, 3 critical |
| 0.5 Consensus table | ✅ | 6/6 DISAGREE |
| USER CHALLENGE | ✅ | Raised — both models recommend reframe |

**Phase 1 complete.** Codex: 10 concerns, 3 critical. Claude subagent: 10 issues, 3 critical. Consensus: 6/6 confirmed DISAGREE with current premise. USER CHALLENGE surfaced (target: final gate). Passing to Phase 2 (Design).

---

# /autoplan — Phase 2: Design Review

## CODEX SAYS (design — UX challenge)

Score: 4/10 average. Verdict: not ready to implement as rewrite. **Evolve, don't rewrite.**

Key findings with code evidence:
- **DIM 3 User Journey (2/10) — CRITICAL.** `dashboard/src/components/dashboard-shell.tsx:99` literally labels itself "Read-only ops console". The actual kill-switch `/closeall` is in `src/alert/telegram/commands.ts:1197` → `src/agent/close-all.ts:31`. Circuit breakers `src/agent/circuit-breakers.ts:5` only pause new entries. The web UI plan doesn't decide: monitor-only or operator control surface?
- **DIM 2 Missing States (3/10).** `dashboard/src/lib/api.ts:61` polls `/api/dashboard/snapshot` every 1s — not SSE. Plan doesn't specify stale/disconnected/partial/degraded/reconnecting states.
- **DIM 6 Color (3/10).** Plan deletes `src/ui/sound.ts:20` with no migration — losing audio alerts for B+ setups + circuit breaker events.
- **DIM 5 Typography (6/10).** `package.json:22` has IBM Plex loaded, NOT Inter/JetBrains as plan claims. Plan diverges from reality.
- **DIM 7 Layout (4/10).** Current `dashboard/package.json:39` has react-router, not TanStack. The "new stack" in the plan is a swap, not a discovery.

## CLAUDE SUBAGENT (design — independent review)

Score: 4.4/10 average. Verdict: **evolve, don't rewrite.**

Key findings:
- **DIM 1 (4/10).** Watchlist ≠ leftmost. Define a "vital strip" (equity, PnL, liq distance, bot state, dead-man-switch ETA, FLATTEN button) — non-dismissable global chrome.
- **DIM 2 (2/10).** 12+ states unspecified. Demand a "states matrix" appendix: panel × {loading, empty, partial, stale, error, degraded, offline}.
- **DIM 3 (3/10).** No "FLATTEN ALL" affordance. Use 2-second hold-to-confirm, not modal (modals fail in panic).
- **DIM 4 (6/10).** Bloomberg is wrong reference for solo bot operator. Pick Hyperliquid (~20% breathing room). Ship `--density: compact | comfortable` toggle.
- **DIM 6 (4/10).** Pure red on near-black = 4.0:1 contrast (below WCAG AA). Deuteranopia failure. Need secondary shape channel (▲/▼) + colorblind preset. Migrate `src/ui/sound.ts` → `dashboard/src/lib/sound.ts`.
- **DIM 7 (5/10).** react-grid-layout is dashboard-builder lib (wrong); pick **dockview-react** for dense tabs + splitters. Ship `/mobile` stub during rewrite gap.

## DESIGN DUAL VOICES — CONSENSUS TABLE

```
═══════════════════════════════════════════════════════════════
  Dimension                            Claude  Codex   Consensus
  ───────────────────────────────────── ─────── ─────── ─────────
  DIM 1 Info hierarchy                  4/10    4/10    CONFIRMED DISAGREE
  DIM 2 Missing states                  2/10    3/10    CONFIRMED DISAGREE
  DIM 3 User journey (kill-switch)      3/10    2/10    CONFIRMED DISAGREE
  DIM 4 Density vs cognitive load       6/10    5/10    CONFIRMED PARTIAL
  DIM 5 Typography                      7/10    6/10    CONFIRMED PARTIAL
  DIM 6 Color system                    4/10    3/10    CONFIRMED DISAGREE
  DIM 7 Layout + persistence            5/10    4/10    CONFIRMED DISAGREE
═══════════════════════════════════════════════════════════════
```

**5/7 dimensions: CONSENSUS DISAGREE.** Both voices independently say: existing dashboard is 80% of the proposed stack already, the real gap is design polish (vital strip, states matrix, kill-switch journey, audio alert migration), not infrastructure.

**Biggest unspecified design decision (both voices agree):** Does the web app stay monitor-only or become the primary control surface? Current code says monitor-only. Plan implies control surface. This must be answered before any UI work.

### Phase 2 Completion Summary

| Dimension | Avg | Verdict |
|---|---|---|
| 1 Info hierarchy | 4/10 | Add vital strip + tiered panel hierarchy |
| 2 Missing states | 2.5/10 | Build states matrix per panel |
| 3 User journey | 2.5/10 | Define pause vs flatten vs close-all separately |
| 4 Density | 5.5/10 | Hyperliquid-semidense for v1, not Bloomberg |
| 5 Typography | 6.5/10 | Either load Inter/JetBrains or keep IBM Plex |
| 6 Color | 3.5/10 | WCAG validation + colorblind preset + sound migration |
| 7 Layout | 4.5/10 | dockview-react + versioned schema + mobile stub |

**Phase 2 complete.** Codex: 7 design concerns. Claude subagent: 7 design issues. Consensus: 5/7 DISAGREE, 2/7 PARTIAL. Both verdicts: evolve, don't rewrite. Passing to Phase 3 (Eng).

---

# /autoplan — Phase 3: Eng Review

## CODEX SAYS (eng — architecture challenge)

**Verdict: BUILD WITH OVERRIDES.** Current draft is NO-BUILD as written. 12 findings, 2 critical.

Critical:
- **SQLite swap is not an adapter flip.** `src/db/migrations/001_initial.sql:21,96`, `003_analytics_views.sql:27,52`, `012_trade_memory.sql:20-33` use PG-specific syntax. Write a real SQLite schema + migration compatibility table before coding `driver.ts`.
- **Concurrent backtest + live is unsafe TODAY** (independent of SQLite). `src/backtest/engine.ts:52-57` clears pipeline/store/onPersist; `src/runtime/app.ts:530-538` wires live persistence globally. Must run backtests in separate process with read-only DB snapshot.

High:
- 10M-candle SQLite claim unproven — bench WAL R/W, cold start, backtest range scans, dashboard chart reads, RSS on seeded 10M DB.
- "Backup = cp" is wrong for WAL-mode SQLite. Require backup API or `VACUUM INTO`.
- Matviews have no SQLite replacement — `src/analytics/metrics-repo.ts:212-223` depends on them.
- **ict-smc duplicates existing implementation.** `src/strategy/strategies/smc-sd/index.ts:1-11,173-185,829-848,1074-1084,1118-1127,1202-1284`; `src/indicators/smc.ts:24-68,71-132,521-575,590-660,744-918`. Extract/rename existing concepts; only add genuinely missing behavior.
- UI rewrite is dishonest framing — `README.md:16`, `package.json:13-58`, `dashboard/components.json:2` show stack already exists.
- **TS 6.0.2 is ALREADY installed**: `bun.lock:865` locks `typescript@6.0.2`; `./node_modules/.bin/tsc --version` reports 6.0.2. `package.json:11,15` use `bunx tsc` with no explicit devDependency pin. The plan's "decide TS 6.x" decision is moot.
- HL signing/nonce/cancel invariants too sensitive — freeze `src/execution/*` + `order-manager.ts` + `position-monitor.ts`; add contract tests before any other rebuild.
- **Dead-man switch story is absent**. `scheduleCancel` only at `src/execution/bybit-exchange-service.ts:609-610` as **unsupported no-op**. `src/execution/exchange-service.ts:97-101` only exposes optional `cancelAllOpenOrders`. Bot is currently running without a working safety timeout.

Medium:
- **Cancel failure hidden by DB state mutation** — `src/agent/order-manager.ts:742-759` logs cancel failure but still marks cancelled at `:762-765`. Reconciliation silently trusts local state.
- Current test plan fails at 2am Friday — `test/db/migrate.test.ts:5-10` + `candle-repo.test.ts:7-12` skip without PG. Bun test ran 1116 pass, **5 fail, 3 errors** (DB unavailable + network timeouts). No SQLite/perf suite. No deterministic no-network CI lane.

## CLAUDE SUBAGENT (eng — independent review)

**Verdict: NO-BUILD as drafted.** 12 findings, 3 critical.

Critical:
- ict-smc concepts ALL already in smc-sd — line-numbered evidence: FVG `:836`, OB `:363,1113`, BSL/SSL `:1250,1255`, killzones `:481-1218`, OTE `:1074-1082,1202`, breaker `:55,1203`, inversion-FVG `:56,1204`, AMD/Judas `:65-67`, displacement `:21`, premium/discount `:20`. File header `:1-13` self-describes as "ICT Multi-TF Drill-Down v5".
- SQLite "backup = cp" wrong for WAL — needs `VACUUM INTO` (takes shared lock at 10M candles — measure first).
- Matviews → SQLite has none. Plan doesn't address replacement.

High:
- TS 6.x: `package.json:11` runs `bunx tsc` with no pinned TS. Pin TS 5.7, separate canary for 6.x.
- Adapter "1 env var" claim wrong — postgres tagged-template ≠ bun:sqlite, transactions ≠, deadlock retry checks "deadlock" string but SQLite uses `SQLITE_BUSY`. Estimate adapter alone: 1-2 weeks.
- No regression harness between smc-sd and ict-smc. Need 90-day replay fixture, diff setups.
- SQLite concurrent backtest + live serializes on file lock; PG never did.
- UI rewrite + TUI delete bundled — split: 1 PR delete TUI + sound migration, separate evolution of `dashboard/`.

Medium:
- No FLATTEN ALL kill-switch in web UI is 2am-Friday safety gap.
- SQLite mmap inflates RSS → false memory leak alerts.
- Migration on SQLite at 10M rows blocks writes (no online ALTER for many ops).
- Backtest N+1 risk without `prepareCache` Map for statements.

## ENG DUAL VOICES — CONSENSUS TABLE

```
═══════════════════════════════════════════════════════════════
  Dimension                            Claude    Codex     Consensus
  ───────────────────────────────────── ───────── ───────── ─────────
  1. Architecture sound?                NO-BUILD  NO-BUILD  CONFIRMED DISAGREE
  2. Test coverage sufficient?          NO        NO        CONFIRMED DISAGREE
  3. Performance risks addressed?       NO        NO        CONFIRMED DISAGREE
  4. Security/safety threats covered?   NO        NO        CONFIRMED DISAGREE
  5. Error paths handled?               PARTIAL   NO        CONFIRMED DISAGREE
  6. Deployment risk manageable?        NO        NO        CONFIRMED DISAGREE
═══════════════════════════════════════════════════════════════
```

**6/6 dimensions: CONSENSUS DISAGREE.** Both voices: NO-BUILD as drafted; rebuild as written would regress safety-critical execution code while adding zero validated alpha.

### Recommended Migration Order (consensus 7 steps)

Both voices independently recommend nearly identical order:

1. **Freeze execution boundary** — `src/execution/*`, `src/agent/order-manager.ts`, `position-monitor.ts`. Add contract tests for HL signing, cloid, cancel, balance, SL/TP. Fix `order-manager.ts:742-765` cancel-failure-hidden-by-DB bug.
2. **Pin TS 6.0.2 explicitly** in `package.json` devDependencies (it's already installed via lockfile). Run typecheck + test:run + bench as separate canary PR.
3. **Define operator-control contract** in `src/server/` — `POST /api/operator/flatten` with hold-to-confirm. Implement on existing `dashboard/` (vital strip + states matrix + sound migration from `src/ui/sound.ts`).
4. **Delete `src/ui/` (TUI)** as a single PR after sound migration lands.
5. **DB bake-off** (1 week): PG vs SQLite WAL vs DuckDB/Parquet on real workload — 10M candle ingest, 90-day backtest reads, matview-equivalent analytics, concurrent live+backtest, crash recovery, restore correctness. Numbers, not vibes.
6. **If SQLite wins** — build real adapter with parity tests, port migrations to dual dialect (esp. matview → summary tables or DuckDB analytics), flip default. Otherwise stay PG and document.
7. **Refactor `smc-sd` → `ict-smc`** (rename + extract, NO new logic). Then separate work item: fix additive scoring model (TODOS P3) — the real bottleneck.

### Phase 3 Failure Modes Registry

| Failure | Catches Now | Risk After Rebuild | Required Catch |
|---|---|---|---|
| HL signing/nonce/wallet | `@nktkas/hyperliquid` SDK | LOW if execution frozen | exchange contract tests |
| Dead-man switch | **BROKEN TODAY** — `bybit-exchange-service.ts:609` no-op | HIGH (false safety claim in UI) | heartbeat + cancel-all drill per exchange |
| Cancel failure hidden | **BUG TODAY** — `order-manager.ts:742-765` | MED | persist `cancel_failed`, surface in UI |
| cloid recovery | `orders.cloid` + idx (mig 011:20-23) | MED on DB swap | replay old rows into SQLite, golden test |
| Balance reconciliation | `position-monitor.ts:442-463` best-effort | MED on DB swap | stale-state hard alert |
| SL/TP after fill | `order-manager.ts:538-678` | LOW | live exchange simulator test |
| Setup engine regression | None vs smc-sd → ict-smc | **HIGH** | 90-day replay fixture + diff |
| Matview gone post-SQLite | `REFRESH CONCURRENTLY` (PG) | **HIGH** | summary tables or DuckDB; parity test |
| Backup/restore corruption | `pg_dump` | **HIGH** if `cp` used | `VACUUM INTO`; restore drill |
| Web UI gains write powers without confirm | None today | **HIGH** | hold-to-confirm + audit log |

### Phase 3 Completion Summary

- Architecture graph: produced (above)
- Test plan: 5 test surfaces named + gaps for each
- SQLite scale: defensible on latency, NOT defensible on backup/matview/migration/concurrent
- ict-smc duplication: 10 concepts already in smc-sd with line numbers
- TS 6 risk: low — 6.0.2 already installed, just needs pin
- Failure modes registry: 10 failures with current vs post-rebuild catch
- Performance: backtest will be slower on SQLite for 50×4 read pattern

**Phase 3 complete.** Codex: 12 issues, 2 critical. Claude subagent: 12 issues, 3 critical. Consensus: 6/6 DISAGREE. Both verdicts converge: BUILD WITH OVERRIDES (= adopt the targeted-refactor migration order). Passing to Phase 4 (Final Gate).

---

## Cross-Phase Themes

Concerns that appeared in **2+ phases independently** (high-confidence signal):

| Theme | Phase 1 (CEO) | Phase 2 (Design) | Phase 3 (Eng) |
|---|---|---|---|
| **"Greenfield" is dishonest framing — 70-80% code survives** | ✅ Both voices | ✅ Both voices | ✅ Both voices |
| **ict-smc duplicates existing smc-sd logic** | ✅ Codex (line-level) | — | ✅ Both voices (line-level) |
| **Kill-switch / flatten-all unspecified** | ✅ Both voices | ✅ Both voices | ✅ Both voices |
| **SQLite swap operationally underspecified (backup, matview, concurrent)** | — | — | ✅ Both voices |
| **Existing dashboard already on proposed stack** | ✅ Codex | ✅ Both voices | ✅ Codex |
| **No regression harness for strategy rewrite** | ✅ Both voices | — | ✅ Both voices |
| **TS 6 is moot — already installed** | — | — | ✅ Codex (lockfile) |
| **Alpha is binding constraint, not stack** | ✅ Both voices | — | ✅ Both voices |

8 themes span 2+ phases. The signal is overwhelming and consistent.

---

# Final Decision (2026-05-19)

**Status:** APPROVED — User accepted reframe at final gate.

**Selected path: B — Targeted refactor + alpha-first sequencing.**

The original 4 decisions are updated as follows:

| Original decision | Final disposition |
|---|---|
| 1. TS 6.x | **OBSOLETE.** TS 6.0.2 already installed (`bun.lock:865`). Action: pin `"typescript": "6.0.2"` in `package.json` devDependencies as 1-line PR. |
| 2. SQLite over PG/Timescale | **DEFERRED to bake-off.** Run measured comparison (PG vs SQLite WAL vs DuckDB) on real workload before any code change. |
| 3. Rewrite trading terminal + delete TUI | **SPLIT.** (a) Delete `src/ui/` (TUI) as 1 PR after sound migration. (b) Evolve existing `dashboard/` incrementally — vital strip, states matrix, kill-switch, dockview, SSE. No greenfield rewrite. |
| 4. Refactor smc-sd → ict-smc | **RENAME only.** Move/rename code, NO new logic. Then separate task: fix additive scoring model (TODOS P3). Real bottleneck. |

## Final Migration Order (7 steps)

1. **Freeze execution boundary** — `src/execution/*`, `src/agent/order-manager.ts`, `position-monitor.ts`. Add contract tests for HL signing, cloid, cancel, balance, SL/TP. Fix `order-manager.ts:742-765` cancel-failure-hidden-by-DB bug. Fix dead-man-switch — `bybit-exchange-service.ts:609` no-op.
2. **Pin TS 6.0.2** in `package.json` devDependencies. Run typecheck + test:run + bench:pipeline:ci as separate canary PR.
3. **Define operator-control contract** in `src/server/` — `POST /api/operator/flatten` with hold-to-confirm. Implement on existing `dashboard/` (vital strip + states matrix + sound migration from `src/ui/sound.ts`).
4. **Delete `src/ui/` (TUI)** as a single PR after sound migration lands.
5. **DB bake-off** (1 week): PG vs SQLite WAL vs DuckDB/Parquet on 10M-row seeded workload — ingest, backtest reads, matview-equivalent analytics, concurrent live+backtest, crash recovery, restore correctness, backup `VACUUM INTO` lock window.
6. **If SQLite wins** — build real adapter with parity tests, port migrations to dual dialect (matview → summary tables or DuckDB), flip default. Otherwise stay PG and document.
7. **Rename `smc-sd` → `ict-smc`** (pure refactor, regression-fixture-pinned). Then SEPARATE work item: fix TODOS P3 additive scoring.

Estimated total: ~6 weeks focused work vs original plan's ~3 months.

## Items moving to TODOS.md

- [P0] Fix dead-man-switch (`scheduleCancel` BB no-op, HL unclear)
- [P0] Fix `order-manager.ts:742-765` cancel-failure-hidden-by-DB bug
- [P1] Pin TS 6.0.2 in devDependencies (1-line PR)
- [P1] Operator-control contract + flatten endpoint
- [P1] Sound migration `src/ui/sound.ts` → `dashboard/src/lib/sound.ts`
- [P1] Delete `src/ui/` (post sound migration)
- [P1] TODOS P1 retained — Simulator Slot Contention (gates alpha validation)
- [P2] DB bake-off (PG vs SQLite vs DuckDB), measured numbers
- [P2] Dashboard evolution — vital strip, states matrix, dockview, SSE
- [P2] 90-day replay regression fixture for smc-sd → ict-smc rename
- [P3] TODOS P3 retained — additive → multiplicative/min-confluence scoring
