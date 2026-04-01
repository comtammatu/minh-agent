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

## Scope

### Phase 4A: Tech Debt + Polish (Sessions 1–2)

| Item | Description | Priority |
|------|-------------|----------|
| Fix logger tests | 4 pre-existing failures since Sprint 1 | P0 |
| React error boundaries | Graceful degradation when backend is down | P1 |
| Backtest smoke test | E2E integration test: 100 candles through full pipeline | P1 |
| Dashboard build + serve | Verify `bun run build` → Elysia serves `dashboard/dist/` correctly | P1 |

### Phase 4B: Telegram Bot (Sessions 3–6)

Implement the Telegram control interface specified in Sprint 3 `3E-4`:

| Session | Task | Est. |
|---------|------|------|
| S3 | Telegram bot scaffold: connect to Bot API, command router, help command | 30 min |
| S4 | Core commands: /status, /positions, /pnl, /pause, /resume | 30 min |
| S5 | Risk commands: /risk, /closeall (with /confirm), /pause BTC 4h | 30 min |
| S6 | /report command: trigger daily review via analytics, format as Telegram message | 30 min |

**Design:** Preset commands only (deterministic parsing, no LLM). See Sprint 3 spec for full command list.

### Phase 4C: Dashboard Extensions (Sessions 7–10)

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

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Telegram Bot API rate limits | Low | Preset commands are low-frequency (<1/min typical) |
| /closeall safety | High | Require /confirm within 30s window, log all close-all events |
| Dashboard backtest CPU | Medium | Run backtest in background, show progress bar, prevent double-submit |
| Mobile layout complexity | Low | Tailwind responsive utilities, test on 375px viewport |
