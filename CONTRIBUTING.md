# Contributing

Deterministic behavior, low-latency scans, safe execution boundaries.

## Before you change code

1. [CLAUDE.md](CLAUDE.md) — constraints + rule pointers
2. [docs/FEATURES.md](docs/FEATURES.md) + [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — what ships + how the pipeline works
3. [docs/WORKFLOW.md](docs/WORKFLOW.md) — local loop + Task Contract
4. [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) / [docs/DESIGN.md](docs/DESIGN.md) — map + UI/schema/API
5. Keep pure logic in `src/indicators/` and pure `src/strategy/` helpers
6. Keep I/O at edges: `feed/`, `execution/`, `runtime/`, `presence/`, `alert/`

## Local workflow

```bash
bun install
docker-compose up -d
bun run typecheck
bun run test:run
ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci   # strategy hot path
bun run start                                  # or: bun run dev
```

## Quality gates

1. `bun run test:run` passes
2. `bun run typecheck` passes (TypeScript 7.x, strict)
3. `bun run lint` — clean or justified biome baseline
4. `bun run deadcode` — clean or documented knip FPs
5. `bench:pipeline:ci` when touching strategy / indicators / cache / config / CI budget
6. No new `any` without justification comment
7. No new magic numbers outside `src/config.ts`
8. No side effects in pure indicator/strategy helpers

Details: [.claude/rules/quality-gates.md](.claude/rules/quality-gates.md).

## Typecheck scope

- `bun run typecheck` → `tsconfig.typecheck.json` (locks `src/**`, excludes most tests)
- Tests enforced via `bun test --run` / `test:run`
- TypeScript **7.x** pinned in `devDependencies`

## Performance gate

- CI uses GitHub-hosted runners; `p95` strict, `p99` has headroom
- Budget changes → record rationale in `docs/archive/plan/decisions.md`

## Config discipline

- Prefer removing stale env vars
- One active exchange + one shared wallet per process
- `EXECUTION_MODE=paper|live` is canonical; `PAPER_TRADE` is legacy alias only

## Execution / risk

- HL has native dead man's switch; BB uses external heartbeat watchdog
- Do not assume Bybit matches HL safety semantics

## Good PR scope

One cleanup **or** one strategy change **or** one tooling change — not all three unless inseparable.
