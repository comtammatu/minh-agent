# Session Prompt Template — Minh (明)

Copy template bên dưới, thay các placeholder `{{...}}`, paste vào Claude Code để bắt đầu session.

---

## Template

```
Bạn là lead agent cho dự án Minh (明) — Trading Analysis Engine.
Sử dụng Agent Teams để song song hóa công việc.

## Bối cảnh
- Sprint: {{SPRINT_NUMBER}} ({{SPRINT_NAME}})
- Sprint plan: `docs/plan/sprint-{{SPRINT_NUMBER}}.md`
- Session trước: {{PREV_SESSION}} — {{PREV_STATUS}}
- Session này: **{{SESSION_ID}} — {{SESSION_TITLE}}**

## Session Protocol (bắt buộc)
1. Đọc sprint plan + `CLAUDE.md` + `.claude/rules/session-protocol.md`
2. `git status` → checkpoint commit nếu có uncommitted changes
3. Viết Task Contract → tôi approve → rồi mới code
4. Chat tiếng Việt, code/docs/commits tiếng Anh

## Scope (từ sprint plan)
{{SCOPE_BULLETS}}

## Files
{{FILE_LIST}}

## Agent Teams Plan

Phân tích scope ở trên và tạo team `s{{SESSION_NUM}}-{{SHORT_NAME}}`:

### Nguyên tắc chia agent:
- Files independent nhau → agents song song, mỗi agent chạy trong worktree riêng
- Files phụ thuộc nhau → cùng 1 agent hoặc chạy sequential
- Tests → agent riêng, chạy SAU KHI API signatures finalized
- Lead (bạn) → merge results, `bun test --run`, `/review`, commit

### Agent types có sẵn:
- `coder` — implement features (Read/Write/Edit/Bash/Glob/Grep)
- `test-writer` — viết + update tests (Read/Write/Edit/Bash/Glob/Grep)

### Workflow:
1. Spawn agents song song cho independent work (dùng `isolation: "worktree"`)
2. Đợi tất cả done → merge changes vào main worktree
3. `bun test --run` → fix nếu fail (max 3 attempts)
4. `/review` → fix issues
5. Checkpoint commit: `{{COMMIT_TYPE}}({{COMMIT_SCOPE}}): {{COMMIT_DESC}}`
6. Update sprint plan Session Progress → mark DONE + date + test count
7. Cập nhật memory (xem phần Close bên dưới)

## Close (BẮT BUỘC sau mỗi session)
Sau khi commit xong, PHẢI làm 3 việc:
1. **Update sprint plan** (`docs/plan/sprint-{{SPRINT_NUMBER}}.md`): đánh dấu session DONE + date + notes trong Session Progress table
2. **Update memory** (`~/.claude/projects/.../memory/sprint3_plan.md`): cập nhật phase status, test count mới, session nào DONE, session tiếp theo là gì
3. **Commit docs**: `chore(plan): update sprint progress after {{SESSION_ID}}`

## Constraints
- CLAUDE.md: strict TS, no `any`, no magic numbers, pure functions in scanner/indicators
- `bun test --run` PHẢI pass ({{CURRENT_TEST_COUNT}}+ tests)
- Error recovery: 3 attempts max → revert to checkpoint → end session
```

---

## Ví dụ đã điền (S2)

```
Bạn là lead agent cho dự án Minh (明) — Trading Analysis Engine.
Sử dụng Agent Teams để song song hóa công việc.

## Bối cảnh
- Sprint: 4.5 (ISOLATE — Multi-Strategy Architecture)
- Sprint plan: `docs/plan/sprint-4.5.md`
- Session trước: S1 — DONE (IStrategy + Registry + adapters + 35 tests)
- Session này: **S2 — Pipeline Refactor (Remove Global State)**

## Session Protocol (bắt buộc)
1. Đọc sprint plan + `CLAUDE.md` + `.claude/rules/session-protocol.md`
2. `git status` → checkpoint commit nếu có uncommitted changes
3. Viết Task Contract → tôi approve → rồi mới code
4. Chat tiếng Việt, code/docs/commits tiếng Anh

## Scope (từ sprint plan)
- Remove globals: xóa `activeStrategy`, `setStrategy()`, `getStrategy()`
- Fan-out dispatch: `onCandleTick` → `registry.runAll()`
- Setup key: `activeSetups` keyed by `strategyId:coin|tf|type`
- Invalidation: `setupId()` includes strategyId
- Per-strategy stats: `PipelineStats` per strategy (Map)
- Tests: all existing pass + new fan-out tests

## Files
- `src/scanner/pipeline.ts` (modify, 611 lines)
- `src/scanner/invalidation.ts` (modify, 181 lines)
- `test/pipeline.test.ts` (modify, 208 lines)
- `test/invalidation.test.ts` (modify, 194 lines)

## Agent Teams Plan

Phân tích scope ở trên và tạo team `s2-pipeline-refactor`:

### Nguyên tắc chia agent:
- Files independent nhau → agents song song, mỗi agent chạy trong worktree riêng
- Files phụ thuộc nhau → cùng 1 agent hoặc chạy sequential
- Tests → agent riêng, chạy SAU KHI API signatures finalized
- Lead (bạn) → merge results, `bun test --run`, `/review`, commit

### Agent types có sẵn:
- `coder` — implement features (Read/Write/Edit/Bash/Glob/Grep)
- `test-writer` — viết + update tests (Read/Write/Edit/Bash/Glob/Grep)

### Workflow:
1. Spawn agents song song cho independent work (dùng `isolation: "worktree"`)
2. Đợi tất cả done → merge changes vào main worktree
3. `bun test --run` → fix nếu fail (max 3 attempts)
4. `/review` → fix issues
5. Checkpoint commit: `feat(scanner): remove global strategy state, fan-out dispatch (S4.5-S2)`
6. Update sprint plan Session Progress → mark DONE + date + test count
7. Cập nhật memory (xem phần Close bên dưới)

## Close (BẮT BUỘC sau mỗi session)
Sau khi commit xong, PHẢI làm 3 việc:
1. **Update sprint plan** (`docs/plan/sprint-4.5.md`): đánh dấu session DONE + date + notes trong Session Progress table
2. **Update memory** (`~/.claude/projects/.../memory/sprint3_plan.md`): cập nhật phase status, test count mới, session nào DONE, session tiếp theo là gì
3. **Commit docs**: `chore(plan): update sprint progress after S2`

## Constraints
- CLAUDE.md: strict TS, no `any`, no magic numbers, pure functions in scanner/indicators
- `bun test --run` PHẢI pass (1013+ tests)
- Error recovery: 3 attempts max → revert to checkpoint → end session
```
