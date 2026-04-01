# Minh (明) — Sprint 4: EXPAND — Telegram Control + Dashboard Extensions

## Goal

Add **Telegram bot control interface** for mobile monitoring/control and **extend the Dashboard** with missing features identified during Sprint 3. Fix carried tech debt.

**Sprint 4 = EXPAND. Make the system operable from anywhere.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine (pipeline, indicators, structure)
Sprint 2: ACT        ✅ → Agent execution (state machine, orders, risk, safety)
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     🔲 → Telegram + Dashboard extensions + tech debt
Sprint 5: ADVISE     🔲 → Basic LLM Advisor (gate: ≥ 100 trades)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning Loop)
```

---

## Kickoff Review Summary (2026-04-01)

### Sprint 3 DoD: ALL CONFIRMED
- 3A Backtest: 4/4 CONFIRMED
- 3B Analytics: 3/3 CONFIRMED
- 3C Dashboard: 4/4 CONFIRMED
- Always: 3/3 CONFIRMED (857 pass, 4 pre-existing logger failures)
- `[CARRIED]` 4 logger test failures → Sprint 4 S1

### CEO Review Decisions (HOLD SCOPE)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| U1 | Telegram bot mode | **Long-polling** | No public URL/TLS needed. Single-user bot. Server is 127.0.0.1 |
| U2 | Telegram auth | **Chat ID whitelist** | Reuse existing TELEGRAM_CHAT_ID env var. Reject all other senders |
| U3 | Backtest execution | **POST + SSE progress** | Reuse existing SSE infrastructure. Real-time progress feedback |
| U4 | Backtest auth | **No auth** | Read-only computation, no money risk, localhost-only. Rate-limit to 1 concurrent |
| U5 | Backtest event loop | **Async chunking** | Yield every 100 bars. Keeps Telegram/SSE responsive during long runs |

### Eng Review Decisions (BIG CHANGE)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| E19 | Close-all DRY | **Extract to agent helper** | Both Elysia + Telegram call identical logic. One implementation, one test |
| E20 | Bot lifecycle | **Start from index.ts** | Same pattern as startServer(). I/O at edges per CLAUDE.md |
| E21 | Logger fix | **Inject console methods** | Minimal diff, fixes spy timing bug without changing logger behavior |
| E22 | Bot file structure | **Directory src/alert/telegram/** | Move existing telegram.ts, add bot.ts + commands.ts. Clean organization |
| E23 | Error boundaries | **Layout + data-fetch** | ErrorBoundary in Layout + Suspense for data. Robust when backend is down |
| E24 | FOUC prevention | **Inline script in index.html** | Read localStorage before React hydrates. Standard pattern |

### Review Stats
- CEO: 0 critical gaps, 9 reusable components identified
- Eng: 6 issues resolved, ~35 new tests planned, 0 critical failure mode gaps
- Error paths mapped: 12 methods, all rescued
- Failure modes: 13 mapped, 0 silent failures

---

## Scope

### Phase 4A: Tech Debt + Polish (Sessions 1–2)

| Item | Description | Priority | Approach |
|------|-------------|----------|----------|
| Fix logger tests | 4 pre-existing failures since Sprint 1 | P0 | E21: Inject console methods for testability |
| React error boundaries | Graceful degradation when backend is down | P1 | E23: Layout ErrorBoundary + Suspense for data-fetch |
| FOUC prevention | Theme flash on page load | P1 | E24: Inline script in index.html reads localStorage |
| Backtest smoke test | E2E integration test: 100 candles through full pipeline | P1 | — |
| Dashboard build + serve | Verify `bun run build` → Elysia serves `dashboard/dist/` correctly | P1 | — |

### Phase 4B: Telegram Bot (Sessions 3–6)

Implement the Telegram control interface. **Architecture:**

```
┌──────────────────────────────────────────────────┐
│  src/alert/telegram/                              │
│  ├── alerts.ts    (moved from alert/telegram.ts)  │
│  ├── bot.ts       (getUpdates loop + router)      │
│  ├── commands.ts  (command handlers)              │
│  └── types.ts     (bot-specific types)            │
└──────────────────────────────────────────────────┘
```

**Design decisions:**
- U1: Long-polling (getUpdates with 30s timeout). No public URL/TLS needed.
- U2: Chat ID whitelist using existing TELEGRAM_CHAT_ID env var. Silent drop for unauthorized.
- E19: closeAllPositions() extracted to agent helper — shared by Elysia + Telegram.
- E20: startBot() called from index.ts after startServer().
- E22: All telegram code in src/alert/telegram/ directory.

**/closeall state machine:**
```
IDLE ──/closeall──▶ PENDING_CONFIRM ──/confirm──▶ EXECUTING ──done──▶ IDLE
 ▲                       │                                              │
 │                       │ 30s timeout                                  │
 │                       ▼                                              │
 └──────────────── CANCELLED (auto) ◄──────────────────────────────────┘
```

| Session | Task | Est. |
|---------|------|------|
| S3 | Telegram bot scaffold: connect to Bot API, command router, help command | 30 min |
| S4 | Core commands: /status, /positions, /pnl, /pause, /resume | 30 min |
| S5 | Risk commands: /risk, /closeall (with /confirm), /pause BTC 4h | 30 min |
| S6 | /report command: trigger daily review via analytics, format as Telegram message | 30 min |

### Phase 4C: Dashboard Extensions (Sessions 7–10)

**Backtest-from-browser flow:**
```
Browser                    Elysia                     Backtest Engine
  │ POST /api/backtest/run   │                              │
  │─────────────────────────▶│ validate + concurrency guard │
  │                          │─────────────────────────────▶│ async chunked
  │  200 {runId}             │                              │ (yield/100 bars)
  │◄─────────────────────────│                              │
  │ SSE progress events      │◄─────────────────────────────│
  │◄─────────────────────────│  {runId, pct, bar, total}    │
  │ GET /api/backtest/runs/  │  complete → save results     │
  │◄─────────────────────────│                              │
```

**Design decisions:**
- U3: POST + SSE progress (reuse existing SSE infra)
- U4: No auth for backtest (read-only, localhost-only). 1 concurrent max guard.
- U5: Async chunking — yield every 100 bars to keep event loop responsive.
- Backtest try/catch: wrap execution, emit SSE error event on crash.
- MAX_BACKTEST_MONTHS config to prevent OOM on huge date ranges.

| Session | Task | Est. |
|---------|------|------|
| S7 | Backtest: "Run from browser" button + config editor for backtest params | 35 min |
| S8 | Backtest: comparison view — select 2 runs, side-by-side metrics + equity | 30 min |
| S9 | Journal: expand detail row (click row → full trade details, pattern, zones) | 30 min |
| S10 | Dashboard: responsive mobile layout + dark/light theme toggle | 30 min |

**Total: 10 sessions, ~5–6 hours**

---

## Session Roadmap

| Session | Task | Est. | Dependencies |
|---------|------|------|-------------|
| S1 | Fix logger tests + add React error boundaries | 25 min | — |
| S2 | Backtest smoke test + dashboard build verification | 25 min | — |
| S3 | Telegram bot scaffold + command router | 30 min | — |
| S4 | Core Telegram commands (/status, /positions, /pnl, /pause, /resume) | 30 min | S3 |
| S5 | Risk Telegram commands (/risk, /closeall, /pause BTC 4h) | 30 min | S4 |
| S6 | /report command + formatted analytics message | 30 min | S5 |
| S7 | Backtest: run from browser + config editor | 35 min | — |
| S8 | Backtest: comparison view (2-run diff) | 30 min | S7 |
| S9 | Journal: expandable detail rows | 30 min | — |
| S10 | Dashboard: responsive mobile + theme toggle | 30 min | — |

### Session Progress

| Session | Status | Date | Notes |
|---------|--------|------|-------|
| S1 | DONE | 2026-04-01 | Logger tests fixed (pure fn export), ErrorBoundary + FOUC prevention added. 863 pass, 0 fail. |

---

## Definition of Done

Sprint 4 is complete when:

**Phase 4A — Tech Debt**
- [ ] All tests pass (zero failures, including logger tests)
- [ ] React error boundaries show fallback UI when API is down
- [ ] Backtest e2e smoke test exists and passes

**Phase 4B — Telegram Bot**
- [ ] Bot responds to /help with command list
- [ ] /status returns agent state, health, open positions
- [ ] /pnl returns daily/weekly/monthly PnL summary
- [ ] /pause and /resume control agent state
- [ ] /closeall requires /confirm within 30s
- [ ] /report triggers analytics daily review

**Phase 4C — Dashboard Extensions**
- [ ] Can run a backtest from the browser (select coins, dates, config)
- [ ] Can compare 2 backtest runs side-by-side
- [ ] Journal rows expandable to show full trade details
- [ ] Dashboard usable on mobile viewport

**Always**
- [ ] All Sprint 1–3 tests still pass
- [ ] New tests for Telegram commands and dashboard extensions
- [ ] Agent continues autonomous operation

---

## Existing Code Reuse Map

| Sub-problem | Existing code | File |
|---|---|---|
| Send Telegram messages | `sendTelegramAlert()` | `src/alert/telegram.ts` → `src/alert/telegram/alerts.ts` |
| MarkdownV2 escaping | `escapeMarkdownV2()` | `src/alert/telegram.ts` → `src/alert/telegram/alerts.ts` |
| Format daily summary | `formatDailySummary()` | `src/alert/telegram.ts` → `src/alert/telegram/alerts.ts` |
| Agent pause/resume | `getAgent().pauseAll()` / `resumeAll()` | `src/agent/trading-agent.ts` |
| Close all positions | Full logic in `/api/execution/override/close-all` | `src/server/index.ts` → extract to agent helper |
| Get positions/PnL | `/api/agent/positions`, `/api/metrics` | `src/server/index.ts` |
| Backtest engine | `runBacktest()` | `src/backtest/engine.ts` |
| Backtest results store | `saveRun()`, `listRuns()`, `loadRun()` | `src/backtest/results-store.ts` |
| SSE infrastructure | `sseRoutes()`, `SSEManager` | `src/server/sse.ts` |

## NOT in scope

- Discord/Slack integration — single channel (Telegram) sufficient for solo operator
- Telegram inline keyboards — preset text commands simpler and more reliable
- Dashboard PWA/offline — not enough value for complexity
- Dashboard E2E tests (Playwright) — visual testing deferred
- Config live editing from dashboard — safety concern without agent restart

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Telegram Bot API rate limits | Low | Preset commands are low-frequency (<1/min typical) |
| /closeall safety | High | Require /confirm within 30s window, log all close-all events |
| Dashboard backtest CPU | Medium | Async chunking (yield/100 bars), 1 concurrent max, MAX_BACKTEST_MONTHS cap |
| Mobile layout complexity | Low | Tailwind responsive utilities, test on 375px viewport |
| Unauthorized Telegram commands | Critical | Chat ID whitelist (U2), silent drop for unknown senders |
| Backtest crash mid-run | Medium | try/catch wrapper, emit SSE error event, log full context |
| Theme FOUC | Low | Inline script in index.html before React hydrates (E24) |
