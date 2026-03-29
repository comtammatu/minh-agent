---
paths: src/scanner/**/*.ts
---
# Scanner Rules

- Pure functions only — zero I/O, zero side effects
- 5-layer pipeline: Bias → Structure → Zones → Confirm → Trigger
- Confluence scoring grades: C / B / A / A+
- Regime filter is SOFT — reduces confidence, does NOT block signals
- Pattern invalidation uses TTL (bars) — see `.claude/rules/invalidation-table.md`
- Risk filter: zone distance → position size / RR ratio / skip decision