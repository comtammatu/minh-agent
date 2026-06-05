# .claude/ — Canonical AI Agent System for Minh (明)

This tree + CLAUDE.md + AGENTS.md is the single source for how AI agents (Cursor Cloud, Claude Code, future) work on the project.

## Quick Map
- `CLAUDE.md` (root): trading domain SSOT (invariants, layout, pure/I/O, gates, commands). All agents read first.
- `AGENTS.md`: thin router to CLAUDE.md (for Codex/Cursor entry points).
- `.claude/memory.md`: rolling project state snapshot (update on significant change).
- `.claude/rules/`: **domain rules only** (path-scoped, trading). Never put env-specific here.
  - session-protocol.md (workflow)
  - quality-gates.md (now aligned to test:run + lint + typecheck)
  - indicators.md, strategy.md, feed.md, exchange-gotchas.md, invalidation-table.md
- `.claude/environment/`: **execution environment docs** (this is the "correct Architecture and AI Agent System Structure").
  - `cursor-cloud.md`: THIS env (Shell/StrReplace/Task/TodoWrite/CreatePlan/ManagePullRequest/SwitchMode/SetActiveBranch/MCP, cursor/*-f5ce + draft PRs, git discipline, no worktree teams, secrets, skills, modes).
  - (future) claude-code.md for Agent Teams / gstack / worktree if needed.
- `.claude/workflow/`: (optional split) session-protocol, task-contract template, quality (some kept in rules for historical).
- `.claude/agents/`: **role playbooks** (not literal tool manifests).
  - `orchestrator.md` (was session-lead): single agent + Todo + PRs + Task subagents.
  - `implementer.md` (was coder): Read/StrReplace/Shell, read-before-edit, pure boundaries.
  - `reviewer.md` (was code-reviewer): read-only checklist (CRITICAL→LOW), apply via Shell(git diff) + manual or Task subagent_type=code-reviewer.
  - `test-writer.md`: Bun tests, golden, after API stable.
- `.claude/settings.json`: kept for Claude Code Agent Teams flag (tag as claude-code-only).

## How to Use (Cursor Cloud Agent)
1. Read CLAUDE.md + this README + environment/cursor-cloud.md .
2. Follow cloud rules: branch cursor/<name>-f5ce, commit+push per iteration, draft PR via ManagePullRequest at end of every turn with changes, use SetActiveBranch, TodoWrite for the plan todos.
3. For sub work: use Task tool with subagent_type (generalPurpose/explore/coder/test-writer/code-reviewer/ai-architect etc — map to .claude/agents/* playbooks).
4. Verification: `bun run test:run`, typecheck, `bench:pipeline:ci` if strategy, reviewer.md checklist (via Shell + Read of diff).
5. Task Contract for >=3 step (mini in docs/plan/ or this tree).
6. Never edit plan.md ; update todo statuses via TodoWrite only.

## Cursor Native (optional .cursor/)
- `.cursor/rules/minh-trading.mdc` : pointer to CLAUDE + .claude/rules/*
- `.cursor/skills/minh-review/SKILL.md` : port of reviewer.md + pure boundary + HL gotchas (for Cursor skill invocation).

## Historical Note
Pre-2026-06 agent defs targeted Claude Code + gstack (Agent/TeamCreate/SendMessage/Bash/Edit/Skill, worktrees, /review slash). This restructure makes .claude/ accurate for Cursor Cloud while preserving domain rules.

See task-contract-arch-ai-agents-refactor-2026-06-04.md for the effort that delivered this structure.