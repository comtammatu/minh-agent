# 05 — UI Layout

> **TARGET / ASPIRATIONAL (2026-06 note):** Describes 10-panel Bloomberg grid, drag-resize, cmdk palette, vital strip, per-panel hotkeys (see DESIGN 06). 
> **Current:** `dashboard/` is 3-page sidebar app (Overview/Market/Journal via react-router) + Ink TUI as primary. Polling, no cmdk, no panels. See task-contract Q1 and DESIGN.md status table. Treat this as future spec until decision.

Panel taxonomy, default grid, header / status bar, page structure, UX flows.

The dashboard is a **multi-panel workspace**, not a stack of pages. Operator switches focus by hotkey, never by navigation chrome. Inspired by Bloomberg Terminal, TradingView desktop, Hyperliquid pro UI.

---

## Page anatomy

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER / VITAL STRIP  (40px)                                          │
│ [Mode][Exchange][Equity][Day PnL][Open Pos][Open Ord][CB][Net][Time]  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│                                                                       │
│           PANEL GRID  (flex-1, drag-resize, persist layout)           │
│                                                                       │
│                                                                       │
├──────────────────────────────────────────────────────────────────────┤
│ STATUS BAR  (24px)                                                    │
│ [WS state][Last tick][Agent state][Latency][Build][Active hotkey]    │
└──────────────────────────────────────────────────────────────────────┘
```

Three regions, three heights, three responsibilities:

| Region | Height | Owns |
|---|---|---|
| Header / vital strip | 40px | Always-visible critical state — equity, PnL, CB, mode |
| Panel grid | flex-1 | Working surface — drag/resize/swap panels |
| Status bar | 24px | Background telemetry — WS health, latency, build hash |

Header and status bar do not scroll. Panel grid is the only scrollable region (per panel, not page).

---

## Header / vital strip

Shown left-to-right. Each slot is fixed-width, monospace numbers, dense.

| Slot | Content | Color |
|---|---|---|
| Mode | `LIVE` / `PAPER` badge | `LIVE` = `bg-danger/20 text-danger`; `PAPER` = `bg-info/20 text-info` |
| Exchange | `HL` / `BB` badge | `bg-panel-hi text-fg-primary` |
| Equity | `$12,453.21` | `text-fg-primary` |
| Day PnL | `+$234.50  +1.92%` | `text-long` / `text-short` |
| Open positions | `3 OPEN` | `text-fg-primary` |
| Open orders | `5 ORD` | `text-fg-primary` |
| Circuit breaker | `CB OK` / `CB OPEN` | `text-long` / `text-danger` |
| Network | `WS ✓` / `WS ✕` | `text-long` / `text-danger` |
| Time | `2026-05-19 14:32:01 UTC` | `text-fg-secondary` |

Slot heights: equity and PnL use `text-base font-semibold`. Other slots use `text-sm`. Labels (e.g. "OPEN", "ORD", "CB") use `text-xs text-fg-muted` next to the value.

Click on any slot opens the corresponding panel (or focuses if already open). E.g., click on "3 OPEN" → focuses Positions panel.

---

## Status bar

Background telemetry. Smaller, fainter, scannable.

| Slot | Content |
|---|---|
| WS state | `WS · HL · 14ms` (last ping latency) |
| Last tick | `Tick · 0.4s ago` (most recent candle update) |
| Agent state | `Agent · idle` / `evaluating` / `placing` / `monitoring` |
| Pipeline latency | `Pipe · p99 42ms` |
| Build | `v2.0.0-abc1234` |
| Active hotkey hint | `? help` (cycles through random useful hotkey reminders) |

All slots are `text-xs text-fg-muted`. Click on WS slot opens a connection diagnostic popover. Click on build opens release notes (future).

---

## Panel grid

Library: `react-grid-layout` (locked choice — fewer dependencies than `dockview-react`, simpler model).

Grid config:
- Columns: 12.
- Row height: 32px.
- Margin: `[4, 4]` (4px gap horizontal and vertical).
- Compaction: `vertical`.
- Resize handles: bottom-right corner only.
- Drag handle: panel header bar only (not anywhere on panel).

Layout persistence: localStorage key `minh.dashboard.layout.v1`. Schema versioned — bumping the version invalidates and resets layout. Reset hotkey: `Cmd+Shift+R` (with confirm).

### Default layout

```
┌─────────────────┬─────────────────────────┬──────────────────┐
│ Watchlist (3w)  │ Chart (6w x 14h)        │ Order Book (3w)  │
│ x 14h           │                          │ x 14h            │
│                 │                          │                  │
│                 │                          │                  │
│                 ├─────────────────────────┤                  │
│                 │ Positions (6w x 6h)     │                  │
│                 │                          │                  │
├─────────────────┴──┬──────────────────────┴────┬─────────────┤
│ Open Orders (4w x  │ Live Setups (4w x 8h)     │ Risk (4w x  │
│ 8h)                │                            │ 8h)         │
└────────────────────┴────────────────────────────┴─────────────┘

Bottom 2 hidden tabs in panel grid (operator toggles via `g+j`, `g+d`, `g+a`):
  Journal · Decision Trace · Performance
```

Heights add up: 14 + 8 = 22 rows × 32px = 704px. Plus header (40) + status (24) + margins ≈ 800px target. Works on 1080p; on bigger screens, panels grow.

---

## Panel taxonomy (10 panels)

Each panel has: header, content area, optional footer. Header includes title, panel-specific controls, and close/collapse toggle.

### 1. Watchlist

Ranked coin list with live price + 24h Δ + setup signal.

**Columns**: Symbol · Price · Δ24h · Volume · Setup (badge or dot if active) · Last Trade Outcome

- Rows: configurable count, default 25.
- Sortable.
- Selection: clicking a row updates the Chart panel.
- Filter: top input, `/` focuses, filters by substring.
- Coin precision per row uses [04-component-patterns.md](04-component-patterns.md#numbers) rules.

UX: this is the operator's "what's happening" panel. Should refresh on every tick. Active setups highlight (left border + faint background).

### 2. Chart

TradingView Lightweight Charts. Multi-timeframe tabs at top (1m, 5m, 15m, 1h, 4h, 1d). Coin symbol in panel header. Indicators overlay (FVG, Order Blocks, Spring marks) toggle via small icon button.

UX: largest panel. Operator spends most time here. Keyboard: `[` previous TF, `]` next TF, `h` toggle indicators.

### 3. Order Book

Depth ladder. Bids left/green, asks right/red. Mid-price separator centered. Cumulative size bars in faint background.

**Columns**: Bid Size · Bid Price · Ask Price · Ask Size

- Depth: 15-25 levels per side, configurable.
- Click-to-prefill: clicking a price level prefills the order form (future feature).
- Spread indicator at top: `Spread 0.05  0.012%`.

### 4. Positions

Open positions with PnL streaming.

**Columns**: Coin · Side · Size · Entry · Mark · SL · TP · PnL · PnL% · Age · Actions

- Action buttons: `[Close]` (hold-to-confirm), `[Modify]` (opens dialog).
- Row selection: clicking a row pins the chart to that coin/side.
- Empty state: "No open positions" + tooltip explaining how setups become positions.

### 5. Open Orders

Pending/submitted/partial limit orders.

**Columns**: Coin · Side · Type · Size · Price · Status · Age · Actions

- Action: `[Cancel]` (hold-to-confirm).
- Status badge per [04-component-patterns.md](04-component-patterns.md#status-badges).
- Group by coin (optional toggle).

### 6. Live Setups

Setups currently detected by the strategy engine, awaiting agent decision (or already approved/rejected).

**Columns**: Coin · TF · Pattern · Side · Confluence Grade · Score · Status · Action

- Statuses: `pending`, `approved`, `rejected`, `entered`, `invalidated`.
- Action: depends on status — `[Approve]` / `[Reject]` for pending (hold-to-confirm), `[View]` for entered (jumps to positions).
- Click a row: chart panel jumps to that coin + TF with setup overlay markers.

This panel matches the Telegram `/setup` command (gap to fill, see [project_dashboard_design_2026_05.md](../../.claude)).

### 7. Risk

Risk dashboard. Circuit breaker state, daily PnL vs limit, exposure breakdown.

**Sections**:
- CB state with reason (`OK` / `OPEN: daily-loss-limit`)
- Daily PnL bar: current vs daily-stop-loss threshold
- Open exposure by side: stacked bar (long vs short, USD notional)
- Per-coin exposure: small table, top 5 by notional
- Loss streak / win streak counters

### 8. Trade Journal

Closed trades + thesis. Filtered list of `positions` where `status='closed'`, joined with `trade_journal` `enter` events for context.

**Columns**: Coin · Side · Entry · Exit · PnL · Hold · Pattern · Grade · Exit Reason

- Filter by: date range, coin, side, exit reason.
- Click a row: opens detail drawer with full thesis (notes, screenshots if any, full journal trail).

### 9. Decision Trace

Latest agent decision log — what the agent saw, what it decided, why.

**Format**: chronological feed, newest first. Each entry:

```
14:32:01  setup_detected  BTC 15m  spring  long  grade=A  score=0.84
14:32:01  setup_evaluating BTC      regime=trend  cb=ok  exposure=$2,100/$5,000
14:32:02  order_placed     BTC      limit  long  size=0.012  price=104,520
14:32:14  order_filled     BTC      fill_price=104,521  slip=1bps
```

- Color by event type.
- Filter by coin or event type.
- Click an entry: pivots chart to that coin/TF at that timestamp.

### 10. Performance

Analytics view of `daily_performance`, `pattern_performance`, equity curve.

**Sections**:
- Equity curve chart (last N days, configurable)
- Daily PnL bar chart (last 30 days)
- Pattern performance table (pattern × grade matrix, win rate, expectancy)
- Per-coin breakdown table

This panel is **read-only** for both owner and viewer. Refresh on matview update (poll every 60s or push notification when matview refreshes).

---

## Panel hierarchy (default focus)

When the dashboard first loads after auth:

1. **Watchlist** receives focus (Tab focus, keyboard ready).
2. **Chart** is the largest visible panel.
3. **Positions + Open Orders + Risk** visible by default.
4. **Live Setups** visible (small, top-right).
5. **Journal + Decision Trace + Performance** hidden by default, opened via `g+j`, `g+d`, `g+a` (per [06-keyboard-shortcuts.md](06-keyboard-shortcuts.md)).

---

## UX flows (golden paths)

### Flow A: Review a live setup, approve manually

1. New setup arrives — Live Setups panel highlights it.
2. Operator clicks the row.
3. Chart panel jumps to that coin/TF; setup overlay markers visible (entry zone, SL, TP).
4. Operator inspects chart + confluence breakdown (tooltip on grade column).
5. Clicks `[Approve]` button → hold-to-confirm fires → order placed.
6. Toast: "Order placed: BTC long 0.012 @ 104,520".
7. Open Orders panel shows new pending row.

Total clicks: 2 (row select + approve). Time: < 5 seconds.

### Flow B: Cancel all orders on a coin

1. Operator types `/btc` in cmdk palette (Cmd+K), filters to BTC orders.
2. Selects "Cancel all BTC orders".
3. Hold-to-confirm.
4. All BTC orders disappear from Open Orders panel; toast confirms count.

### Flow C: Emergency flatten

1. Operator presses `Cmd+Shift+F` (panic key).
2. Modal: "Flatten ALL positions on HL? (3 positions, ~$4,200 notional)".
3. Hold-to-confirm (longer hold: 1500ms for catastrophic action).
4. All positions close at market; toast lists each.

### Flow D: Investigate a closed trade

1. Operator opens Journal (`g+j`).
2. Filters to "last week, losses only".
3. Clicks a row.
4. Detail drawer slides in from right with full thesis, entry/exit chart snippets, journal trail.

### Flow E: Viewer connects from another machine

1. Owner generates viewer token via owner-only `Settings → Viewers → Generate token`.
2. Owner sends viewer the URL `https://dashboard/?vt=<token>`.
3. Viewer opens URL on their browser.
4. Dashboard loads in **viewer mode**: all panels read-only, no action buttons rendered, header strip shows `[VIEWER]` badge instead of mode.
5. Viewer sees full positions, full PnL, full chart. Cannot place, cancel, flatten, pause, or modify.

---

## Viewer mode rules

When `auth.role === 'viewer'`:

- Hide all action buttons (`[Close]`, `[Cancel]`, `[Approve]`, `[Reject]`, `[Modify]`, `[Pause]`, `[Resume]`, `[Flatten]`).
- Hide `[VIEWER]` cannot trigger hold-to-confirm (any attempt = silent no-op + log).
- HTTP endpoints enforce same — viewer JWT cannot reach write endpoints.
- Watchlist, Chart, Order Book, Positions (read), Open Orders (read), Live Setups (read), Risk (read), Journal, Decision Trace, Performance — all visible.
- Layout persistence is per-user (owner and viewer can have different layouts).

---

## Responsive policy

**No responsive design below 1024px width.** Show a centered message: "Minh dashboard requires a desktop browser ≥ 1024px wide. Use Telegram for mobile control."

Above 1024px, panels grow proportionally — `react-grid-layout` handles this with column-width responsiveness. Don't add Tailwind responsive variants (`md:`, `lg:`) for layout switching — there is no smaller layout.

---

## Settings drawer

Single-page settings, accessed via `,` (comma) hotkey or gear icon in header. Sections:

- **Account**: owner profile, change cookie secret (not in v1).
- **Viewers**: list of viewer tokens, generate / revoke.
- **Layout**: reset layout, export/import layout JSON.
- **Display**: nothing — the design is locked. (No "compact / cozy" toggle. Density is a decision, not a preference.)
- **Telegram**: bot status, recent commands, link new chat (if not linked).
- **About**: build version, uptime, exchange config (read-only).
