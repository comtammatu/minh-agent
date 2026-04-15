# Strategy Engine

The current branch runs one concrete setup engine: `smc-sd`. The single-strategy boundary now lives in `src/strategy/engine.ts`, which exposes the concrete scan entrypoints used by both live mode and replay tooling. There is no runtime registry or enable/disable fan-out on the active path anymore.

`src/strategy/orchestrator.ts` is the runtime bridge between candles and setups. It builds closed-candle scan buffers, derives HTF context, refreshes status snapshots, runs the setup generator, materializes active setups, and emits them through `pipelineEmitter`. The explicit closed-candle gate in `onCandleTick()` remains one of the most important invariants in the project because it prevents half-formed bars from generating live signals and keeps replay semantics aligned with production.

`SmcSdStrategy` is still multi-stage internally even though the runtime is single-strategy. The module encodes the 4h -> 15m -> 5m drill-down path, maintains POI pools and dedup state, and exposes diagnostics counters for each stage. That makes `src/strategy/strategies/smc-sd/index.ts` one of the highest-blast-radius model files in the repo.

The strategy layer is tightly coupled to `config.ts` by design. Signal thresholds, regime multipliers, lookback windows, TTLs, and many ICT-specific bonuses or penalties live in config rather than being hard-coded in the strategy class (`src/config.ts:25`, `src/config.ts:34`, `src/config.ts:43`, `src/config.ts:127`, `src/config.ts:134`, `src/config.ts:194`). That is maintainable for tuning, but risky for mixed live/research work because a config edit immediately changes both the live engine and every backtest that does not pin parameters explicitly.

## Failure modes and recovery

The main failure mode inside the strategy layer is silent degradation rather than crash. If the concrete setup generator throws, the orchestrator logs and skips that scan cycle. If candles are insufficient, the orchestrator simply skips scanning. Both behaviors are operationally safe, but they can hide regressions if operators rely only on process liveness instead of signal counts and diagnostics.

The second failure mode is dedup or state contamination. The orchestrator stores active setups, last candle timestamps, and scan buffers at module scope, then offers `clearPipelineState()` and `bootstrapPipelineFromStore()` to manage transitions between startup, reconnect, and backtest modes (`src/strategy/orchestrator.ts`). Any change that bypasses those reset points risks state leakage across runs.

## Blast radius and safe change plan

Edits to `config.ts`, `types.ts`, or `src/strategy/engine.ts` have the broadest effect because they sit above individual pattern logic in the dependency graph. Safe work in this layer should start by deciding whether the change is:

- a model-threshold change in `config.ts`,
- a setup-engine contract change in `engine.ts` or `types.ts`, or
- a local detection change inside one strategy implementation.

Those are different risk classes. Treating them as one refactor will make regression analysis much harder.

## Unknowns

- Unknown: whether the current `smc-sd` staging and dedup thresholds remain coherent after config tuning. Verification step: rerun pinned benchmark and walk-forward fixtures and compare setup counts plus trade totals before shipping.

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: direct source reading + generated import graph
Audience: feature owner, refactor owner | Confidence: 83%
Unknowns: 2 items pending verification
-->
