# 06 — Keyboard Shortcuts

Keyboard-first dashboard. Mouse exists but is not the primary input.

Two complementary systems:
1. **cmdk palette** (`Cmd+K`) — search-then-act for any command, fuzzy-matched
2. **Vim-style chord nav** (`g+<letter>`) — jump-to-panel
3. **Single-key actions** — context-sensitive when a panel is focused

Discoverability: `?` opens a help overlay listing every shortcut grouped by context.

---

## Global shortcuts

These work regardless of focused panel.

| Keys | Action |
|---|---|
| `Cmd+K` / `Ctrl+K` | Open command palette (cmdk) |
| `?` | Open help overlay |
| `,` | Open settings drawer |
| `Esc` | Close any open dialog / popover / drawer / palette |
| `Cmd+Shift+F` | Emergency flatten — panic dialog |
| `Cmd+Shift+R` | Reset panel layout (confirm) |
| `/` | Focus the search/filter input of the currently focused panel (or Watchlist if none focused) |

---

## Jump-to-panel (Vim chord nav)

Press `g` then a letter within 600ms. The chord focuses the target panel (raising it from hidden if collapsed).

| Chord | Panel | Mnemonic |
|---|---|---|
| `g w` | Watchlist | **w**atchlist |
| `g c` | Chart | **c**hart |
| `g b` | Order Book | order **b**ook |
| `g p` | Positions | **p**ositions |
| `g o` | Open Orders | **o**rders |
| `g s` | Live Setups | **s**etups |
| `g r` | Risk | **r**isk |
| `g j` | Journal | **j**ournal |
| `g d` | Decision Trace | **d**ecision |
| `g a` | Performance | **a**nalytics |

If pressed in a text input, the chord is suppressed — typing "go" in a search box does NOT focus Open Orders. Convention: chords only fire when focus is not on `INPUT`, `TEXTAREA`, `[contenteditable]`.

---

## Command palette (cmdk)

Primary entry point for everything. `Cmd+K` opens. Then type to fuzzy-search across:

- **Coins** — type "btc" to surface BTC-specific actions
- **Actions** — "cancel all", "pause agent", "flatten BTC"
- **Panel jumps** — "open journal", "show risk"
- **Settings** — "viewer token", "reset layout"
- **Recent journal entries** — "fill", "rejected" surfaces recent matching events

Command categories appear as groups (Coin, Action, Panel, Setting, Recent).

Examples:
- `Cmd+K` → type `cancel btc` → Enter → "Cancel all BTC orders" (hold-to-confirm fires next).
- `Cmd+K` → type `eth` → Enter → focuses chart on ETH and watchlist scrolls to ETH.
- `Cmd+K` → type `flatten` → Enter → emergency flatten dialog.

Library: `cmdk` (the unstyled headless one used by shadcn). Lives in `dashboard/src/components/command-palette.tsx`.

---

## Per-panel shortcuts

When a panel is focused (border-strong outline), these single-key shortcuts apply.

### Watchlist focused

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Pin chart to selected coin |
| `/` | Filter |
| `f` | Toggle favorites filter |

### Chart focused

| Key | Action |
|---|---|
| `[` | Previous timeframe |
| `]` | Next timeframe |
| `h` | Toggle indicators overlay |
| `r` | Reset chart zoom |
| `m` | Toggle setup markers |
| `1` `2` `3` `4` `5` `6` | Jump to specific TF: 1m, 5m, 15m, 1h, 4h, 1d |

### Order Book focused

| Key | Action |
|---|---|
| `+` / `-` | Increase / decrease depth |

### Positions focused

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Pin chart to selected position |
| `c` | Close selected (hold-to-confirm) |
| `m` | Modify SL/TP dialog |

### Open Orders focused

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `c` | Cancel selected (hold-to-confirm) |
| `Shift+c` | Cancel all in current filter (hold-to-confirm) |

### Live Setups focused

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Pin chart to selected setup |
| `a` | Approve selected (hold-to-confirm) |
| `x` | Reject selected (hold-to-confirm) |

### Journal focused

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Open detail drawer |
| `/` | Filter |
| `Shift+/` | Advanced filter (date range + multi-criteria) |

### Risk / Decision Trace / Performance focused

| Key | Action |
|---|---|
| `r` | Force refresh |
| `/` | Filter (Decision Trace only) |

---

## Hold-to-confirm protocol

Any shortcut that triggers an action with `(hold-to-confirm)` must require a 700ms hold:

1. Press and **hold** the key.
2. Visible progress fill animates inside a small confirm strip at the bottom of the panel (or in the focused row).
3. Release before 700ms → cancelled.
4. Keep held through 700ms → action fires.

Critical-mass action (`Cmd+Shift+F` flatten): hold 1500ms.

Spacebar = synonym for "Enter" inside a hold-to-confirm — operator can press `c` to start, switch to space to finish, useful for two-hand muscle memory.

---

## Conflict resolution

Browser / OS shortcuts that we DO NOT override:
- `Cmd+W` (close tab), `Cmd+R` (reload), `Cmd+T` (new tab), `Cmd+L` (URL bar), `Cmd+F` (browser find), `Cmd+P` (print), `Cmd+S` (save), `Cmd+C/V/X/A` (clipboard) — all browser defaults respected.

Browser shortcuts we DO override (these are uncommon enough to be safe):
- `Cmd+K` (some browsers use for URL bar search — overridden for command palette).
- `Cmd+Shift+R` (hard reload in browser — overridden for layout reset, prefer with confirm).

If `Cmd+Shift+R` conflict bothers users, fallback: also bind layout reset to a cmdk command.

---

## Help overlay (`?`)

Modal listing all shortcuts grouped by context (Global, Jump, Watchlist, Chart, etc.). Renders the same data structure used at runtime to bind shortcuts — single source of truth, no drift.

Visual:
- Centered modal, max-width 720px.
- Two-column grid per context: shortcut key (mono, `kbd` styling) on left, description on right.
- `Esc` or `?` closes.

---

## Settings: shortcut customization?

**Not in v1.** Shortcuts are not customizable. This is intentional — drift across user profiles makes it hard to share muscle memory across machines or assist viewers.

If a shortcut conflicts with a user's accessibility needs (e.g. keyboard layout), revisit per case.
