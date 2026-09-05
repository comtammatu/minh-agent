---
paths: src/strategy/**/*.ts
---
# Strategy Rules

Strategy code is the **pure** half of the pipeline. Side effects belong in `agent/`, `execution/`, `feed/`, `db/`, `runtime/`, `ui/`, `alert/telegram/` — never here.

## Invariants
- Pure functions only — zero I/O, zero side effects
- Live and replay both go through the same canonical setup path:
  `onCandleTick()` → closed-candle gate → `minh` setup generation
- Bypassing `onCandleTick()` or `pipelineEmitter` instantly drifts live vs backtest
- No magic numbers — all thresholds live in `src/config.ts`

## SMC-SD specifics
- Confluence scoring grades: **C / B / A / A+**
- Regime filter is **SOFT** — reduces confidence (×1.0 / ×0.8 / ×0.3), does NOT block counter-trend signals
- Pattern invalidation uses **TTL in bars** — see [invalidation-table.md](invalidation-table.md)
- Risk filter consumes zone distance → emits position size / RR ratio / skip decision

## detectRegime
- Requires **≥ 50 candles** (SMA / ATR / ADX / volume need warm-up)
- Returns null below the floor — caller must handle, do not fabricate a default regime

## Scoring caveat
- Current scoring is **additive** with ~16 small bonuses that can stack past `MIN_CONFIDENCE` from weak signals
- Treat any new bonus addition as a confidence-distribution change, not a free win
- See `docs/archive/plan/decisions.md` for the multiplicative-vs-additive scoring debate

## See also
- Pipeline + capability map: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- Deep dive: [docs/strategy-engine.md](../../docs/strategy-engine.md)
- Pattern TTLs: [invalidation-table.md](invalidation-table.md)
