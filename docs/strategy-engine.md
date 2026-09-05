# Strategy Engine

Quant setup path for Minh. Overview: [ARCHITECTURE.md §4](ARCHITECTURE.md).

## Role

- One concrete engine: **`minh`** via `src/strategy/engine.ts`
- Runtime bridge: `src/strategy/orchestrator.ts`
- Implementation: `src/strategy/minh/`

No live strategy registry. Live and research must share this path.

## Closed-candle invariant

`onCandleTick(coin, interval, candle)`:

1. Always `appendCandle` to the hot store
2. If same timestamp as last → forming bar → **no scan**
3. First tick for key → seed only
4. Non-signal TFs → store only
5. Else → `dispatchClosedBarScan` → minh

Bypassing `onCandleTick` / `pipelineEmitter` drifts live vs backtest.

## minh

- Multi-stage internally (HTF context / POI / LTF entry / drilldown) inside one module
- Confluence grades C / B / A / A+; soft regime multipliers (aligned / neutral / counter)
- All thresholds in `src/config.ts`
- Pattern invalidation TTLs: `.claude/rules/invalidation-table.md`
- Additive scoring can stack past `MIN_CONFIDENCE` — treat new bonuses as distribution changes

## State hygiene

Module-scope active setups, scan buffers, last timestamps. Use `clearPipelineState`, `bootstrapPipelineFromStore`, `bootstrapReplayFromStore`, `materializeCurrentSetupsFromStore` at boot / reconnect / backtest boundaries.

## Failure mode

Generator throw or insufficient candles → log/skip scan (no crash). Watch setup counts/diagnostics, not just process liveness.

## Rules

[.claude/rules/strategy.md](../.claude/rules/strategy.md) · [.claude/rules/indicators.md](../.claude/rules/indicators.md)
