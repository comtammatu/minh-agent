---
paths: src/indicators/**/*.ts
---
# Indicator Rules

- Zero I/O, zero side effects, deterministic — NEVER import fetch, WebSocket, fs, or console
- All indicators return values, never mutate input arrays
- Return `null` for invalid input (empty array, < minimum candles, NaN)
- Golden test fixtures verify correctness — tests compare output against known-good snapshots
- No magic numbers — all thresholds must be named constants in `config.ts`
- Explicit over clever: readable code > short code, named variables > inline expressions