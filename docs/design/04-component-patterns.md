# 04 — Component Patterns

How components format data, render state, and handle action. **Patterns are mandatory** — a new panel that invents its own loading state, its own number formatter, or its own confirm flow is a regression.

---

## Numbers

### Source of precision

**Rule**: formatters MUST consume precision metadata from the exchange. Client code does not decide decimals.

| Exchange | Metadata source | Code reference |
|---|---|---|
| Hyperliquid | `PerpMetaUniverseAsset.szDecimals` | [src/feed/perp-info.ts:48-55](../../src/feed/perp-info.ts) |
| Bybit | `lotSizeFilter.qtyStep` (size), `priceFilter.tickSize` (price) | [src/execution/bybit-exchange-service.ts:107-113](../../src/execution/bybit-exchange-service.ts) |

The runtime exposes per-coin precision via a single contract:

```ts
interface PrecisionMeta {
  exchange: 'HL' | 'BB'
  coin: string
  pxDecimals: number   // HL: 6 - szDecimals; BB: from priceFilter.tickSize
  szDecimals: number   // HL: szDecimals; BB: from qtyStep
  minOrderQty: number  // smallest valid size
  minOrderValueUsd: number  // HL: $10
}
```

This shape MUST live in a shared module the dashboard can import. **Action**: expose via `GET /api/v1/precision` (see [07-api-contracts.md](07-api-contracts.md)) and cache on dashboard mount.

### Formatters

All implemented in `dashboard/src/lib/format.ts` (single file, single source).

```ts
formatPrice(value: number, coin: string): string
formatSize(value: number, coin: string): string
formatNotional(value: number): string         // USD, 2 decimals, comma separators
formatPnl(value: number): string              // signed, $ prefix
formatPnlPct(value: number): string           // signed, % suffix, 2 decimals
formatPercent(value: number, decimals = 2): string
formatLeverage(value: number): string         // e.g. "5x"
```

Behavior:
- `formatPrice` / `formatSize` look up `PrecisionMeta` for the coin. **No fallback to a hardcoded default** — if precision is missing, render `'—'` and log a warning. Silent rounding is a bug.
- `formatPnl`: prefix `+` for positive, `−` (Unicode minus) for negative, `$0.00` for zero.
- Thousand separators: comma. Decimal: dot. Locale-locked `en-US`.
- Trailing zeros: keep for tabular alignment in tables (`104,532.50` not `104,532.5`). Strip in headline/large numbers if it improves scan.

### HL price-precision rule (don't forget)

From [.claude/rules/exchange-gotchas.md](../../.claude/rules/exchange-gotchas.md):

> Prices: max 5 significant figures + `(6 - szDecimals)` decimals. Sizes: rounded to `szDecimals`. Remove trailing zeroes before submit.

This affects **order submission**, not display. The formatter for display keeps trailing zeros (tabular). The order-submission path in `src/execution/hl-exchange-service.ts` strips them.

---

## Time

### Display rule

**UTC, always.** No local timezone. No "5 minutes ago" relative time as the primary display.

```ts
formatTime(value: Date | number): string           // 'HH:mm:ss' UTC
formatDate(value: Date | number): string           // 'YYYY-MM-DD'
formatDateTime(value: Date | number): string       // 'YYYY-MM-DD HH:mm:ss UTC'
formatTimeRelative(value: Date | number): string   // '2m 14s ago' — for tooltip only
```

Why UTC: trading happens across timezones, exchange timestamps are UTC, candle alignment is UTC. Displaying local time creates off-by-one-day reconciliation pain.

### Where relative time IS OK

- Tooltips on hover over an absolute timestamp ("placed 2m 14s ago")
- Status bar "uptime" indicator
- "Last update" indicator on a stale feed

Everywhere else, show the absolute UTC value.

---

## Long / short coloring

| Context | Long / buy / positive | Short / sell / negative | Zero / neutral |
|---|---|---|---|
| PnL number | `text-long` | `text-short` | `text-fg-muted` |
| Side label | `text-long` | `text-short` | — |
| Side badge background | `bg-long/15 text-long` | `bg-short/15 text-short` | — |
| Order book row | `text-long` (bid) | `text-short` (ask) | — |
| Chart candle | `--long` | `--short` | — |
| Position row indicator (1px left border) | `border-long` | `border-short` | — |

**Never** override these conventions per panel. Color is the signal.

---

## States

Every panel must define behavior for 5 states. Missing state = bug.

### 1. Loading

Initial data fetch, before first response.

- Use **shadcn `Skeleton`** ([dashboard/src/components/ui/skeleton.tsx](../../dashboard/src/components/ui/skeleton.tsx)) for tables/lists.
- Shape matches final content (skeleton row count = expected row count).
- No spinning loader for < 500ms data.
- For chart loads > 500ms: show centered `Loader2` from lucide with `animate-spin` once, single static "Loading candles…" label.

### 2. Empty

Data fetch returned nothing.

```
┌─ Panel ─────────────────┐
│                          │
│   [icon, faint]          │
│   No open positions      │
│   Hint text in fg-muted  │
│                          │
└──────────────────────────┘
```

- Centered vertically and horizontally.
- Lucide icon at `w-8 h-8 text-fg-faint`.
- Headline `text-sm text-fg-secondary`, hint `text-xs text-fg-muted`.
- Optional CTA if relevant (e.g., "Place an order" linking to chart panel).

### 3. Error

Data fetch failed (network, parse, server error).

```
┌─ Panel ─────────────────┐
│                          │
│   [AlertCircle, danger]  │
│   Failed to load         │
│   <error class>          │
│   [Retry] button         │
│                          │
└──────────────────────────┘
```

- Lucide `AlertCircle` at `w-8 h-8 text-danger`.
- Error class string (not stack trace, not raw message). Map known error classes server-side and pass a code.
- Retry button (`Button variant="outline" size="sm"`).
- Network errors: auto-retry 3× with exponential backoff before showing this state.

### 4. Stale

Feed paused or data older than a threshold while panel is mounted.

```
┌─ Panel ──────────[STALE]┐
│  (content shown as-is)   │
│  with reduced opacity    │
└──────────────────────────┘
```

- Panel header shows `[STALE]` badge in `text-warn`.
- Content opacity reduced to 0.6.
- Tooltip on badge: "Last update X seconds ago".
- Threshold per panel:
  - Candle chart: 2× the timeframe (e.g., 2m on 1m chart)
  - Positions / orders: 10s
  - Risk: 30s

### 5. Optimistic / pending

Action submitted, awaiting server confirmation.

- Row appears immediately with `[PENDING]` badge.
- On confirm: badge removed, row settles.
- On reject: row removed, toast shown.
- Optimistic state visually distinct: italic + `text-fg-secondary` (not full opacity).

---

## Status badges

Single shadcn `Badge` component, variant-driven:

| Variant | Background | Foreground | Use |
|---|---|---|---|
| `default` | `bg-panel-hi` | `text-fg-primary` | Neutral state |
| `long` | `bg-long/15` | `text-long` | Long side, buy fill |
| `short` | `bg-short/15` | `text-short` | Short side, sell fill |
| `warn` | `bg-warn/15` | `text-warn` | Pending, partial fill, stale |
| `info` | `bg-info/15` | `text-info` | Info, in-progress |
| `danger` | `bg-danger/15` | `text-danger` | Rejected, error, circuit breaker open |
| `muted` | `bg-panel-hi` | `text-fg-muted` | Cancelled, expired |

Shape: small, `h-5`, `px-1.5`, `text-xs font-medium`, `rounded-sm`. No icons inside badges by default — keep dense.

---

## Tables

Every data table in the dashboard follows the same skeleton. Use shadcn `Table` ([dashboard/src/components/ui/table.tsx](../../dashboard/src/components/ui/table.tsx)) primitives but with our density overrides.

Patterns:
- Row height: `h-7` (28px).
- Cell padding: `px-1.5 py-1`.
- Header: `text-xs uppercase tracking-wider text-fg-secondary font-medium`.
- Body: `text-sm`.
- Numeric columns: `.num text-right tabular-nums`.
- Row hover: `hover:bg-panel-hi`.
- Selected row: `bg-panel-hi border-l-2 border-info`.
- Action column (rightmost): icon buttons, `w-6 h-6` lucide icons.
- Striping: **off by default.** Use sparingly when readability suffers — borders are usually enough.

Sort state: column header click toggles sort. Active sort arrow inline at right of header text, faint.

---

## Buttons

| Variant | Use | Tailwind shape |
|---|---|---|
| `default` | Primary action | `bg-fg-primary text-bg-base hover:bg-fg-primary/90` |
| `outline` | Secondary action | `border border-border bg-transparent hover:bg-panel-hi` |
| `ghost` | Tertiary, table actions | `bg-transparent hover:bg-panel-hi` |
| `destructive` | Cancel order, close position | `bg-danger text-fg-primary hover:bg-danger/90` |
| `confirm-long` | Place long order | `bg-long text-bg-base hover:bg-long-hi` |
| `confirm-short` | Place short order | `bg-short text-fg-primary hover:bg-short-hi` |

Sizes: `sm` (24px / `h-6`), `default` (32px / `h-8`), `lg` (40px — only for top-of-page CTAs).

---

## Hold-to-confirm

**Required pattern for any irreversible action**: place order, cancel order, close position, flatten, pause agent.

Behavior:
1. User presses button (mouse down / `Enter` key down).
2. Progress fill animates left-to-right inside the button over **700ms**.
3. On full hold: action fires, button shows brief flash + checkmark, then resets.
4. On release before 700ms: progress resets, no action.

Visual: progress fill in destructive color, on top of the button label. Label stays readable through fill (use opacity 0.9 on fill, text remains).

Implementation: shared `<HoldButton>` component in `dashboard/src/components/ui/hold-button.tsx`. Wraps `Button` + a state machine + framer-motion or CSS-keyframe progress fill. Accessibility: announces "Hold to confirm" via aria-label; releasing before completion announces "Cancelled".

Exemption: **non-destructive** actions (toggle panel visibility, change timeframe, sort table) are instant. Hold-to-confirm only for things that move money or change state externally.

---

## Optimistic updates

Allowed for:
- Cancel order — row immediately shows `[PENDING CANCEL]`, then removes on confirm.
- Place limit order at user-typed price — appears in open orders with `[PENDING]`, settles to `submitted` on exchange ack.
- Pause / resume agent — toggle flips immediately, reverts if server rejects.

Not allowed for:
- Position open — wait for fill before showing in positions list.
- PnL updates — these stream from feed; never compute optimistically.
- Setup decisions — wait for agent journal entry.

Rollback rule: on failure, revert the optimistic UI within 1 frame and surface a toast (see below).

---

## Toasts

For ephemeral feedback (action confirmed, error occurred, soft warning). Use a toast primitive (build on top of `@radix-ui/react-toast` — not yet in deps).

Variants: `success`, `error`, `warning`, `info`. Position: bottom-right. Duration: 4s default, 8s for errors, sticky for critical.

**No toasts for:**
- Successful data refresh — silent.
- Routine state transitions — silent.
- Anything that's already visible elsewhere (e.g., new position shown in positions panel — don't also toast it).

**Toasts for:**
- Action confirmation when result is not immediately visible.
- Errors from operator actions.
- Circuit breaker trips.
- Connection lost / restored.

---

## Number-change flash

When a streaming value changes in a table cell (price tick, PnL update):
- 1-frame opacity flash: `from-fg-primary to-long` (uptick) or `from-fg-primary to-short` (downtick), duration 200ms.
- Implementation via CSS animation on a data-attribute change.
- Disable when reduced-motion preference is set (`@media (prefers-reduced-motion: reduce)`).

No size change, no scale, no shake. Color flash only.

---

## Charts

TradingView Lightweight Charts. Wrapper in `dashboard/src/components/tradingview-chart.tsx` (already exists). Conventions:

- Background: `--bg-panel`.
- Grid: faint, `--border-faint`.
- Up candle: `--long`. Down candle: `--short`. No wick color override.
- Crosshair: `--fg-muted`.
- Axis labels: `--fg-muted`, `text-xs`, `font-mono`.
- Time axis: UTC.

Markers (for entries, exits, setup levels):
- Long entry: triangle-up, `--long`.
- Short entry: triangle-down, `--short`.
- SL: horizontal dashed line, `--danger`, 1px.
- TP: horizontal dashed line, `--info`, 1px.

---

## Accessibility minimums

This is a single-user tool, but minimums still apply:

- Keyboard navigation works for every action (see [06-keyboard-shortcuts.md](06-keyboard-shortcuts.md)).
- Focus rings always visible — `outline: 2px solid var(--border-strong); outline-offset: 1px`.
- Color is never the only signal — pair with icons or text for long/short.
- Reduced-motion preference respected (disable flash, slow transitions to instant).
