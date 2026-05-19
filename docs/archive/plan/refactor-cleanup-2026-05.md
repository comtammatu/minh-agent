# Minh (明) — Refactor & Cleanup Plan (2026-05-19)

> Branch: `plan/greenfield-rebuild-audit` (audit artifact branch)
> Baseline: typecheck CLEAN, 1143/1143 tests pass, health composite 10.0/10

## TL;DR

Codebase is **healthy by quality metrics** but has **6 concrete cleanup items** that have accumulated over 7 sprints. This plan addresses them as 6 targeted sessions without touching exchange-integration invariants (HL signing, rate limiter, dead-man's switch, candle persistence, agent wallet split).

**This is NOT a greenfield rebuild.** A rebuild would re-introduce all the bugs that were already fixed during HL/BB integration. See `## Why not rebuild` below.

---

## Audit data (2026-05-19)

### Module inventory

| Module | LOC | Tests | Notes |
|---|---:|---:|---|
| `src/agent/` | 8440 | 10 | largest module; carries side effects, retries, reconciliation |
| `src/alert/` | 5711 | 3 | dominated by 2 monolithic Telegram files |
| `src/backtest/` | 5552 | 1 in module + 11 in `test/backtest/` | replay + optimize + reporting |
| `src/execution/` | 3395 | 2 | HL + BB adapters + ExchangePool |
| `src/feed/` | 3108 | 3 in module + 6 in `test/feed/` | REST + WS + selectors |
| `src/strategy/` | 3053 | 1 in module + 5 in `test/strategy/` | smc-sd setup engine |
| `src/indicators/` | 2293 | 0 in module + 1 in `test/indicators/` | pure functions |
| `dashboard/` | 2286 | 2 | React + Vite browser UI |
| `src/ui/` | 1871 | 0 in module + 2 in `test/ui/` | Ink TUI |
| `src/config.ts` | 1242 | (covered by `test/config.test.ts`) | all thresholds |
| `src/analytics/` | 1173 | 3 | closed-trade metrics + live wallet |
| `src/server/` | 1161 | 2 | **dashboard HTTP server, undocumented in CLAUDE.md** |
| `src/runtime/` | 814 | 0 | boot + reconnect + lifecycle |
| `src/compare-exchanges.ts` | 611 | 0 | **script at src root, should be in `scripts/`** |
| `src/memory/` | 297 | 0 | **brand new (commit ef441e6), not yet wired to runtime** |
| `src/db/` | 302 | 0 in module + 4 in `test/db/` | PG connection + repos |
| `src/lib/` | 206 | 2 in `test/lib/` | retry + logger |

**Total:** ~42K LOC, 123 test files, 1143 passing tests.

### Code-smell signals

- `as any`: 4 occurrences (3 in test files, 1 in `src/ui/tui.tsx:1257` for `process.emit('SIGINT' as any)` — legitimate)
- `@ts-ignore` / `@ts-expect-error`: 0
- TODO / FIXME / XXX / HACK: 0
- Largest files: `alert/telegram/commands.ts` (1527), `alert/telegram/bot.ts` (1504), `ui/tui.tsx` (1418), `strategy/strategies/smc-sd/index.ts` (1327), `config.ts` (1242), `agent/order-manager.ts` (1163), `indicators/smc.ts` (1121)

### Documentation drift

- `CLAUDE.md` says "Current branch does not ship the historical `src/server/`, `dashboard/`, `src/advisor/`, or `src/memory/` modules".
- Reality: `src/server/` exists (1161 LOC, imported by `src/runtime/app.ts:103`), `dashboard/` exists (2286 LOC), `src/memory/` exists (297 LOC, not yet wired).

---

## Why not rebuild

The codebase encodes invariants that took weeks of real-exchange debugging to nail down. Re-creating them from scratch would re-introduce the same bugs:

| Invariant | Where | Hard to re-discover because |
|---|---|---|
| HL signing schemes (l1_action vs user_signed_action) | `execution/hl-exchange-service.ts` | Wrong signature returns opaque `"missing wallet"` error |
| Weight-based REST rate limiter | `feed/rate-limiter.ts` | Surcharge formulas per endpoint, address-rate-limit at 1 req/USDC, stale-expiresAfter cancels cost 5× weight |
| Dead-man's-switch | execution layer | Auto-cancel after timestamp, max 10/day — critical bot safety |
| Hybrid candle persistence | `feed/` + `db/candle-repo.ts` | WS hot window + PG historical, dedup by timestamp upsert |
| Boot ordering | `runtime/app.ts` | migrations → coin select → WS first → PG load → gap-fill → polling/agent/TUI |
| HL agent wallet split | `execution/` + `feed/` | PK for signing, ACCOUNT_ADDRESS for info queries |
| Unified perp+spot balance | `analytics/` | spotClearinghouseState + clearinghouseState merge |
| Bybit fallback paths | `agent/order-manager-bb-fallback`, `agent/position-monitor-bb-fallback` | no mark-price stream on BB → use latest 1m close |
| OI cap check | execution path | Some HL assets at cap → can't open |

A greenfield rebuild also throws away `1143` passing tests that document expected behavior.

---

## Sessions

Six sessions ordered by dependency. Each follows the Task Contract pattern in `.claude/rules/session-protocol.md`. Quality gates from `.claude/rules/quality-gates.md` apply to all.

### S1 — Doc resync (single session, low risk)

**Why:** Lying docs are worse than no docs. `CLAUDE.md` and `docs/CODEBASE_MAP.md` claim `src/server/`, `src/memory/`, `dashboard/` don't ship — they do.

**Scope:**
- Update `CLAUDE.md` ## Key Directories to include `src/server/`, `src/memory/`, `dashboard/`, `src/lib/`.
- Remove the false claim "Current branch does not ship..." sentence (or rewrite to reflect reality).
- Update `docs/CODEBASE_MAP.md` to match real module layout.
- Add note that `src/memory/` is foundation-only, not yet wired to runtime (per commit ef441e6).

**Completion criteria:**
- [ ] `CLAUDE.md` mentions every directory in `src/` and `dashboard/`.
- [ ] `docs/CODEBASE_MAP.md` LOC numbers within ±10% of current.
- [ ] `git grep "does not ship" docs CLAUDE.md` returns nothing.
- [ ] `bun test --run` passes (no code change, but verify nothing broke).

**Operational risk:**
- Risk 1: Docs become stale again after next sprint. *Mitigation:* add a `docs:audit` script that diffs claimed vs actual modules and run it in CI.
- Risk 2: None — docs only.

**Estimate:** 20–30 min.

---

### S2 — Move scripts out of src/ (single session, low risk)

**Why:** `src/compare-exchanges.ts` is a one-shot CLI tool, not part of the live runtime path. Keeping it in `src/` muddies the boundary.

**Scope:**
- Move `src/compare-exchanges.ts` → `scripts/compare-exchanges.ts`.
- Audit `src/` for other files that aren't imported by `src/index.ts` or `src/runtime/app.ts` transitively.
- Update `package.json` script entries that reference the file.

**Completion criteria:**
- [ ] `git grep "compare-exchanges" src/` returns nothing.
- [ ] `bun run scripts/compare-exchanges.ts` (if applicable) still works.
- [ ] `bun test --run` passes.
- [ ] `bun run typecheck` passes (catches dangling imports).

**Operational risk:**
- Risk 1: Import paths inside the moved file break. *Mitigation:* typecheck catches this immediately.
- Risk 2: Some external caller (Telegram command, cron) references the old path. *Mitigation:* `git grep "compare-exchanges"` across the repo before moving.

**Estimate:** 10–15 min.

---

### S3 — Add lint + dead-code detector (single session, medium impact)

**Why:** No lint means `as any`, unused exports, and style drift accumulate silently. The dashboard scored 10/10 because **lint was skipped, not because there are no lint issues**.

**Scope:**
- Add `biome` (per `bunx --bun create biome`) with config tuned for this codebase: enforce no `as any` without justification comment, no unused exports, no unused imports.
- Add `knip` for dead-code detection.
- Add to `package.json`:
  ```
  "lint": "biome check .",
  "lint:fix": "biome check . --write",
  "deadcode": "knip"
  ```
- Update `## Health Stack` section in `CLAUDE.md` so `/health` picks them up next run.
- **Do not auto-fix yet.** S4 handles fixes after measuring baseline.

**Completion criteria:**
- [ ] `bun run lint` returns a baseline count (may be non-zero — record it).
- [ ] `bun run deadcode` returns a baseline count.
- [ ] `bun test --run` passes.
- [ ] `/health` next run uses lint + knip.

**Operational risk:**
- Risk 1: Biome surfaces hundreds of issues, scope creeps. *Mitigation:* keep S3 to "add tools", S4 handles fixes.
- Risk 2: Biome conflicts with existing code style. *Mitigation:* start with permissive config (recommended preset only, no opinionated rules).

**Estimate:** 25–40 min.

---

### S4 — Address lint baseline + dead exports (split if large)

**Why:** Make S3's gates meaningful. If S3 reports 5 issues, fix them. If 500, triage.

**Scope (depends on S3 output):**
- Sort issues by file. Apply auto-fixes first (`biome check . --write`).
- Manually review remaining issues; suppress with comment + justification only where suppression is correct (e.g. SIGINT cast in `ui/tui.tsx:1257`).
- Remove confirmed dead exports (knip). Cross-check against test imports before deleting.

**Completion criteria:**
- [ ] `bun run lint` returns 0 or only justified suppressions.
- [ ] `bun run deadcode` returns 0 or only known false positives (documented).
- [ ] `bun test --run` passes (1143 tests).
- [ ] `bun run typecheck` passes.

**Operational risk:**
- Risk 1: Removing "dead" code that's actually loaded dynamically (Telegram commands registered by name?). *Mitigation:* grep for string references before deleting any export.
- Risk 2: Auto-fix changes test behavior. *Mitigation:* run tests after each batch, not at the end.

**Estimate:** 40–80 min (split into S4a + S4b if knip reports >30 entries).

---

### S5 — Split monolithic Telegram files (single session, medium risk)

**Why:** `alert/telegram/commands.ts` (1527 LOC) and `alert/telegram/bot.ts` (1504 LOC) are the two biggest non-config files. They concentrate bug-risk and slow review.

**Scope:**
- Split `commands.ts` by command group: e.g. `commands/positions.ts`, `commands/strategy.ts`, `commands/analytics.ts`, `commands/admin.ts`. Each <400 LOC.
- Keep `commands/index.ts` as the registration entrypoint so `bot.ts` import surface is unchanged.
- Do NOT split `bot.ts` in this session — keep changes contained. Mark `bot.ts` split as S5b if needed.
- Same approach: NO logic changes, ONLY file boundaries.

**Completion criteria:**
- [ ] No file in `alert/telegram/` exceeds 600 LOC.
- [ ] All Telegram tests still pass (`bun test --run`).
- [ ] Manual smoke: start runtime in paper mode, send `/status` to bot, verify response.
- [ ] `/review` reports no behavior changes.

**Operational risk:**
- Risk 1: Command registration broken by import order. *Mitigation:* keep a single barrel export, run tests after each move.
- Risk 2: Telegram bot is live-process critical; a bug means alerts stop. *Mitigation:* test in paper mode first, do not deploy until verified.

**Estimate:** 35–50 min.

---

### S6 — Backfill tests for untested I/O paths (split per module)

**Why:** `runtime/app.ts` (814 LOC), `indicators/` (2293 LOC in-module, 1 test elsewhere), `ui/tui.tsx` (1418 LOC), `memory/` (297 LOC), `db/` (302 LOC) have low or zero direct test coverage in their module folders. Some have coverage in `test/`, but the gaps are real for `runtime/`, in-module `indicators/`, and `memory/`.

**Scope (split per module — 5 sub-sessions):**

- **S6a — `src/indicators/`:** Add golden-fixture tests for each pure function (per `quality-gates.md` "New Indicators" gate). Existing fn behavior is the spec.
- **S6b — `src/runtime/app.ts`:** Test boot ordering (migrations → coin select → WS → PG load → gap-fill). Mock feeds + DB. Don't test live reconnect (covered by integration).
- **S6c — `src/memory/`:** Test `repository.ts` storage + scored retrieval against a fake corpus. The whole module is foundation; lock in behavior before wiring to runtime.
- **S6d — `src/ui/tui.tsx`:** Test render snapshots for bootstrap, dashboard, position view. Skip interactive paths.
- **S6e — `src/db/` + bybit-ws spy rewrite:** (1) Move existing `test/db/*` test references into expected location OR document that DB tests live in `test/db/` by convention. (2) Rewrite the 5 currently-skipped tests in `src/feed/bybit/bybit-ws.test.ts` to assert on observable side effects (topicCallbacks/coinTopics map state) instead of `mock.module()` spies. The spy approach is order-dependent because the bunfig preload (`test/preload/bybit-api.mock.ts`) loads first and locks `bybit-ws.ts`'s static `import { WebsocketClient }` binding. CI evidence: 5 bybit-ws tests fail on Linux runners; same tests pass on macOS local.

**Completion criteria (per sub-session):**
- [ ] Each module has at least 1 test file co-located OR explicitly documented in `test/`.
- [ ] Indicator tests: golden fixture in `test/fixtures/`, edge cases (empty, <min, NaN).
- [ ] `bun test --run` passes with N new tests where N matches added cases.

**Operational risk:**
- Risk 1: Tests pin current buggy behavior as "expected". *Mitigation:* before each test, run the function with a known-good input and verify output manually.
- Risk 2: Scope creep — adding "while I'm here" features. *Mitigation:* this is test-only; if you find a bug, file it as a separate session, don't fix inline.

**Estimate:** 30–45 min per sub-session, 5 sub-sessions total.

---

## Out of scope for this plan

These are real but defer:

1. **Split `src/agent/order-manager.ts` (1163 LOC).** Largest agent file. Touches execution path. High risk, low immediate ROI. Revisit after S6.
2. **Split `src/strategy/strategies/smc-sd/index.ts` (1327 LOC).** Single concrete setup engine; splitting risks breaking strategy boundaries documented in `docs/strategy-engine.md`.
3. **Wire `src/memory/` to runtime.** Belongs in Sprint 7 (memory intelligence), not refactor.
4. **`src/server/` HTTP handler refactor.** Functional; only refactor if S3/S4 surfaces issues.
5. **Backtest module audit (5552 LOC).** Largely test infrastructure; not on live path.

---

## Definition of Done (whole plan)

- [ ] All 6 sessions complete (S6 = 5 sub-sessions = 10 total sessions max).
- [ ] `CLAUDE.md` matches reality.
- [ ] `bun run lint` and `bun run deadcode` both clean or with documented suppressions.
- [ ] No file in `src/alert/telegram/` exceeds 600 LOC.
- [ ] `runtime/`, `indicators/`, `memory/`, `ui/` have at least 1 co-located or `test/`-located test file each.
- [ ] `bun test --run` passes (≥1143 tests; expect >1200 after S6).
- [ ] `bun run typecheck` passes.
- [ ] `/health` composite ≥9.5 with **lint + knip active** (real test, not skip-redistribution).
- [ ] Commit log shows each session as a single squashed commit following `<type>(<scope>): <description>` convention.

---

## Session order + dependencies

```
S1 (docs) ─┐
S2 (move) ─┼─► [parallel safe, no code dependencies]
S3 (tools) ┘
            │
            └─► S4 (lint baseline) ─► S5 (telegram split) ─► S6a..e (tests)
```

Estimated total: **6–10 hours** of focused session time across 10 sessions over 1–2 weeks of part-time work.

---

## Notes

- All sessions follow `.claude/rules/session-protocol.md` Task Contract.
- All sessions verify with `bun test --run` per `.claude/rules/quality-gates.md`.
- If any session exceeds 2× estimate, STOP and split — do not push through.
- Branch `plan/greenfield-rebuild-audit` (this branch) is the audit artifact. Each S* session opens its own `refactor/sN-<topic>` branch off `main`.
