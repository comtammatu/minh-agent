# Minh (明) — Session Memory

## Current state (2026-04-12) — active

**Stack:** Bun / TypeScript. **Exchange (backtest data):** Bybit REST candles. **Strategy under research:** `smc-sd` (ICT SMC), walk-forward validation.

### Backtest & diagnostics (Evolution / 1h edge)

- **Primary live mode on WF:** `1h_same_tf`. OOS PF on full universe was a core concern (historically below 1 before fixes).
- **Repeatable scripts:**
  - `bun run src/backtest/run-drilldown-diag.ts [coins]` — drilldown counters, raw 1h isolation, Top-3 vs Rest (raw), WF OOS per coin.
  - `bun run src/backtest/run-wf-universe-compare.ts [baseline] [subset]` — **same params**, two coin sets, WF OOS table + JSON under `results/`.
  - `bun run src/backtest/optimize.ts [trials] [coins]` — random param search + holdout.
- **WF universe compare (latest logged runs, 2026-04-12):** Script supports `WF_COMPARE_EXTENDED_HISTORY=1` (longer candles) + `WF_COMPARE_STRATEGY_PARAMS` JSON. **Extended + `{}`:** A ~PF **0.78**, **245** trades / 311 WFs; B Top-3 ~PF **1.17**, **92** trades — still **`1h_same_tf` only**. **Mid-6** subset `BTC,ETH,SOL,AVAX,LINK,BNB` vs 10-coin: **failed** (PF ~0.34, DD metric exploded — do not use). **Locked params** (Day-8-style trial): Top-3 OOS PF ~**2.34** / **76** trades; 10-coin still ~**0.86** OOS. Artifacts: `results/wf-universe-compare-2026-04-12T07-05-18-587Z.json`, `...07-08-48-419Z.json`, `...07-12-02-323Z.json`.
- **Decision doc:** Full tables → `docs/plan/decisions.md` (*WF universe compare — extended history + mid-tier + locked params*).

### Tests

- **`bun test --run`:** **1112 pass, 6 fail** (2026-04-12). Failures: **`fetchBybitCandles` / `fetchBybitCandlesBatched`** in `src/feed/bybit/bybit-rest.test.ts` — **live API / network**. Optional follow-up: mock or conditional skip for CI stability.

### Next focus (short)

1. **Grade filter / exitReason** drilldown (per `decisions.md` checklist) if prioritizing entry quality; P2 drilldown/simulator only with explicit scope.
2. Optional: different **mid-tier** coin pick (liquidity-ranked), not the 2026-04-12 mid-6 list.

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
- `src/scanner/layers/*` — layered pipeline (bias → structure → zones → confirm → trigger)

### Gotchas (still useful)
- HL / Bybit numerics often **strings** → parse carefully where applicable
- Store upserts by timestamp (dedup)

### Next (historical)
- Sprint 1.5 S2: CoinSelector wiring in `index.ts` — verify against current `src/` layout if revisiting.
