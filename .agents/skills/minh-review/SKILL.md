---
name: minh-review
description: Pre-commit / pre-PR defect review for Minh’s quant pipeline (feed, minh, agent, execution, server). Use when reviewing money-path or market-data diffs.
---

# minh-review

Orient on [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) (Current vs Proposed). Do not treat DESIGN 05–07 Proposed UI/API as shipped.

## Pre-flight

```bash
bun run typecheck
bun run test:run
```

Strategy / indicator / cache / config hot path:

```bash
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
```

## Checklist (CRITICAL → LOW)

**CRITICAL**

- Secrets committed
- Pure boundary broken in `src/indicators/` or pure `src/strategy/` helpers
- Closed-candle gate / `onCandleTick` bypass (live≠backtest drift)
- Boot order regressions (WS-before-backfill, write-through-after-backfill, agent wired before pipeline subscribe)
- HL numeric/string, wallet split, precision, OI cap; money logic (SL side, size, risk)
- Exchange invariants (mixed exchange, multi-wallet assumptions)

**HIGH**

- `any` without comment; unsafe `!`
- Magic numbers outside `src/config.ts`
- Floating promises at I/O edges
- Invalidation TTL drift vs `.claude/rules/invalidation-table.md`
- Docs claiming Elysia/SSE as current, or denying live deterministic `src/advisor/`
- Capability lies vs `docs/FEATURES.md` / ARCHITECTURE §2

**MEDIUM / LOW**

- Missing tests; API change without DESIGN 07 **Current** + ARCHITECTURE §5 update
- Treating Proposed dashboard auth/SSE as implemented

## Output

`[SEVERITY] path — issue — fix` then `Verdict: APPROVE | WARNING | BLOCK`

Read-only unless the owner asks for fixes.
