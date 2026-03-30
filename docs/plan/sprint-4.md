# Minh (明) — Sprint 4: EXPAND — Owner Control + Dashboard

## Goal

Give the owner **direct control** via Telegram preset commands and extend the Dashboard with backtest comparison views.

**Sprint 4 = EXPAND. Better owner visibility, no LLM needed yet.**

### Sprint Progression

```
Sprint 1: SEE        ✅ → Analysis engine
Sprint 2: ACT        ✅ → Agent execution
Sprint 3: VALIDATE   ✅ → Backtest + Analytics + Dashboard MVP
Sprint 4: EXPAND     🔲 → Telegram + Dashboard extensions
Sprint 5: ADVISE     🔲 → Basic LLM Advisor (gate: ≥ 100 trades)
Sprint 6: REMEMBER I 🔲 → Memory foundation (Layered + RAG)
Sprint 7: REMEMBER II🔲 → Memory intelligence (Graph + HyDE + Learning)
```

### Why these items are in Sprint 4

```
Telegram preset commands:
  Agent runs 24/7. Owner needs to pause/resume/query without opening a laptop.
  No LLM needed — 8 preset commands cover 90% of real use cases.
  Deterministic, zero API cost, zero failure surface.

Dashboard extensions:
  Backtest comparison page finishes the MVP started in Sprint 3.
  Depends on backtest engine (Sprint 3A).
```

---

## Architecture Overview

```
Sprint 4 additions:

┌─────────────────────────────────────────────────────┐
│  Telegram Bot (preset commands, no LLM parsing)      │
│  /pause  /resume  /status  /pnl  /positions          │
│  /closeall  /risk <pct>  /pause <coin> <duration>    │
└────────────────┬─────────────────────────────────────┘
                 │
┌────────────────▼─────────────────────────────────────┐
│  Dashboard Extensions (Elysia + React)               │
│  /backtest   → run + compare + equity curve view     │
└──────────────────────────────────────────────────────┘
```

---

## Phase 4A: Telegram Preset Commands

**Why**: Agent runs 24/7. Owner needs remote control without opening a laptop. Deterministic parsing, zero API cost, zero LLM latency.

**Design principle**: No LLM parsing. Exact command matching only. Simple → reliable.

```typescript
// src/alert/telegram-control.ts

const COMMANDS: Record<string, (args: string[], agent: TradingAgent) => Promise<string>> = {

  '/pause': async (_, agent) => {
    await agent.pause('manual_telegram')
    return '⏸ Agent paused. Send /resume to restart.'
  },

  '/resume': async (_, agent) => {
    await agent.resume()
    return '▶️ Agent resumed.'
  },

  '/status': async (_, agent) => {
    const ctx = agent.getContext()
    return formatStatusMessage(ctx)
    // "State: IN_POSITION | Positions: 2 | Daily PnL: +1.2% | Regime: BTC BULL, ETH SIDE"
  },

  '/pnl': async (_, agent) => {
    const summary = await journal.dailySummary(new Date())
    return formatPnlMessage(summary)
    // "Today: +$142.50 (3W/1L) | Week: +$620 | Month: +$1,840"
  },

  '/positions': async (_, agent) => {
    const positions = agent.getOpenPositions()
    return formatPositionsMessage(positions)
    // "BTC Long 0.05 | Entry 43250 | PnL: +$68 (+1.4%) | SL: 42800"
  },

  '/closeall': async (_, agent) => {
    // Requires /confirm within 30s — two-step safety
    pendingConfirm.set('closeall', Date.now())
    return '⚠️ Emergency close ALL positions? Send /confirm within 30s.'
  },

  '/confirm': async (_, agent) => {
    const pending = pendingConfirm.get('closeall')
    if (!pending || Date.now() - pending > 30_000) return '❌ No pending action or timeout.'
    await agent.closeAll()
    pendingConfirm.delete('closeall')
    return '✅ All positions closed.'
  },

  '/risk': async ([pct], agent) => {
    const value = parseFloat(pct)
    if (isNaN(value) || value < 0.1 || value > 3) return '❌ Invalid. Usage: /risk 0.5 (0.1–3%)'
    await agent.setTemporaryRisk(value / 100, '24h')
    return `✅ Risk set to ${value}% for 24h. Auto-reverts after.`
  },

}

// Unknown command → helpful response, no LLM
async function handleUnknown(msg: string): Promise<string> {
  return `❓ Unknown command: "${msg}"\n\nAvailable:\n/pause /resume /status /pnl /positions /closeall /risk <pct>`
}
```

**Safety rules**:
- `/closeall` requires `/confirm` within 30s → two-step, no accidental close
- `/risk` auto-reverts after 24h → temporary override, not permanent
- All commands logged to trade journal with event_type `'telegram_command'`
- LLM natural language parsing: not implemented (revisit Sprint 5+ if needed)

---

## Phase 4B: Dashboard Extensions

### 4B-1. Backtest Comparison Page (`/backtest`)

```
Backtest Runner:
  [Start Date] [End Date] [Config A: baseline] [Config B: +confluence 4] [Run →]

Results (side-by-side):
  Metric          Config A    Config B    Delta
  ──────────────────────────────────────────────
  Win rate        58%         62%         +4%
  Expectancy      0.42R       0.58R       +38%
  Max drawdown    8.2%        6.1%        -26%
  Sharpe          1.1         1.4         +27%
  Trade count     142         98          -31%

Equity Curve: [chart — Config A vs Config B overlaid]
```

---

## Sprint 4 Priority Order

```
Phase 4A: Telegram Preset Commands    (2 sessions)
  1. Bot setup + command parser + /pause /resume /status /pnl /positions
  2. /closeall + /confirm safety + /risk override + unknown handler

Phase 4B: Dashboard Extensions        (1 session)
  3. Backtest comparison page (run + equity chart + metric diff)
```

---

## Session Roadmap

| Session | Task | Est. | Dependencies |
|---|---|---|---|
| S1 | Telegram bot + /pause /resume /status /pnl /positions | 30–40 min | Sprint 2 Telegram |
| S2 | /closeall + /confirm + /risk + unknown handler + journal log | 25–35 min | S1 |
| S3 | Dashboard: backtest comparison page + equity chart | 30–40 min | Sprint 3 backtest |

**Total: 3 sessions, ~1.5–2 hours**

### Session Progress

| Session | Status | Date | Notes |
|---|---|---|---|
| S1 | NOT STARTED | — | Blocked by Sprint 3 completion |

---

## Definition of Done

- [ ] Telegram: /pause, /resume, /status, /pnl, /positions respond within 3s
- [ ] Telegram: /closeall requires /confirm, auto-expires 30s
- [ ] Telegram: /risk sets temporary override, auto-reverts after 24h
- [ ] Dashboard: backtest page runs comparison, renders equity curve
- [ ] All Sprint 1–3 tests still pass
- [ ] New tests: Telegram command parser

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Telegram bot token leaks | High | .env only. Never commit. Check .gitignore. |
