# Minh (明) — Design Reference (Greenfield)

**Canonical reference for presence UX, schema, and tokens.**  
**Runtime / quant pipeline SSOT:** [ARCHITECTURE.md](ARCHITECTURE.md).

Greenfield presence = **Ink TUI + Telegram** only. No browser dashboard product target, no PWA, no Bloomberg grid, no SSE/JWT operator UI.

If a change conflicts with these references, **update the reference in the same PR**. Prefer verifying against `src/` over `docs/archive/`.

---

## Status (Greenfield)

| Aspect | Current (as-built) | Notes |
|---|---|---|
| Runtime pipeline | Single Bun process; WS→store→minh→agent→execution | Spine unchanged |
| Database | PostgreSQL + TimescaleDB | SQLite bake-off deferred |
| Market data | WS-first, PG load, REST gap-fill, write-through hot store | — |
| Strategy | Single `minh` / minh | No strategy registry |
| Advisor | Deterministic shadow/active/off (default shadow) | Promotion gate + fill-based PnL backlog |
| Presence | Ink TUI + Telegram | Greenfield product surface |
| Browser dashboard | Removed (Greenfield cutover complete) | Ink TUI + Telegram only |
| Auth | None (localhost); bind guard for remote | No JWT owner/viewer plan |
| Mobile | Telegram | No PWA |

Operator surfaces: Ink TUI + Telegram. Local loop: [WORKFLOW.md](WORKFLOW.md). Features: [FEATURES.md](FEATURES.md).

---

## Index

| # | File | Scope | Stance |
|---|---|---|---|
| — | [ARCHITECTURE.md](ARCHITECTURE.md) | Quant pipeline, boot, market data, capabilities | **Current SSOT** |
| — | [DESIGN.md](DESIGN.md) | This index (Greenfield) | — |
| 01 | [design/01-system-design.md](design/01-system-design.md) | Process model, boundaries, boot | Current |
| 02 | [design/02-database-schema.md](design/02-database-schema.md) | PG schema, hypertables, matviews | Current |
| 03 | [design/03-design-tokens.md](design/03-design-tokens.md) | Typography, color, spacing | Current tokens (TUI/Telegram-adjacent) |
| 04 | [design/04-component-patterns.md](design/04-component-patterns.md) | Formatting, states, hold-to-confirm | Current patterns |

Former `design/05–07` (Bloomberg layout, cmdk, SSE/JWT API vision) were obsolete Proposed plans and have been removed.

---

## Hard rules

1. **No client-side numeric formatting rules.** Decimals from exchange metadata. See [04](design/04-component-patterns.md#numbers).
2. **No hardcoded color literals.** CSS variables from [03](design/03-design-tokens.md) when styling shared surfaces.
3. **No magic spacing / font-size.** Token-mapped utilities where applicable.
4. **No new interactive surface without loading/error/empty/stale states.** See [04](design/04-component-patterns.md#states).
5. **No schema change without [02](design/02-database-schema.md).** Migration + doc = one PR.
6. **Presence = TUI + Telegram.** Do not reintroduce PWA, Bloomberg grid, or JWT/SSE dashboard product scope without an explicit owner decision + FEATURES/ARCHITECTURE update in the same PR.
7. **Do not reorder boot / closed-candle gate** without updating [ARCHITECTURE.md](ARCHITECTURE.md).

---

## When to read which doc

| Task | Read first |
|---|---|
| Understand the trading pipeline | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Add/modify DB table | 02 (+ 04 JSONB shapes) |
| Change colors/fonts/spacing | 03 |
| TUI / Telegram presence | FEATURES + ARCHITECTURE + `src/ui/` / `src/alert/telegram/` |
| Wire feed / exchange | ARCHITECTURE + `.claude/rules/feed.md` + `exchange-gotchas.md` |
| Strategy / agent / risk | ARCHITECTURE + strategy/agent rules |

---

## Related project docs

| Topic | File |
|---|---|
| Features | [FEATURES.md](FEATURES.md) |
| Local + agent workflow | [WORKFLOW.md](WORKFLOW.md) |
| Domain rules | [.claude/rules/](../.claude/rules/) |
| Session protocol | [WORKFLOW.md](WORKFLOW.md) |
| Quality gates | [.claude/rules/quality-gates.md](../.claude/rules/quality-gates.md) |
| Pattern TTLs | [.claude/rules/invalidation-table.md](../.claude/rules/invalidation-table.md) |
