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
Bạn là session-lead cho dự án Minh (明) — Autonomous Trading Runtime.
Dùng Agent Teams song song hóa. Chat tiếng Việt, code/docs/commits tiếng Anh.

## Context
Sprint: {{SPRINT_NUMBER}} — {{SPRINT_NAME}}
Plan: `docs/archive/plan/sprint-{{SPRINT_NUMBER}}.md`
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
- Pure functions: `indicators/` + `strategy/` = zero I/O
- `bun test --run` PHẢI pass
- Stay in scope — out-of-scope → note, don't do
```

---

## Ví dụ đã điền

```
Bạn là session-lead cho dự án Minh (明) — Autonomous Trading Runtime.
Dùng Agent Teams song song hóa. Chat tiếng Việt, code/docs/commits tiếng Anh.

## Context
Sprint: 4.5 — CLEANUP (Canonical Single-Strategy Runtime)
Plan: `docs/archive/plan/sprint-4.5.md`
Previous: S11 — DONE (shared wallet + exchange-boundary cleanup)
Current: **S12 — Runtime + Strategy Simplification**
Test baseline: 1150 tests passing

## START
1. Đọc sprint plan → tìm session S2
2. Đọc `CLAUDE.md` + `.claude/rules/session-protocol.md`
3. `git status` → checkpoint commit nếu dirty
4. Viết Task Contract → CHỜ tôi approve → rồi mới BUILD

## Scope
- Make `src/index.ts` a thin entrypoint
- Move long-lived orchestration into `src/runtime/`
- Remove legacy registry/multi-strategy fan-out from active path
- Collapse runtime state and execution routing to one canonical strategy context
- Clean active docs and archive historical docs under `docs/archive/`

## Files (chỉ modify files này)
- `src/index.ts`
- `src/runtime/app.ts`
- `src/strategy/engine.ts`
- `src/strategy/orchestrator.ts`
- `src/agent/*`
- `docs/*.md`

## BUILD — Agent Teams

Sau khi Task Contract được approve:

1. **Phân tích file dependencies** từ Scope + Files ở trên
2. **Tạo team** `s12-single-strategy-cleanup`
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
1. `bun test --run` → ALL tests pass (1150+ tests)
2. Spawn `code-reviewer` agent → review toàn bộ diff
3. Fix issues từ reviewer (CRITICAL/HIGH phải fix, MEDIUM tùy)
4. Nếu test fail > 3 attempts → `git checkout .` → kết thúc session

## CLOSE (BẮT BUỘC)
1. Commit: `refactor(runtime): canonicalize single-strategy runtime (S12)`
2. Update sprint plan: mark S12 DONE + date + notes + test count
3. Update memory nếu context thay đổi đáng kể
4. Commit docs: `chore(plan): update sprint progress after S12`
5. Shutdown team → TeamDelete

## Constraints
- TypeScript strict, no `any` (trừ justified comment), no magic numbers
- Pure functions: `indicators/` + `strategy/` = zero I/O
- `bun test --run` PHẢI pass
- Stay in scope — out-of-scope → note, don't do
```
