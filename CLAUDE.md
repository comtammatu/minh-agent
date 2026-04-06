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
- NEVER do I/O in `indicators/` or `strategy/` — pure functions only, zero side effects
- I/O lives at edges: `feed/` and `index.ts` only
- MUST run `bun test --run` before marking any task complete
- Task Contract REQUIRED for 3+ step tasks (see `.claude/rules/session-protocol.md`)
- No magic numbers — all thresholds in `config.ts`
- NEVER commit secrets (.env, API keys, private keys)
- Simplest working solution wins: `slice()` over ring buffer, `Map` over SQLite

## Architecture

```
Browser → Hyperliquid REST (backfill) + WS (live) → In-memory Store → Strategy Pipeline
Strategy: Bias → Structure → Zones → Confirm → Trigger → Confluence → Regime filter
```

Runtime: Bun | SDK: @nktkas/hyperliquid | Store: In-memory Map<string, Candle[]>

## Key Directories

- `src/indicators/` — Pure functions: ATR, SMA, EMA, RSI, ADX, FVG, OB, BOS, VSA, Wyckoff
- `src/strategy/` — Orchestrator + diagnostics + registry + strategies (layered/quant/smc-sd) + shared (regime/invalidation)
- `src/feed/` — REST backfill, WS subscribe, in-memory store (I/O boundary)
- `src/config.ts` — All thresholds, regime multipliers, coin/TF lists
- `src/types.ts` — Core type definitions

## Things That Will Bite You

- **HL SDK**: All numeric values are **strings** → `parseFloat()` everywhere
- **HL WS**: Returns 0 historical candles, only current bar → MUST REST backfill first
- **HL REST rate limit**: **Weight-based** 1200 weight/min per IP. Info=20, candleSnapshot=20+ceil(items/60) surcharge (500 candles→~29w, 5000→~104w), l2Book/allMids/clearinghouseState/orderStatus=2, exchange=1. All REST callers go through `feed/rate-limiter.ts` (burst 12 + 1 req/3s sustained)
- **HL REST candles**: Max 5000/request. Per-TF counts: 500 for 1m/5m, 5000 for 15m+ (config `BACKFILL_CANDLE_COUNTS`)
- **HL address rate limit**: 1 req per 1 USDC traded (cumulative). Initial buffer 10K. Stale `expiresAfter` cancels cost **5x weight**
- **HL order precision**: Prices max 5 sig figs + `(6 - szDecimals)` decimals. Sizes rounded to `szDecimals`. Remove trailing zeroes. Min order value $10. Asset ID = index from `meta.universe`, NOT coin name
- **HL signing**: Two schemes (l1_action vs user_signed_action). Field order matters. Lowercase addresses. Wrong signature → opaque error ("missing wallet"). Use SDK, don't DIY
- **HL OI cap**: Some assets at OI cap → can't open positions. Check `perpsAtOpenInterestCap()` before placing
- **HL dead man's switch**: `scheduleCancel` auto-cancels all orders after timestamp. Max 10/day. Critical for bot safety
- **HL WS limits**: 1000 subs, 10 connections, 2000 msg/min. Currently ~121 subs (12%). Guard in `registerSubscription()` blocks at 1000, warns at 80%
- **HL agent wallet**: Bot uses agent wallet PK (`PRIVATE_KEY`) for signing, main account address (`ACCOUNT_ADDRESS`) for info queries. Agent wallet can trade but **cannot withdraw**. Nonces tracked per agent address. Agent expires (check HL UI) — renew before expiry. Never reuse deregistered agent addresses (replay attack risk)
- **HL unified account**: Balance lives in spot (`spotClearinghouseState`), not perp (`clearinghouseState`). `getAccountState()` queries both and returns `effectiveBalance = perp + spot USDC`
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
