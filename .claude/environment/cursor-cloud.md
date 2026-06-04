# Cursor Cloud Agent Environment — Minh (明)

This is the execution environment for Cursor Cloud Agents on this repo (as of 2026-06 refactor).

## Tools (actual in this session; use these, not the old agent defs)
- File: Read, Write (new), StrReplace (edit), Delete, Glob, Grep
- Shell (tmux-backed for long; stateful; export PATH for bun etc; use for git, test, install)
- Task (for subagents; subagent_type: generalPurpose | explore | coder | test-writer | code-reviewer | session-lead | ai-architect | ... ; resume for continue; readonly for plan)
- TodoWrite (update the plan's todos; merge=true for status)
- CreatePlan (for new plans)
- ManagePullRequest (create/update draft PRs; always draft=true unless specified)
- SwitchMode (to 'agent' from ask/plan if needed)
- SetActiveBranch (after branch create or commit)
- Await (for bg Shell)
- WebSearch / WebFetch (if needed)
- MCP: GetMcpTools, FetchMcpResource, CallMcpTool (Supabase/Vercel servers available in Cursor; **this project uses direct postgres client + no vercel deploy** — use only if integrating those services)
- Git is via Shell + the cloud rules below (never assume local git config beyond the provided).

No: Agent/TeamCreate/SendMessage/TeamDelete (no worktree teams), no gstack /review (use reviewer.md + Shell), no Bash/Edit (use Shell/StrReplace).

## Branch / Git / PR Discipline (mandatory)
- Always on `main` at start of task.
- Create: `git checkout -b cursor/<descriptive-name>-f5ce` (lowercase, the suffix -f5ce).
- After branch: SetActiveBranch.
- Every iteration with changes: commit descriptive `<type>(<scope>): <desc> (session)`, `git push -u origin <branch>`.
- Before summary of turn with changes: create or update the draft PR via ManagePullRequest (body refs plan + progress + contract).
- No force push, no amend after push unless explicit, no leave branch.
- PRs default draft.
- Use gh CLI (read-only) for info if needed (gh pr view, gh run view --log).

## Modes
- Start in plan if scoping; SwitchMode to 'agent' for impl.
- Use Ask/Plan/Debug when appropriate (environment provides).

## Verification (every session close)
- `bun run test:run` (MUST pass before mark complete).
- `bun run typecheck`
- If strategy: ACTIVE_EXCHANGE=HL bun run bench:pipeline:ci
- Apply .claude/agents/reviewer.md checklist to final diff (Shell git diff + manual Read or Task subagent).
- Update .claude/memory.md + TODOS.md + docs/plan/decisions.md if significant.

## Subagents (Task tool)
- subagent_type maps to playbooks:
  - explore: .claude/agents (read-only survey)
  - coder / implementer: .claude/agents/implementer.md
  - test-writer: .claude/agents/test-writer.md
  - code-reviewer: .claude/agents/reviewer.md (read-only)
  - session-lead / orchestrator: .claude/agents/orchestrator.md (but in Cloud you are the lead)
  - generalPurpose, ai-architect etc for design.
- Use resume: <id> to continue a subagent.
- File attachments for images if review.

## MCP / Skills / Secrets
- Supabase / Vercel MCP: available; project Postgres is local `postgres://...` (docker-compose), not Supabase. Use only when task involves those platforms.
- Skills (ai-sdk, nextjs, shadcn, vercel-*, supabase etc): vendored in Cursor cache; use when building advisor/LLM or dashboard UI. For advisor foundation: prefer ai-sdk patterns per skill.
- Secrets: Cursor Dashboard > Cloud Agents > Secrets (injected as env; never commit; user/team/repo scoped).

## Vietnamese / English
- Per session-prompt-template and owner preference: chat Vietnamese, code/docs/commits English.
- CLAUDE.md is English canonical.

## Common Pitfalls (from survey)
- Stale Elysia/SSE/TanStack claims in docs — now fixed in this refactor.
- Assuming Agent Teams worktree — not in Cloud.
- Forgetting push + PR update each turn.
- Running test --run instead of test:run (dashboard vitest included).
- Editing the plan.md (forbidden; use TodoWrite on its todos).

See root task-contract for the refactor that aligned this. Update this doc when env/tools change.