# Oracle Analysis Summary

Method: direct source reading plus generated static artifacts in `docs/oracle-data/tree-sitter-analysis.json` and `docs/oracle-data/import-graph.json`.

## Snapshot

- Files analyzed: 118 TypeScript/TSX files under `src/`.
- Internal relative-import edges resolved: 472.
- Tree-sitter inventory: 991 functions, 186 classes, 598 exports, 11,081 call sites.

## File counts by top-level module

- `agent`: 24 files
- `feed`: 22 files
- `backtest`: 19 files
- `strategy`: 11 files
- `alert`: 8 files
- `analytics`: 7 files
- `indicators`: 7 files
- `execution`: 6 files
- `ui`: 5 files
- `(root)`: 4 files
- `db`: 3 files
- `lib`: 2 files

## Top hub files by dependent count

- `types.ts`: 62 dependents
- `config.ts`: 60 dependents
- `lib/logger.ts`: 39 dependents
- `agent/types.ts`: 25 dependents
- `backtest/types.ts`: 20 dependents
- `strategy/registry.ts`: 13 dependents
- `strategy/strategies/smc-sd/index.ts`: 11 dependents
- `agent/trading-agent.ts`: 10 dependents
- `feed/rest.ts`: 9 dependents
- `execution/exchange-service.ts`: 8 dependents

## Strongest cross-module dependencies

- `backtest -> (root)`: 27 edges
- `feed -> (root)`: 27 edges
- `agent -> (root)`: 24 edges
- `backtest -> strategy`: 22 edges
- `(root) -> feed`: 21 edges
- `strategy -> (root)`: 14 edges
- `alert -> agent`: 12 edges
- `feed -> lib`: 12 edges
- `strategy -> indicators`: 11 edges
- `agent -> lib`: 8 edges
- `backtest -> feed`: 8 edges
- `backtest -> lib`: 8 edges

## Notes

- `(root)` represents `src/index.ts`, `src/config.ts`, `src/types.ts`, and `src/compare-exchanges.ts`.
- Relative ESM imports ending in `.js` were resolved to local `.ts` and `.tsx` sources when present.
