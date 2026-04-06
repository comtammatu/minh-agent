# Session Prompt Template — Minh (明)

Copy template bên dưới, thay các placeholder `{{...}}`, paste vào Claude Code để bắt đầu session.

## Thiết kế

Template này được tối ưu cho Claude Agent Teams:
- **Ngắn gọn**: chỉ chứa context mà session-lead cần, không lặp lại nội dung đã có trong agent definitions
- **Structured data**: scope/files/constraints ở dạng dễ parse để lead phân chia cho agents
- **Workflow rõ ràng**: START → PLAN → BUILD → VERIFY → CLOSE, mỗi phase có output cụ thể
- **Agent roster**: liệt kê agent types + tool capabilities để lead quyết định team composition

### Agent definitions (đọc thêm nếu cần):
- `.claude/agents/session-lead.md` — orchestrator, merge, verify
- `.claude/agents/coder.md` — implement features (Read/Write/Edit/Bash/Glob/Grep)
- `.claude/agents/test-writer.md` — write + update tests (Read/Write/Edit/Bash/Glob/Grep)
- `.claude/agents/code-reviewer.md` — review diffs, read-only (Read/Bash/Glob/Grep)

---

## Template

```
Bạn là session-lead cho dự án Minh (明) — Trading Analysis Engine.
Dùng Agent Teams song song hóa. Chat tiếng Việt, code/docs/commits tiếng Anh.

## Context
Sprint: {{SPRINT_NUMBER}} — {{SPRINT_NAME}}
Plan: `docs/plan/sprint-{{SPRINT_NUMBER}}.md`
Previous: {{PREV_SESSION}} — {{PREV_STATUS}}
Current: **{{SESSION_ID}} — {{SESSION_TITLE}}**
Test baseline: {{CURRENT_TEST_COUNT}} tests passing

## START
1. Đọc sprint plan → tìm session {{SESSION_ID}}
2. Đọc `CLAUDE.md` + `.claude/rules/session-protocol.md`
3. `git status` → checkpoint commit nếu dirty
4. Viết Task Contract → CHỜ tôi approve → rồi mới BUILD

## Scope
{{SCOPE_BULLETS}}

## Files (chỉ modify files này)
{{FILE_LIST_WITH_LINES}}

## BUILD — Agent Teams

Sau khi Task Contract được approve:

1. **Phân tích file dependencies** từ Scope + Files ở trên
2. **Tạo team** `s{{SESSION_NUM}}-{{SHORT_NAME}}`
3. **Spawn agents** song song cho independent file groups:
   - Mỗi agent chạy `isolation: "worktree"` (tránh conflict)
   - KHÔNG assign cùng file cho 2 agents
   - `test-writer` spawn SAU KHI coder finalize API signatures
   - Target: 5-6 tasks/agent, max 3-4 agents total

### Agent roster:
| Type | Tools | Dùng khi |
|------|-------|----------|
| `coder` | Read/Write/Edit/Bash/Glob/Grep | Implement features, modify source |
| `test-writer` | Read/Write/Edit/Bash/Glob/Grep | Write/update tests sau khi API stable |
| `code-reviewer` | Read/Bash/Glob/Grep (read-only) | Review diff trước commit |

4. **Đợi agents hoàn thành** → merge worktree changes
5. **Resolve conflicts** nếu có (merge, không overwrite)

## VERIFY (lead tự làm, không delegate)
1. `bun test --run` → ALL tests pass (baseline + new)
2. Spawn `code-reviewer` agent → review toàn bộ diff
3. Fix issues từ reviewer (CRITICAL/HIGH phải fix, MEDIUM tùy)
4. Nếu test fail > 3 attempts → `git checkout .` → kết thúc session

## CLOSE (BẮT BUỘC)
1. Commit: `{{COMMIT_TYPE}}({{COMMIT_SCOPE}}): {{COMMIT_DESC}} ({{SESSION_ID}})`
2. Update sprint plan: mark {{SESSION_ID}} DONE + date + notes + test count
3. Update memory nếu context thay đổi đáng kể
4. Commit docs: `chore(plan): update sprint progress after {{SESSION_ID}}`
5. Shutdown team → TeamDelete

## Constraints
- TypeScript strict, no `any` (trừ justified comment), no magic numbers
- Pure functions: `indicators/` + `scanner/` = zero I/O
- `bun test --run` PHẢI pass
- Stay in scope — out-of-scope → note, don't do
```

---

## Ví dụ đã điền

```
Bạn là session-lead cho dự án Minh (明) — Trading Analysis Engine.
Dùng Agent Teams song song hóa. Chat tiếng Việt, code/docs/commits tiếng Anh.

## Context
Sprint: 4.5 — ISOLATE (Multi-Strategy Architecture)
Plan: `docs/plan/sprint-4.5.md`
Previous: S1 — DONE (IStrategy + Registry + adapters + 35 tests)
Current: **S2 — Pipeline Refactor (Remove Global State)**
Test baseline: 1013 tests passing

## START
1. Đọc sprint plan → tìm session S2
2. Đọc `CLAUDE.md` + `.claude/rules/session-protocol.md`
3. `git status` → checkpoint commit nếu dirty
4. Viết Task Contract → CHỜ tôi approve → rồi mới BUILD

## Scope
- Remove globals: xóa `activeStrategy`, `setStrategy()`, `getStrategy()`
- Fan-out dispatch: `onCandleTick` → `registry.runAll()`
- Setup key: `activeSetups` keyed by `strategyId:coin|tf|type`
- Invalidation: `setupId()` includes strategyId
- Per-strategy stats: `PipelineStats` per strategy (Map)

## Files (chỉ modify files này)
- `src/scanner/pipeline.ts` (611 lines)
- `src/scanner/invalidation.ts` (181 lines)
- `test/pipeline.test.ts` (208 lines)
- `test/invalidation.test.ts` (194 lines)

## BUILD — Agent Teams

Sau khi Task Contract được approve:

1. **Phân tích file dependencies** từ Scope + Files ở trên
2. **Tạo team** `s2-pipeline-refactor`
3. **Spawn agents** song song cho independent file groups:
   - Mỗi agent chạy `isolation: "worktree"` (tránh conflict)
   - KHÔNG assign cùng file cho 2 agents
   - `test-writer` spawn SAU KHI coder finalize API signatures
   - Target: 5-6 tasks/agent, max 3-4 agents total

### Agent roster:
| Type | Tools | Dùng khi |
|------|-------|----------|
| `coder` | Read/Write/Edit/Bash/Glob/Grep | Implement features, modify source |
| `test-writer` | Read/Write/Edit/Bash/Glob/Grep | Write/update tests sau khi API stable |
| `code-reviewer` | Read/Bash/Glob/Grep (read-only) | Review diff trước commit |

4. **Đợi agents hoàn thành** → merge worktree changes
5. **Resolve conflicts** nếu có (merge, không overwrite)

## VERIFY (lead tự làm, không delegate)
1. `bun test --run` → ALL tests pass (1013+ tests)
2. Spawn `code-reviewer` agent → review toàn bộ diff
3. Fix issues từ reviewer (CRITICAL/HIGH phải fix, MEDIUM tùy)
4. Nếu test fail > 3 attempts → `git checkout .` → kết thúc session

## CLOSE (BẮT BUỘC)
1. Commit: `feat(scanner): remove global strategy state, fan-out dispatch (S2)`
2. Update sprint plan: mark S2 DONE + date + notes + test count
3. Update memory nếu context thay đổi đáng kể
4. Commit docs: `chore(plan): update sprint progress after S2`
5. Shutdown team → TeamDelete

## Constraints
- TypeScript strict, no `any` (trừ justified comment), no magic numbers
- Pure functions: `indicators/` + `scanner/` = zero I/O
- `bun test --run` PHẢI pass
- Stay in scope — out-of-scope → note, don't do
```
