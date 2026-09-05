# Pattern Invalidation Rules

Single live pattern type: **`minh`**. Thresholds live in `PATTERN_TTL_BARS` (`src/config.ts`). Logic: `src/strategy/shared/invalidation.ts`.

| Pattern | TTL (bars) | Invalidation Condition |
|---------|------------|------------------------|
| minh | 12 | Close beyond zone boundary ± 0.5× ATR buffer (`zone-broken`), or TTL expiry |

Do not reintroduce multi-pattern TTL rows unless a new `PatternType` ships in `src/types.ts` and `PATTERN_TTL_BARS` in the same change.
