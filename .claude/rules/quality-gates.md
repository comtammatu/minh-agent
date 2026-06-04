# Quality Gates

## Every Task

- [ ] `bun run test:run` — all tests pass (main + dashboard vitest; per package.json + CONTRIBUTING)
- [ ] `bun run typecheck` — passes (for non-trivial)
- [ ] `bun run lint` — clean or with documented suppressions (biome; no `any` w/o comment, no unused)
- [ ] `bun run deadcode` — clean or documented (knip)
- [ ] No `any` without justification comment
- [ ] No magic numbers — all thresholds in `config.ts`
- [ ] Pure function boundary maintained (`src/indicators/` and pure `src/strategy/` helpers stay zero-I/O)
- [ ] No secrets in code (.env patterns, API keys)

## New Indicators

- [ ] Golden test fixture exists
- [ ] Golden test passes (output matches fixture)
- [ ] Edge cases: empty array, < minimum candles, NaN values

## New Entry Detectors

- [ ] Hand-crafted candle test with known pattern
- [ ] Returns null when no pattern found
- [ ] Correct side (long/short) assignment
- [ ] Reasonable confidence range (0–1)

## Feed Changes

- [ ] Error handling: timeout, 429, empty response, malformed data
- [ ] Staleness watchdog still works
- [ ] Upsert dedup still works

## Epistemic Tagging

When documenting decisions or test results, tag knowledge confidence:

| Tag | Meaning |
|---|---|
| `[CONFIRMED]` | Verified — golden test or hand-crafted test passes |
| `[ASSUMED]` | Believed true — spec reference found, not yet tested |
| `[UNCERTAIN]` | Needs research or real market validation |

Promotion: `[UNCERTAIN]` → `[ASSUMED]` (spec found) → `[CONFIRMED]` (test passes).
