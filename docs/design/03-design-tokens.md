# 03 — Design Tokens

Typography, color, spacing, radius, motion, borders. **All UI code consumes tokens — no hardcoded values.**

Tokens live in [dashboard/src/index.css](../../dashboard/src/index.css) as CSS custom properties and are exposed through Tailwind 4 `@theme inline`. New components reference utility classes (`text-fg-primary`, `bg-card`, `text-long`, etc.) — never literal hex codes, never pixel values outside the spacing scale.

---

## Typography

### Font families

Two faces, both already vendored via `@fontsource/`:

| Family | Use | Tailwind utility |
|---|---|---|
| **IBM Plex Mono** | All numeric values (prices, sizes, PnL, timestamps), monospaced data | `font-mono` |
| **IBM Plex Sans Condensed** | Labels, headers, body text, panel titles | `font-sans` |

```css
@theme inline {
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-sans: 'IBM Plex Sans Condensed', ui-sans-serif, system-ui, sans-serif;
}
```

**Current state**: `dashboard/src/index.css:27-28` still uses generic fallbacks. **Action required**: import `@fontsource/ibm-plex-mono` and `@fontsource/ibm-plex-sans-condensed` in `main.tsx` and update the CSS variables. This is a wiring gap.

### Scale

Dense scale, not the marketing-site default. **Base size: 13px** (`text-sm` in our remap).

| Token | px | rem | Use |
|---|---|---|---|
| `text-xs` | 11 | 0.6875 | Status badges, axis labels, tooltip subtext |
| `text-sm` | 13 | 0.8125 | **Base body, table cells, button labels** |
| `text-base` | 14 | 0.875 | Panel section headers |
| `text-lg` | 16 | 1.0 | Page-level headers (rare) |
| `text-xl` | 20 | 1.25 | Vital-strip large numbers only |

Line-height:
- Numeric / table cells: **1.0** (single line, no breathing)
- Body / labels: **1.4**
- Headers: **1.2**

### Weights

| Token | Value | Use |
|---|---|---|
| `font-normal` | 400 | Body, default |
| `font-medium` | 500 | Emphasized labels, active state |
| `font-semibold` | 600 | Headers, key numbers |
| `font-bold` | 700 | Reserved — alerts, critical numbers only |

### Numeric rendering

All number rendering MUST use:
- `font-mono`
- `font-feature-settings: 'tnum' 1, 'zero' 1, 'cv02' 1`
  - `tnum` — tabular figures: every digit same width, columns align
  - `zero` — slashed zero, distinguishes from `O`
  - `cv02` — Plex stylistic variant for clearer numerals

Tailwind utility class: `.num` (defined in `index.css` — see snippet below).

```css
.num {
  font-family: var(--font-mono);
  font-feature-settings: 'tnum' 1, 'zero' 1, 'cv02' 1;
  font-variant-numeric: tabular-nums;
}
```

---

## Color

### Philosophy

- **Dark first, dark only.** No light mode in v1. `color-scheme: dark` set globally.
- **Neutral background, semantic accents.** Zinc-based scale for surfaces, dedicated long/short/warn/info for state.
- **No neon.** Vibrating colors (`#00ff00`, `#ff0000`) cause eye fatigue after 4+ hours. Use `green-600` / `red-600` equivalents.
- **HSL custom properties** (shadcn pattern), wrapped by Tailwind 4 theme.

### Surface scale

```css
:root {
  --bg-base:      0 0% 5%;     /* ~zinc-950, page background */
  --bg-panel:     0 0% 8%;     /* card / panel surface */
  --bg-panel-hi:  0 0% 11%;    /* hover, slightly lifted */
  --bg-overlay:   0 0% 13%;    /* dialog, popover, dropdown */
  --bg-input:     0 0% 10%;
}
```

Mapped utilities: `bg-base`, `bg-panel`, `bg-panel-hi`, `bg-overlay`, `bg-input`.

### Foreground scale

```css
:root {
  --fg-primary:   0 0%   98%;  /* default text, key numbers */
  --fg-secondary: 0 0%   70%;  /* secondary labels */
  --fg-muted:     0 0%   50%;  /* axis labels, disabled */
  --fg-faint:     0 0%   35%;  /* hint text, separators */
}
```

Mapped utilities: `text-fg-primary`, `text-fg-secondary`, `text-fg-muted`, `text-fg-faint`.

### Semantic state

```css
:root {
  --long:        142 71% 38%;  /* ~green-600 — long, buy, profit */
  --long-hi:     142 76% 45%;  /* hover / emphasis */
  --short:       0 73% 50%;    /* ~red-600 — short, sell, loss */
  --short-hi:    0 78% 56%;    /* hover / emphasis */
  --warn:        38 92% 50%;   /* ~amber-500 — warning, pending fill, partial */
  --info:        217 91% 60%;  /* ~blue-500 — info, neutral state */
  --danger:      0 84% 60%;    /* ~red-500 — destructive action confirm */
}
```

Mapped utilities: `text-long`, `text-short`, `text-warn`, `text-info`, `text-danger`. Also `bg-long/10`, `bg-short/10`, `border-long`, etc.

**Long/Short binding rule** (see [04-component-patterns.md](04-component-patterns.md#long-short-coloring)):
- PnL: `text-long` if `> 0`, `text-short` if `< 0`, `text-fg-muted` if `= 0`.
- Side: `text-long` for `long`/`buy`, `text-short` for `short`/`sell`.
- Order book bids: `text-long`. Asks: `text-short`.
- No exceptions — color is the canonical signal.

### Borders

```css
:root {
  --border:        0 0% 17%;   /* default panel borders, table dividers */
  --border-strong: 0 0% 24%;   /* focus rings, active panel */
  --border-faint:  0 0% 12%;   /* subtle inner separators */
}
```

Border width: **always 1px** unless explicitly noted. No 2px / 3px borders — density. Use color contrast for emphasis.

---

## Spacing

Base unit: **4px** (Tailwind default; `space-1 = 4px`).

### Density rules

| Surface | Padding | Token |
|---|---|---|
| Panel container | 12px | `p-3` |
| Panel inner content | 8px | `p-2` |
| Section gap inside panel | 8px | `space-y-2` |
| Between panels | 4px | `gap-1` |
| Table cell padding | 6px horizontal, 4px vertical | `px-1.5 py-1` |
| Button padding | 8px horizontal, 4px vertical | `px-2 py-1` |
| Form field padding | 8px | `p-2` |

### Heights

| Element | Height | Token |
|---|---|---|
| Table row | 28px | `h-7` |
| Interactive button / input | 32px | `h-8` |
| Compact button (inside table) | 24px | `h-6` |
| Header bar (top vital strip) | 40px | `h-10` |
| Status bar (bottom) | 24px | `h-6` |
| Panel header | 32px | `h-8` |
| Dialog/popover content row | 28px | `h-7` |

### Forbidden values

Do **not** use Tailwind's marketing-style spacing: `p-6` (24px), `p-8` (32px), `gap-4` (16px) between panels, `h-12` (48px) buttons. These are right for SaaS landing pages, wrong for Bloomberg-grade density.

---

## Radius

| Token | Value | Use |
|---|---|---|
| `rounded-none` | 0 | Table cells, dividers, tight bars |
| `rounded-sm` | 2px | Inline pills, status dots |
| `rounded` | **4px** (default) | **Buttons, inputs, panels, cards** |
| `rounded-md` | 4px | Same as default (we collapse the scale) |

```css
:root {
  --radius: 0.25rem;   /* 4px — was 0.75rem, dialed down for terminal density */
}
```

**Migration note**: current `dashboard/src/index.css:23` has `--radius: 0.75rem` (12px). Change to `0.25rem` and verify all shadcn primitives. This is a one-PR change.

No `rounded-lg` / `rounded-xl` / `rounded-2xl` in dashboard code — strip from any copied shadcn snippets.

---

## Motion

**Policy: minimal.** Trading UI prioritizes instant feedback. Animations exist only for state continuity (dialog open/close), never for decoration.

### Durations

| Token | Value | Use |
|---|---|---|
| `duration-instant` | 0ms | State toggles (panel show/hide, tab switch) |
| `duration-fast` | 100ms | Hover state, button press |
| `duration-base` | 150ms | **Dialog/popover/sheet open-close** |
| `duration-slow` | 250ms | Reserved — rare, e.g. layout reflow |

### Easings

- Default: `cubic-bezier(0.4, 0, 0.2, 1)` — standard ease-out
- Enter: ease-out (decelerate into rest)
- Exit: ease-in (accelerate out)

### Forbidden animations

- **No spinning loaders** for data < 500ms. Use skeleton (see [04-component-patterns.md](04-component-patterns.md#loading)).
- **No bouncing**, **no springs**, **no parallax**.
- **No animated number tickers.** Numbers change instantly. Color flash on change is OK if subtle (1 frame, opacity-only).
- **No layout animations** on data refresh. Tables update in place.

---

## Shadows

**Policy: avoid.** Dense terminal UI uses border contrast, not depth.

Allowed exception: dialog/popover `box-shadow: 0 4px 12px rgba(0,0,0,0.5)` for separation from page. Do not add shadows to cards, buttons, or panels.

---

## Icons

- Library: **lucide-react** (already in `package.json`).
- Default size: **14px** (matches 13px text x-height).
- Stroke width: **1.5** (default 2 too heavy at small sizes).
- Color: inherits `currentColor` — never hardcode.

```tsx
<TrendingUp className="w-3.5 h-3.5 stroke-[1.5]" />
```

---

## Tailwind config

The token contracts above must be exposed via `@theme inline` in [dashboard/src/index.css](../../dashboard/src/index.css). Pattern:

```css
@theme inline {
  --font-mono: var(--font-mono);
  --font-sans: var(--font-sans);
  --radius: var(--radius);

  --color-bg-base:      hsl(var(--bg-base));
  --color-bg-panel:     hsl(var(--bg-panel));
  --color-bg-panel-hi:  hsl(var(--bg-panel-hi));
  --color-fg-primary:   hsl(var(--fg-primary));
  --color-fg-secondary: hsl(var(--fg-secondary));
  --color-fg-muted:     hsl(var(--fg-muted));
  --color-long:         hsl(var(--long));
  --color-short:        hsl(var(--short));
  --color-warn:         hsl(var(--warn));
  --color-info:         hsl(var(--info));
  --color-danger:       hsl(var(--danger));
  --color-border:       hsl(var(--border));
  --color-border-strong:hsl(var(--border-strong));
}
```

Tailwind 4 picks these up automatically — `bg-bg-panel`, `text-fg-primary`, `border-border-strong` etc. become valid utilities.

---

## Migration checklist (current → locked)

The dashboard already has Tailwind 4 + shadcn primitives but uses shadcn defaults. Closing the gap:

- [ ] Import Plex fonts in `dashboard/src/main.tsx` (`@fontsource/ibm-plex-mono`, `@fontsource/ibm-plex-sans-condensed`)
- [ ] Replace generic `--font-mono` / `--font-sans` in `index.css` with Plex
- [ ] Add `--radius: 0.25rem` (currently `0.75rem`)
- [ ] Add semantic color tokens (`--long`, `--short`, `--warn`, `--info`, `--danger`)
- [ ] Add foreground scale tokens (`--fg-primary` … `--fg-faint`)
- [ ] Add surface scale tokens (`--bg-base` … `--bg-overlay`)
- [ ] Add `.num` utility class
- [ ] Audit all existing `dashboard/src/components/ui/*.tsx` for `rounded-lg` / `rounded-xl` — replace with `rounded`
- [ ] Audit for `p-6`, `gap-4`, `h-12` — replace with dense equivalents

This is a single PR. Test by visual regression: open each existing page (market, overview, journal) and confirm no breakage.
