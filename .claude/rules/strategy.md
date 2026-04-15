---
paths: src/strategy/**/*.ts
---
# Strategy Rules

- Pure functions only — zero I/O, zero side effects
- Live and replay both go through the same canonical setup path: `onCandleTick()` → closed-candle gate → `smc-sd` setup generation
- Confluence scoring grades: C / B / A / A+
- Regime filter is SOFT — reduces confidence, does NOT block signals
- Pattern invalidation uses TTL (bars) — see `.claude/rules/invalidation-table.md`
- Risk filter: zone distance → position size / RR ratio / skip decision
