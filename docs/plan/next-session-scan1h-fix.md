# Next Session Prompt — scan1hSameTF 6-Fix Implementation

Copy-paste this as the opening message of a new Claude Code session.

---

Dự án: Minh (明) — trading analysis engine, Bun/TypeScript, tại /Users/luongthebinh/Downloads/Personal/minh-agent

## Context

Evolution Phase 2. Optimizer 10-coin run xác nhận scan1hSameTF = 100% trades, holdout PF=0.17 (thua nặng). Eng review (`/plan-eng-review`) đã phân tích root cause và đồng thuận 6 fixes. Toàn bộ decisions log tại `docs/plan/decisions.md` section "Eng Review — scan1hSameTF Fix Plan (2026-04-12)".

## Task Contract

```
===== TASK CONTRACT =====
SESSION: Evolution Phase 2 — scan1hSameTF Quality Fixes
DATE: 2026-04-12
TASK: Implement 6 entry quality filters for scan1hSameTF + 18 unit tests
OPERATIONAL RISK ASSESSMENT:
  - Risk 1: Over-filtering kills all 1H signals → zero trades. Mitigation: re-run 1-trial optimizer after fixes to verify trade count > 0.
  - Risk 2: Fix breaks existing tests. Mitigation: `bun test --run` before and after.
  - Risk 3: Config constant names conflict. Mitigation: grep for name collisions before adding.
SCOPE:
  - Modify: src/strategy/strategies/smc-sd/index.ts (scan1hSameTF function, ~lines 766-920)
  - Modify: src/config.ts (add 3 constants)
  - Create/modify: test file for scan1hSameTF filter tests (18 tests)
CONSTRAINTS:
  - Pure functions only — zero I/O
  - No magic numbers — all thresholds in config.ts
  - Do NOT touch scan15mConfirm, scan5mMicroEntry, scan4hPOI, or any other scan mode
  - Do NOT change the confidence scoring model (additive stays, that's a P3 TODO)
COMPLETION CRITERIA:
  - [ ] All 6 fixes implemented
  - [ ] 18 unit tests pass
  - [ ] bun test --run passes (all existing + new)
  - [ ] Re-run optimizer 1 trial 10 coins to verify signals still fire
ESTIMATE: 12-15 exchanges / 30-40 min
==========================
```

## 6 Fixes — Exact Spec

Đọc `src/strategy/strategies/smc-sd/index.ts` function `scan1hSameTF` (khoảng line 766-920) trước khi code.

### Fix 1a+1b: Directional close on ALL bounce paths

**Bug:** Lines 838-839 (long) và 844-845 (short) — wick-entry và throughZone bounce paths thiếu `bc` check. Bearish candle tại demand zone vẫn trigger long.

**Spec:**
```
Line 838 (throughZone long):
  BEFORE: else if (proximity.throughZone && ca) { ... }
  AFTER:  else if (proximity.throughZone && ca && bc) { ... }

Line 839 (wick-entry long):
  BEFORE: else if (we && ca) isBounce = true
  AFTER:  else if (we && ca && bc) isBounce = true

Line 844 (throughZone short): add `&& bc` (bearish close check)
Line 845 (wick-entry short): add `&& bc` (bearish close check)
```

`bc` đã được define: long → `candle.c > candle.o`, short → `candle.c < candle.o`. Xem displacement branch (line 837) để thấy pattern đúng.

### Fix 2: BOS confidence penalty

**Spec:** Sau line 856 (confidence = base), thêm:
```ts
if (recentBreak.kind === 'bos') confidence -= SMC_1H_BOS_PENALTY
```

Giữ nguyên CHoCH bonus +0.10 ở line 857. Tổng effect: CHoCH = base + 0.10, BOS = base - 0.15.

Config: `export const SMC_1H_BOS_PENALTY = 0.15`

### Fix 3: Hard-block HTF opposed BOS

**Spec:** Sau HTF alignment block (sau line 787), thêm:
```ts
if (htfOpposed && recentBreak.kind === 'bos') return null
```

CHoCH counter-trend vẫn được phép (nó IS a reversal signal). Chỉ block BOS counter-trend.

### Fix 4: Minimum volume floor

**Spec:** Sau ATR computation (~line 769), compute volume early:
```ts
const volRatio = volumeRatio(candles, idx, 20)
if (!isNaN(volRatio) && volRatio < SMC_1H_MIN_VOLUME_RATIO) return null
```

Xóa dòng `const volRatio = volumeRatio(candles, idx, 20)` cũ ở ~line 872 (DRY — reuse biến đã compute).

Config: `export const SMC_1H_MIN_VOLUME_RATIO = 0.7`

### Fix 5: ADX threshold 18→20

**Spec:** Line 852:
```
BEFORE: if (!isNaN(adxVal) && adxVal < 18) return null
AFTER:  if (!isNaN(adxVal) && adxVal < SMC_1H_MIN_ADX) return null
```

Config: `export const SMC_1H_MIN_ADX = 20`

### Config constants tổng hợp (thêm vào src/config.ts)

```ts
// scan1hSameTF quality filters (Eng Review 2026-04-12)
export const SMC_1H_BOS_PENALTY = 0.15
export const SMC_1H_MIN_VOLUME_RATIO = 0.7
export const SMC_1H_MIN_ADX = 20
```

## 18 Unit Tests

Test file: thêm vào test file hiện tại hoặc tạo `test/strategy/smc-sd-1h-filters.test.ts`.

Mỗi test cần hand-craft candle fixtures với known values. Pattern: tạo candles array đủ dài (>= 50 cho detectRegime), set giá trị cụ thể cho candle cuối để trigger/reject filter.

| # | Test | Assertion |
|---|------|-----------|
| 1 | Long bounce: bullish candle at demand zone | signal !== null |
| 2 | Long bounce: bearish candle at demand zone | signal === null (Fix 1a) |
| 3 | Short bounce: bearish candle at supply zone | signal !== null |
| 4 | Short bounce: bullish candle at supply zone | signal === null (Fix 1a) |
| 5 | Long throughZone: bullish close | signal !== null |
| 6 | Long throughZone: bearish close | signal === null (Fix 1b) |
| 7 | Short throughZone: bearish close | signal !== null |
| 8 | Short throughZone: bullish close | signal === null (Fix 1b) |
| 9 | BOS entry: confidence = base - 0.15 | signal.confidence check |
| 10 | CHoCH entry: confidence = base (no penalty) | signal.confidence check |
| 11 | BOS + low base → below MIN_CONFIDENCE | signal === null (Fix 2) |
| 12 | htfOpposed + BOS | signal === null (Fix 3) |
| 13 | htfOpposed + CHoCH | signal !== null (Fix 3) |
| 14 | htfAligned + BOS | signal !== null (no block) |
| 15 | No HTF context + BOS | signal !== null (graceful) |
| 16 | Volume ratio < 0.7 | signal === null (Fix 4) |
| 17 | Volume ratio = 0.8 (above floor) | signal !== null |
| 18 | ADX = 19 (below 20) | signal === null (Fix 5) |

## Verification sau code

1. `bun test --run` — all tests pass
2. Re-run 1-trial 10-coin optimizer: `bun run src/backtest/optimize.ts 1 BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM`
3. Check output: trades > 0 (fixes didn't kill all signals), note new holdout PF
4. Nếu holdout PF < 1.1 với 40+ trades → hard stop, pivot to drilldown debug (TODOS.md P2)

## Checkpoint commits

- Trước khi code: `chore: checkpoint before scan1hSameTF fixes`
- Sau khi done: `feat(strategy): add 6 entry quality filters to scan1hSameTF`

Ngôn ngữ chat: Tiếng Việt. Docs/code/commit: English.
