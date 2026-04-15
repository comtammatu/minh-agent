# Contributing

This project optimizes for deterministic behavior, low-latency scans, and safe execution boundaries.

## Before You Change Code

1. Read [AGENTS.md](AGENTS.md)
2. Read [README.md](README.md) and [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) for the current architecture; use [docs/archive/plan/decisions.md](docs/archive/plan/decisions.md) only for historical rationale
3. Keep pure logic inside `src/indicators/` and `src/strategy/`
4. Keep I/O at the edges: `src/feed/`, execution services, and `src/index.ts`

## Local Workflow

```bash
bun install
bun run typecheck
bun test --run
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
```

Use `ACTIVE_EXCHANGE=HL` for benchmark validation unless you are intentionally working on Bybit-specific behavior.

## Quality Gates

Every non-trivial change should satisfy all of these:

1. `bun test --run` passes
2. `bun run typecheck` passes
3. `ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci` passes when touching strategy, indicators, cache, config, or CI budget code
4. No new `any` without a justification comment
5. No new magic numbers outside `src/config.ts`
6. No side effects inside pure indicator/strategy helpers

## Typecheck Scope

- `bun run typecheck` uses [`tsconfig.typecheck.json`](tsconfig.typecheck.json).
- It intentionally locks `src/**` runtime modules and excludes `test/**` plus `src/**/*.test.ts`.
- Tests are still mandatory and are enforced separately via `bun test --run`.
- Rationale: we want strict compiler guarantees on production code without turning fixture-heavy test files into the main source of CI noise.

## Performance Gate Policy

- CI uses GitHub-hosted runners, not a developer laptop baseline.
- `p95` is intentionally strict.
- `p99` has more headroom because hosted runners show higher tail-latency variance.
- If you need to update the benchmark baseline or budget, record the reason in [docs/archive/plan/decisions.md](docs/archive/plan/decisions.md).

## Config Discipline

- Prefer removing stale env vars over keeping “just in case” examples.
- This repo currently uses:
  - one active exchange per process
  - one shared wallet/account per process
- If docs or `.env.example` still mention removed multi-wallet flow, treat that as cleanup work.

## Execution/Risk Notes

- Hyperliquid has a native dead man's switch.
- Bybit does not. Current runtime surfaces that limitation explicitly on shutdown in live mode.
- Do not assume Bybit has equivalent safety semantics to Hyperliquid.

## Good PR Scope

Good changes are:

- one architectural cleanup with tests
- one CI or tooling cleanup with verification
- one strategy/indicator improvement with benchmark evidence

Avoid bundling:

- large refactors
- strategy logic changes
- CI budget changes
- execution/risk changes

in the same PR unless they are inseparable.
