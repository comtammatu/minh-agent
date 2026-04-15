# Next Session Prompt — Evolution Phase 2: Decision Point

> Archive note (2026-04-15): preserved as a historical handoff prompt from an earlier research session, not as an active session plan for the current branch.

Copy-paste this as the opening message of a new Claude Code session.

---

Dự án: Minh (明) — trading analysis engine, Bun/TypeScript, tại /Users/luongthebinh/Downloads/Personal/minh-agent

## Context

Evolution Phase 2. scan1hSameTF 6-fix implementation **DONE** (session trước, 2026-04-12):
- 6 fixes: directional close (bc), BOS penalty (-0.15), HTF opposed block, volume floor (0.7), ADX (18→20)
- 18/18 unit tests pass, 1112 total tests pass
- Config: `SMC_1H_BOS_PENALTY=0.15`, `SMC_1H_MIN_VOLUME_RATIO=0.7`, `SMC_1H_MIN_ADX=20`
- Optimizer quick-check (1-trial, 10 coins): **trades=1, PF=0.00** → 1H trade volume collapsed
- Hard stop **inconclusive** — cần ≥ 40 trades để đánh giá

Full decisions log: `docs/archive/plan/decisions.md` section "scan1hSameTF Fix Implementation Results (2026-04-12)".

## Decision Tree cho session này

### Option A: Run 200-trial optimizer (nếu tin 1H còn alpha)

```bash
bun run src/backtest/optimize.ts 200 BTC,ETH,SOL,AVAX,LINK,ARB,APT,BNB,DOT,ATOM
```

- Chạy ~86 phút (dựa trên run trước)
- **Nếu holdout PF ≥ 1.1 với ≥ 40 trades** → 1H fixes đã improve, tiếp tục tuning
- **Nếu holdout PF < 1.1 hoặc < 40 trades** → hard stop, chuyển sang Option B

### Option B: Debug drilldown cascade (P2 TODO — promoted to P1)

`TODOS.md` mô tả chi tiết. Core problem: **4H→15m→5m cascade fires ZERO times across all 200 trials**.

Approach:
1. Instrument `scan4hPOI`, `scan15mConfirm`, `scan5mMicroEntry` với counters
2. Run 1-trial 10-coin optimizer với diagnostic logging
3. Tìm bottleneck: 4H breaks quá rare? 15m window quá narrow? 5m FVG-only quá strict?
4. Fix bottleneck → re-run optimizer

Đây là path có potential cao nhất vì drilldown = 10:1-40:1 R:R (vs 1H same-TF = max 3:1).

### Option C: AMD standalone (if both A+B fail)

Tạo `scan1hAMDStandalone` — pure 1H CHoCH-only, no 4H POI gate. Test hypothesis: 4H POI gate là bottleneck, không phải 1H signal quality.

## Recommendation

**Đề xuất: Skip Option A, đi thẳng Option B (drilldown debug).** Lý do:
- 1-trial đã cho trades=1 → 200-trial unlikely cho ≥ 40 trades
- Drilldown path (4H→15m→5m) thiết kế cho R:R cao hơn nhiều
- Nếu drilldown hoạt động → thay thế hoàn toàn scan1hSameTF
- Effort: S (1-2 days) vs M (3-5 days cho AMD)

Nhưng đây là **owner's call** — cả 3 options đều valid.

## Task Contract (nếu chọn Option B)

```
===== TASK CONTRACT =====
SESSION: Evolution Phase 2 — Drilldown Cascade Debug
DATE: [today]
TASK: Instrument + diagnose why 4H→15m→5m drilldown fires zero times
OPERATIONAL RISK ASSESSMENT:
  - Risk 1: Diagnostic logging pollutes production code → use debug flag / separate run mode
  - Risk 2: Bottleneck is fundamental (4H breaks genuinely rare in data) → no code fix possible
  - Risk 3: Multiple bottlenecks compound → fix one, another blocks
SCOPE:
  - Modify: src/strategy/strategies/smc-sd/index.ts (scan4hPOI, scan15mConfirm, scan5mMicroEntry)
  - Modify: src/backtest/optimize.ts (optional diagnostic output)
  - Create: test/strategy/smc-sd-drilldown-debug.test.ts (optional, if fixture-based tests needed)
CONSTRAINTS:
  - Pure functions only — diagnostic counters returned as data, not console.log
  - Do NOT modify scan1hSameTF (its 6 fixes are locked)
  - Do NOT change confidence model (P3 TODO)
COMPLETION CRITERIA:
  - [ ] Identified which stage(s) drop to zero (4H? 15m? 5m?)
  - [ ] Quantified: how many 4H POIs registered, how many reach 15m, how many reach 5m
  - [ ] Root cause documented in decisions.md
  - [ ] bun test --run passes
  - [ ] Recommendation: fix proposal OR escalate to Option C
ESTIMATE: 10-14 exchanges / 25-35 min
==========================
```

## Files to read first

1. `CLAUDE.md` — constraints + architecture
2. `docs/archive/plan/decisions.md` — full history, search "scan1hSameTF Fix Implementation Results"
3. `src/strategy/strategies/smc-sd/index.ts` — scan4hPOI (~line 600), scan15mConfirm (~line 650), scan5mMicroEntry (~line 700)
4. `TODOS.md` — P2 drilldown cascade description
5. `src/config.ts` — thresholds for all scan modes

## Checkpoint commits

- Trước khi code: `chore: checkpoint before drilldown debug`
- Sau khi done: `feat(strategy): drilldown cascade diagnostic` hoặc `fix(strategy): unblock drilldown cascade`

Ngôn ngữ chat: Tiếng Việt. Docs/code/commit: English.
