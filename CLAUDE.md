# Minh (明) — Real-time Trading Analysis Engine

Pure-computation trading analysis: Historical Candles → Market Structure (multi-TF) → Domain Knowledge (PA, SMC, VSA, Wyckoff) → Setup Detection. No LLM. Sub-10ms per tick.

## Commands

```bash
bun install               # Install dependencies
bun run src/index.ts      # Start (backfill → subscribe → scan)
bun test                  # Run all tests (watch mode)
bun test --run            # Run all tests (single run, MUST pass before done)
```

## Constraints

- MUST use TypeScript strict mode. NEVER use `any` without justification comment
- NEVER do I/O in `indicators/` or `scanner/` — pure functions only, zero side effects
- I/O lives at edges: `feed/` and `index.ts` only
- MUST run `bun test --run` before marking any task complete
- Task Contract REQUIRED for 3+ step tasks (see `.claude/rules/session-protocol.md`)
- No magic numbers — all thresholds in `config.ts`
- NEVER commit secrets (.env, API keys, private keys)
- Simplest working solution wins: `slice()` over ring buffer, `Map` over SQLite

## Architecture

```
Browser → Hyperliquid REST (backfill) + WS (live) → In-memory Store → Scanner Pipeline
Scanner: Bias → Structure → Zones → Confirm → Trigger → Confluence → Regime filter
```

Runtime: Bun | SDK: @nktkas/hyperliquid | Store: In-memory Map<string, Candle[]>

## Key Directories

- `src/indicators/` — Pure functions: ATR, SMA, EMA, RSI, ADX, FVG, OB, BOS, VSA, Wyckoff
- `src/scanner/` — 5-layer pipeline + confluence + regime + risk filter + invalidation
- `src/feed/` — REST backfill, WS subscribe, in-memory store (I/O boundary)
- `src/config.ts` — All thresholds, regime multipliers, coin/TF lists
- `src/types.ts` — Core type definitions

## Things That Will Bite You

- **HL SDK**: All numeric values are **strings** → `parseFloat()` everywhere
- **HL WS**: Returns 0 historical candles, only current bar → MUST REST backfill first
- **HL REST**: Max 5000 candles/request. **Weight-based** rate limit: 1200 weight/min per IP. Info requests cost weight 20, `candleSnapshot` has extra per-60-items surcharge. Effective: ~45 burst + ~1 req/1.2s sustained. All REST callers go through `feed/rate-limiter.ts`
- **Candle dedup**: WS may resend same timestamp as REST → store upserts by timestamp
- **Staleness**: Track `lastCandleTime` per coin/tf, WARNING after 60s silence
- **Regime filter**: Soft — does NOT block counter-trend, reduces confidence (×1.0/×0.8/×0.3)
- **detectRegime**: Requires 50+ candles (SMA/ATR/ADX/volume)

## Code Patterns

- Pure functions return values, never mutate input, return `null` for invalid input
- `try/catch` at I/O boundaries only
- Commit: `<type>(<scope>): <description>` — types: feat/fix/refactor/test/docs/chore/perf

## References

- Sprint plans: `docs/plan/sprint-1.md`, `docs/plan/sprint-2.md`, `docs/plan/sprint-3.md`
- Architecture + diagrams: `docs/spec/architecture.md`
- Knowledge spec (detect/invalidate rules): `docs/spec/knowledge-spec.md`
- Domain knowledge (trading schools): `docs/ref/domain-knowledge.md`
- Decision log: `docs/plan/decisions.md`
- Session protocol + task contract: `.claude/rules/session-protocol.md`
- Quality gates: `.claude/rules/quality-gates.md`
- Pattern invalidation rules: `.claude/rules/invalidation-table.md`
