# Strategy Engine

The strategy engine is built as a pure scan pipeline around a registry and one event emitter. `StrategyRegistry` defines the `IStrategy` contract, tracks enablement, isolates per-strategy failures with `try/catch`, and returns only concrete `Signal` results to the orchestrator (`src/strategy/registry.ts:26`, `src/strategy/registry.ts:72`, `src/strategy/registry.ts:165`, `src/strategy/registry.ts:201`). This is a conservative design: one strategy can fail or be disabled without blocking the rest of the scanner.

`strategy/orchestrator.ts` is the real runtime bridge between candles and signals. It builds closed-candle scan buffers, derives HTF context, refreshes status snapshots, runs all enabled strategies, materializes active setups, and emits them through `pipelineEmitter` (`src/strategy/orchestrator.ts:210`, `src/strategy/orchestrator.ts:238`, `src/strategy/orchestrator.ts:240`, `src/strategy/orchestrator.ts:263`). The explicit closed-candle gate in `onCandleTick()` is one of the most important invariants in the project because it prevents half-formed bars from generating live signals and keeps replay semantics aligned with production (`src/strategy/orchestrator.ts:329`, `src/strategy/orchestrator.ts:353`, `src/strategy/orchestrator.ts:366`).

The current production strategy is `SmcSdStrategy`, but it is not a single-pass detector. The module encodes a staged 4h -> 15m -> 5m drill-down path, maintains POI pools and dedup state, and exposes diagnostics counters for each stage (`src/strategy/strategies/smc-sd/index.ts:2`, `src/strategy/strategies/smc-sd/index.ts:84`, `src/strategy/strategies/smc-sd/index.ts:100`, `src/strategy/strategies/smc-sd/index.ts:149`). That explains why `strategy/strategies/smc-sd/index.ts` is itself a hub in the import graph: it concentrates the current market thesis as well as the operational decision thresholds (`docs/oracle-data/analysis-summary.md:23`).

The strategy layer is tightly coupled to `config.ts` by design. Signal thresholds, regime multipliers, lookback windows, TTLs, and many ICT-specific bonuses or penalties live in config rather than being hard-coded in the strategy class (`src/config.ts:25`, `src/config.ts:34`, `src/config.ts:43`, `src/config.ts:127`, `src/config.ts:134`, `src/config.ts:194`). That is maintainable for tuning, but risky for mixed live/research work because a config edit immediately changes both the live engine and every backtest that does not pin parameters explicitly.

## Failure modes and recovery

The main failure mode inside the strategy layer is silent degradation rather than crash. If a strategy throws, the registry logs the error and continues scanning the remaining strategies (`src/strategy/registry.ts:201`). If candles are insufficient, the orchestrator simply skips scanning (`src/strategy/orchestrator.ts:219`). Both behaviors are operationally safe, but they can hide regressions if operators rely only on process liveness instead of signal counts and diagnostics.

The second failure mode is dedup or state contamination. The orchestrator stores active setups, last candle timestamps, and scan buffers at module scope, then offers `clearPipelineState()` and `bootstrapPipelineFromStore()` to manage transitions between startup, reconnect, and backtest modes (`src/strategy/orchestrator.ts:308`, `src/strategy/orchestrator.ts:410`). Any change that bypasses those reset points risks state leakage across runs.

## Blast radius and safe change plan

Edits to `config.ts`, `types.ts`, or `strategy/registry.ts` have the broadest effect because they sit above individual pattern logic in the dependency graph (`docs/oracle-data/analysis-summary.md:23`). Safe work in this layer should start by deciding whether the change is:

- a model-threshold change in `config.ts`,
- a strategy contract change in `registry.ts` or `types.ts`, or
- a local detection change inside one strategy implementation.

Those are different risk classes. Treating them as one refactor will make regression analysis much harder.

## Unknowns

- Unknown: whether the current multi-stage SMC-SD thresholds are still coherent after recent config tuning. Verification step: rerun the benchmark and walk-forward scripts with pinned configs and compare setup counts plus win-rate drift.
- Unknown: whether the registry abstraction is sufficient once multiple production strategies are live at once. Verification step: register at least two materially different strategies and inspect setup/event volume, dedup interactions, and TUI clarity.

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: direct source reading + generated import graph
Audience: feature owner, refactor owner | Confidence: 83%
Unknowns: 2 items pending verification
-->
