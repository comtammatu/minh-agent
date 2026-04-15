# Minh (明) — Session Memory

## Current state (2026-04-15) — active

**Stack:** Bun / TypeScript. **Exchanges:** Hyperliquid + Bybit behind one exchange-service boundary. **Live runtime:** one active exchange per process, one shared wallet/account per process, one concrete `smc-sd` setup engine.

### Runtime shape

- Thin process entrypoint in `src/index.ts`.
- Long-lived boot/reconnect/shutdown orchestration in `src/runtime/app.ts`.
- Strategy runtime collapsed to one canonical engine path in `src/strategy/engine.ts`.
- Agent/execution runtime collapsed to single-context semantics keyed by coin, not `coin:strategyId`.
- Historical docs live under `docs/archive/`; active implementation docs stay at repo root and `docs/*.md`.

### Validation

- **`bun run typecheck`**: pass (2026-04-15)
- **`bun test --run`**: **1150 pass, 0 fail** (2026-04-15)
- Fresh DB smoke boot passed in paper mode for both:
  - `ACTIVE_EXCHANGE=HL`
  - `ACTIVE_EXCHANGE=BB`

### Research / diagnostics pointers

- `bun run src/backtest/run-drilldown-diag.ts [coins]`
- `bun run src/backtest/run-wf-universe-compare.ts [baseline] [subset]`
- `bun run src/backtest/optimize.ts [trials] [coins]`
- Historical decision log and older research notes: `docs/archive/plan/decisions.md`

### Current cleanup status

- Active docs and `.claude/*.md` guidance are aligned with the canonical single-strategy runtime.
- Archive docs live under `docs/archive/` and are explicitly framed as historical references instead of current truth.

---

## Historical snapshot (2026-03-30) — may be stale

### Sprint overview (old)
- **Sprint 1**: DONE — Analysis engine
- **Sprint 1.5**: IN PROGRESS — Scale to 50 coins + feed optimization
- **Sprint 2**: PLANNED — Agent Trading (PostgreSQL, Elysia)
- **Sprint 3**: PLANNED — Backtest, analytics, dashboard

### Sprint 1.5 progress (old)
- **S1 (B-1)**: fetchTopCoins + CoinSelector
- **S2–S4**: wiring / backfill / assetCtx — verify repo if revisiting

### Test baseline (old)
- 192 pass, 3 skip, 0 fail (18 test files) — **not current** (see Current state above)

### Old file structure
- Earlier planning notes referenced pre-cleanup scanner-style paths and layered docs; use `docs/archive/` if you need that history, not the current `src/` layout.

### Gotchas (still useful)
- HL / Bybit numerics often **strings** → parse carefully where applicable
- Store upserts by timestamp (dedup)

### Next (historical)
- Sprint 1.5 S2: CoinSelector wiring in `index.ts` — verify against current `src/` layout if revisiting.
