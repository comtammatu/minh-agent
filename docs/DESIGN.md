# Minh (明) — Design Reference

**Canonical reference. Read this first before any UI, schema, or system-level change.**

This document and its sub-pages are the single source of truth for system design, database schema, and dashboard design system. Their purpose is to prevent drift: every UI panel, every new column, every new endpoint follows the contracts defined here.

If a future change conflicts with this reference, **update this reference in the same PR** — never leave them out of sync. If the reference is wrong, fix the reference first, then the code.

---

## Status

| Aspect | State (Current Impl 2026-06) | Target (per DESIGN subdocs; pending owner decision Q1 in task-contract) | Last decided |
|---|---|---|---|
| Database | PostgreSQL + TimescaleDB (no swap) | Same (or SQLite after bake-off) | 2026-05-19 |
| Frontend stack | Vite + React 19 + react-router-dom + shadcn/ui + HTTP polling (Bun.serve) | Vite + React 19 + TanStack Router + shadcn/ui + Zustand + TanStack Query + native WS/SSE | 2026-05-19 |
| Charts | No vendor chart dependency in current dashboard | Native market panels when charting is reintroduced | 2026-06-07 |
| State | React Context + polling hooks (no Zustand/TanStack Query yet) | Zustand (UI) + TanStack Query (REST) + native WS hook | 2026-05-19 |
| Typography | IBM Plex Mono + Plex Sans Condensed (already vendored) | Same (Bloomberg density) | 2026-05-19 |
| Density | 3-page sidebar + vital strip/status bar (Overview/Market/Journal) + Ink TUI primary | 10-panel Bloomberg grid, drag-resize, cmdk, 28px row, 13px | 2026-05-19 |
| Mobile | NO PWA — Telegram bot is the mobile interface | Same | 2026-05-19 |
| Auth | None (localhost dev only; operator via TUI/Telegram) | JWT signed cookie; owner full / viewer manual token | 2026-05-19 |

**Note:** DESIGN 05-ui-layout.md and 07-api-contracts.md describe the multi-panel + auth + v1 SSE target. Current `dashboard/` + `src/server/` is intentionally minimal (see CODEBASE_MAP). Do not assume subdocs match code until decision + implementation. Update this table + subdocs in same PR on any change. See open scope decision in [task-contract-arch-ai-agents-refactor-2026-06-04.md](../plan/task-contract-arch-ai-agents-refactor-2026-06-04.md).

Decision provenance: see [docs/plan/stack-decision-draft.md](plan/stack-decision-draft.md) (final 2026-05-19: targeted refactor path B approved; SQLite/DB bake-off deferred, TUI delete split, etc.). Linked .claude/projects/... paths do not exist in repo (historical /autoplan restore points referenced in archive). DESIGN sub-docs 05-07 describe aspirational "Target" UI (see notes below); current impl is simpler (see CODEBASE_MAP + runtime). All future changes must keep this index in sync.

---

## Index

| # | File | Scope |
|---|---|---|
| — | [DESIGN.md](DESIGN.md) | This master index |
| 01 | [design/01-system-design.md](design/01-system-design.md) | Process model, data flow, boundary rules, concurrency, boot order |
| 02 | [design/02-database-schema.md](design/02-database-schema.md) | PG + Timescale tables, hypertables, matviews, JSONB shapes, retention |
| 03 | [design/03-design-tokens.md](design/03-design-tokens.md) | Typography, color, spacing, radius, motion, borders — CSS variable contracts |
| 04 | [design/04-component-patterns.md](design/04-component-patterns.md) | Number/time formatting, status badges, loading/error/empty states, hold-to-confirm |
| 05 | [design/05-ui-layout.md](design/05-ui-layout.md) | 10 panel taxonomy, default grid, header vital strip, status bar, UX flows |
| 06 | [design/06-keyboard-shortcuts.md](design/06-keyboard-shortcuts.md) | cmdk palette + Vim chord nav, per-panel hotkeys, hold-to-confirm protocol |
| 07 | [design/07-api-contracts.md](design/07-api-contracts.md) | HTTP endpoints, WS message shapes, JWT auth flow, rate limits |

---

## Hard rules

These rules apply to every change. Violations should be caught at review.

1. **No client-side numeric formatting rules.** Decimals come from exchange metadata (`PerpMetaUniverseAsset.szDecimals` for HL, `lotSizeFilter.qtyStep` for BB). See [04-component-patterns.md](design/04-component-patterns.md#numbers).
2. **No hardcoded color literals in component code.** Use CSS variables from [03-design-tokens.md](design/03-design-tokens.md).
3. **No magic spacing or font-size values.** Use Tailwind utilities mapped to the token scale.
4. **No new panel without a state contract.** Loading / error / empty / stale states are mandatory. See [04-component-patterns.md](design/04-component-patterns.md#states).
5. **No schema change without updating [02-database-schema.md](design/02-database-schema.md).** Migration + doc are one PR.
6. **No new HTTP/WS endpoint without updating [07-api-contracts.md](design/07-api-contracts.md).** Same PR.
7. **No PWA.** Mobile is Telegram. Do not add `vite-plugin-pwa`, manifest, service worker, install prompts.
8. **No mobile-responsive layout below 1024px.** Dashboard is desktop-only by design — match Bloomberg density.

---

## When to read which doc

| Task | Read first |
|---|---|
| Add/modify a DB table or migration | 02 + 04 (JSONB shapes) |
| Add a dashboard panel | 03 + 04 + 05 |
| Change colors, fonts, spacing | 03 only |
| Add an HTTP/WS endpoint | 07 + 01 (boundary rules) |
| Add a keyboard shortcut | 06 |
| Wire a new exchange feed | 01 + 07 + `.claude/rules/exchange-gotchas.md` |
| Refactor strategy or agent | 01 + `.claude/rules/strategy.md` |

---

## Related rules (canonical elsewhere)

These topics live in `.claude/rules/`, not in this design doc. Do not duplicate.

| Topic | File |
|---|---|
| Session workflow + Task Contract | [.claude/rules/session-protocol.md](../.claude/rules/session-protocol.md) |
| Quality gates (test/lint/typecheck) | [.claude/rules/quality-gates.md](../.claude/rules/quality-gates.md) |
| Pattern invalidation TTLs | [.claude/rules/invalidation-table.md](../.claude/rules/invalidation-table.md) |
| Indicator rules (pure, golden tests) | [.claude/rules/indicators.md](../.claude/rules/indicators.md) |
| Strategy rules | [.claude/rules/strategy.md](../.claude/rules/strategy.md) |
| Feed rules | [.claude/rules/feed.md](../.claude/rules/feed.md) |
| HL + BB landmines | [.claude/rules/exchange-gotchas.md](../.claude/rules/exchange-gotchas.md) |
