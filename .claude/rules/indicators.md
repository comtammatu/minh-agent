---
paths: src/indicators/**/*.ts
---
# Indicator Rules

Indicators are the deepest pure layer. They are imported by `strategy/`, `backtest/`, and tests — any side effect leaks contaminate all three.

## Invariants
- Zero I/O, zero side effects, fully deterministic
- NEVER import `fetch`, `WebSocket`, `fs`, `console`, `Date.now`, or `Math.random`
- All indicators return values; NEVER mutate input arrays
- Return `null` for invalid input (empty array, fewer than minimum candles, NaN)
- No magic numbers — thresholds live in `src/config.ts`
- Explicit over clever: named variables > inline expressions

## Testing
- Every indicator needs a **golden fixture** test (output snapshot against known-good values)
- Edge cases REQUIRED: empty array, below-minimum length, NaN inputs
- See [quality-gates.md](quality-gates.md) — "New Indicators" checklist
