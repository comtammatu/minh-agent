===== TASK CONTRACT =====
SESSION: #ARCH-0 (Root for multi-session refactor)
DATE: 2026-06-04
TASK: Rebuild, Refactor our project, clean-up and setup correct Architecture and AI Agent System Structure (implement the attached plan /opt/cursor/artifacts/plans/arch_ai_agents_refactor_973d5cce.plan.md in full, without editing the plan file itself).

OPERATIONAL RISK ASSESSMENT:
  - Risk 1: Large scope across docs + code + meta (.claude/) could introduce drift or break tests if not gated strictly by `bun run test:run` after every logical change. Mitigation: per-session mini Task Contracts, commit+push+PR update each iteration, full gates before marking any todo complete. Never touch execution/feed/agent money paths without contract tests (per existing P1 in TODOS).
  - Risk 2: The AI agent system restructure changes how future cloud agents (and this one) operate — if .claude/ becomes inaccurate or duplicated, agents will drift again. Mitigation: keep domain rules pure in .claude/rules/, isolate env-specific to environment/cursor-cloud.md; make AGENTS.md/CLAUDE.md point correctly; validate self-consistency by having the "reviewer" playbook applied to the meta changes themselves.
  - Risk 3: Doc sync vs DESIGN aspirational content — choosing wrong (sync down vs implement up) could waste effort or leave lying docs. Mitigation: explicit decision gate in doc-sync-reality phase (owner to answer the 2 questions in plan); default to "make honest + tag targets" unless owner directs full dashboard rebuild. Challenge: plan's phase 2 explicitly calls out needing owner input before phase 2/5.
  - Hard questions asked (per protocol):
    Q1: Is full DESIGN dashboard (auth/SSE/Zustand/panels) in scope here, or defer? (See open decisions in plan.)
    Q2: Include advisor skeleton + memory wiring now (requires secrets + AI SDK), or limit to tests + meta structure + note in TODOS?
    Q3: Since previous May cleanup was only partial, why not smaller targeted PRs? Answer: this effort is the vehicle to finish S2-S6 + AI structure in one tracked plan with cloud PR discipline.

SCOPE:
  - Follow exactly the 7 phases and 10 todos listed in the plan file (do not edit plan).
  - All changes via cursor/refactor-arch-ai-agents-f5ce branch.
  - Create root Task Contract (this file) + per-session mini contracts as needed.
  - Update statuses in plan's todo list via TodoWrite tool only (not edit plan file).
  - Every >=3 step subtask follows session-protocol: checkpoint, Task Contract (mini), build, verify (test:run + typecheck + reviewer.md checklist), commit.
  - Git: always commit+push per iteration; use ManagePullRequest for draft PR at end of every turn with changes; branch naming per rules.
  - No changes to live trading invariants, pure layers, or execution without explicit justification + tests.
  - Final: all 10 todos complete, DoD met, draft PR updated.

CONSTRAINTS:
  - `bun run test:run` MUST pass before marking any task/todo complete (per CLAUDE.md and quality gates).
  - TypeScript strict, no `any` without justified comment, no magic numbers (config.ts only).
  - Pure functions in indicators/strategy: zero I/O.
  - Cloud agent rules: cursor/*-f5ce, draft PRs, SetActiveBranch, no force push, use Shell for git, etc.
  - Do NOT edit the plan file itself.
  - Follow commit format: <type>(<scope>): <description>
  - For AI part: make .claude/ the canonical that matches BOTH trading domain + this Cursor Cloud execution env (tools: Shell/StrReplace/Task/TodoWrite/CreatePlan/ManagePullRequest/SwitchMode/etc., no worktree teams here).
  - Owner "approval" for this root contract is implicit in the user query directing to implement the attached plan; individual phases will note if further input needed on open decisions.

COMPLETION CRITERIA:
  - [ ] All 10 todos in plan marked completed via TodoWrite.
  - [ ] Branch created, root Task Contract written (this file), checkpointed.
  - [ ] Doc reality sync complete (no false claims about Elysia/SSE/memory/advisor; DESIGN vs current reconciled with explicit tags or follow-on plan).
  - [ ] May cleanup S2-S5 + memory tests (S6c) DONE.
  - [ ] .claude/ restructured with environment/cursor-cloud.md + updated agents/playbooks + workflow alignment to real tools/gates + optional .cursor/.
  - [ ] `bun run test:run` + typecheck + (if touched) bench:pipeline:ci pass at end.
  - [ ] Lint/deadcode tooling added and clean (or justified).
  - [ ] Telegram files <600 LOC.
  - [ ] Draft PR created/updated at every change turn; final PR body refs this contract + plan.
  - [ ] .claude/memory.md + TODOS.md + docs/plan/decisions.md updated with 2026-06 state.
  - [ ] No secrets, boundaries held, Task Contracts followed.
  - [ ] If advisor wiring scoped: advisor/ exists, memory wired safely, tests pass, secrets via Cursor dashboard only.
  - [ ] Open scope decisions answered (or explicitly deferred with notes).

ESTIMATE: 8-15 focused sessions (plan says 6-12) / multi-day part time work across cloud agent runs. Per phase estimates in plan.
==========================

## Mini Task Contract for this prep micro-session (ARCH-0a)
SESSION: #ARCH-0a
DATE: 2026-06-04
TASK: Execute prep-branch-contract todo: create branch, read key docs (listed), write this root Task Contract file, checkpoint commit + push + initial draft PR.
OPERATIONAL RISK: Low (doc + branch only, no code behavior change).
SCOPE: Branch, reads (Read tool), Write for contract file, Shell for git, SetActiveBranch, ManagePullRequest, TodoWrite updates. No plan edit.
CONSTRAINTS: Same as root + cloud rules.
COMPLETION CRITERIA:
  - [ ] Branch active.
  - [ ] Key docs re-read via tools.
  - [ ] This contract file created + committed.
  - [ ] SetActiveBranch called.
  - [ ] Push done.
  - [ ] Draft PR created (will update in turns).
  - [ ] prep todo marked complete, next marked in_progress.
  - [ ] `bun run test:run` not needed (no change) but typecheck harmless.
ESTIMATE: 30-45 min.
==========================

## 3 Hard Questions Challenged During Planning (before code)
1. Why bundle doc sync + cleanup + AI restructure + possible advisor in one plan? Risk of scope creep / stalled PR. -> Mitigated by explicit phased todos, "stop if >2x estimate", separate commits/PR updates per iteration, out-of-scope noted in TODOS not done here.
2. Re-structuring .claude/ for Cursor Cloud — will it break existing Claude Code / gstack users? -> Yes potentially; solution: tag Claude-Code specific (settings, old template), keep domain rules unchanged, add environment/ docs so both envs have clear path. .claude/README.md explains.
3. Is "owner approve before next" blocking? -> User query explicitly says "Implement the plan as specified", so treat as approval to start; document any decision gates that still need human input (the 2 open questions).

All work will preserve runtime invariants listed in CLAUDE.md. This contract is committed alongside changes.

## Mini Task Contract for s2-move-script (S2)
SESSION: #ARCH-2 / S2
DATE: 2026-06-04
TASK: Move src/compare-exchanges.ts → scripts/compare-exchanges.ts (per May refactor-cleanup S2). Update internal relative imports (to ../src/...), update usage docs in file header. Verify: typecheck, `bun run scripts/compare-exchanges.ts` (smoke), full test:run. Commit: chore(scripts): move compare-exchanges out of src (S2). Update PR.
OPERATIONAL RISK ASSESSMENT:
  - Risk 1: Relative imports break after mv → typecheck + manual run will catch; fix in same session.
  - Risk 2: Some doc in active tree references old path → we grepped, only self + archive/plan (leave archive historical). Update self header.
  - Risk 3: Low blast — one-shot script, not imported by runtime (per plan audit).
  - Challenge from protocol: "ask 3 hard questions" — is moving script worth a full session? Yes, to complete documented cleanup and keep src/ only for runtime modules (per CLAUDE layout).
SCOPE:
  - Use `git mv` for history.
  - Read file first.
  - StrReplace imports + header comments.
  - No change to package.json (no script entry for it).
  - After move: `bun run typecheck`, smoke run of script (may need --coins to avoid long run; or just --help if parses), `bun run test:run`.
  - Update todo, commit, push, PR.
  - Mark complete only after gates.
CONSTRAINTS: root + no plan edit + test:run pass.
COMPLETION CRITERIA:
  - [ ] git mv done; old path gone from src/ (git grep "compare-exchanges" src/ returns nothing in active).
  - [ ] Imports fixed (../src/feed etc).
  - [ ] Header usage updated to scripts/.
  - [ ] `bun run typecheck` passes.
  - [ ] Script runnable via bun run scripts/compare-exchanges.ts (smoke, e.g. with limited flags).
  - [ ] test:run passes (no regression from move).
  - [ ] Commit + push + PR update.
  - [ ] s2 todo complete; s3 in_progress.
ESTIMATE: 20-30 min.
==========================

## Mini Task Contract for s3-add-lint-tools (S3)
SESSION: #ARCH-3 / S3
DATE: 2026-06-04
TASK: Add Biome (lint) + Knip (deadcode) per May cleanup S3. Permissive config (no any w/o comment, no unused). Add scripts to package.json. Update CLAUDE/CONTRIBUTING/quality-gates. Run baselines, record counts (no fixes). Verify test:run. Commit as needed.
OPERATIONAL RISK: Medium per plan — Biome may surface hundreds; keep S3 to "add + baseline", triage in S4. Risk of style conflict low with permissive preset.
SCOPE:
  - bun add -d @biomejs/biome knip
  - bunx @biomejs/biome init  (or equivalent non-interactive)
  - Edit biome.json : include recommended, add rules for any/ unused (permissive: warn or info).
  - knip.json or default.
  - package.json scripts + "lint:ci" etc if needed.
  - Update 3+ docs.
  - bun run lint ; bun run deadcode ; record output.
  - test:run pass.
  - Commit: chore(lint): add biome + knip + baseline scripts (S3)
CONSTRAINTS: no auto-fix in S3; test:run always; update only listed.
COMPLETION: scripts work, baselines recorded in commit or PR note, tests pass, todo complete.
ESTIMATE: 25-40 min.
==========================

## Mini Task Contract for doc-sync-reality phase (ARCH-1 / S1 extended)
SESSION: #ARCH-1
DATE: 2026-06-04
TASK: Batch doc sync for drift (README, CODEBASE_MAP, CLAUDE, .claude/*, src comments re Elysia/SSE/memory-present). Update DESIGN + design/ subdocs with explicit 'current vs target' notes (pending owner decision on full aspirational vs honest-current). Fix provenance links. Run `bun run test:run` (expect no-op pass). Per todo: doc-sync-reality.
OPERATIONAL RISK ASSESSMENT:
  - Risk 1: Incorrect sync could make docs worse or hide needed work. Mitigation: use precise StrReplace after full Read; cross-check with Grep post-edit; keep changes minimal (fix lies, add tags for aspirational parts); no behavior change.
  - Risk 2: DESIGN decision deferred — docs will note "pending owner input per task contract open Q1". If owner later chooses full rebuild, this work is still net positive (removes lies).
  - Risk 3: Stale claims in archive/ are ok to leave (historical), focus edits on active docs + code comments + .claude/ that agents read.
  - Challenge: survey showed many places claim "Elysia SSE" and "memory does not ship" — must eradicate false claims before AI agent work, else agents will be misled.
SCOPE:
  - Files (active only): README.md, docs/CODEBASE_MAP.md, docs/DESIGN.md, docs/design/01-system-design.md, docs/design/05-ui-layout.md, docs/design/07-api-contracts.md, .claude/rules/session-protocol.md, .claude/memory.md, .claude/agents/*.md (if stale), CLAUDE.md (minor), src/agent/close-all.ts, src/db/connection.ts, src/server/index.ts (comments).
  - Do not touch archive/plan/sprint-*.md except perhaps add banner note if critical.
  - Use Read before every StrReplace.
  - After edits: Grep to verify no remaining false claims on key strings.
  - Run `bun run test:run` at end (docs change, should pass).
  - Commit: docs(plan): sync reality on Elysia/SSE/memory claims + DESIGN target notes (ARCH-1)
  - Update PR body with progress.
  - Mark this todo complete only after gates + commit + push + PR update.
CONSTRAINTS:
  - Same root + `bun run test:run` passes (will).
  - No plan.md edit.
  - For DESIGN: add clear "Current implementation (2026-06): ..." vs "Target per DESIGN (pending decision): ..."; do not delete aspirational content.
  - Update .claude/memory.md date to 2026-06-04.
COMPLETION CRITERIA:
  - [ ] All listed active files edited with precise fixes.
  - [ ] `git grep -i "elysia" -- '*.md' '*.ts' | grep -v archive` shows only historical or correct (Bun.serve comments).
  - [ ] `git grep "does not.*memory\|memory.*not.*ship\|not yet contain.*memory" -- '*.md' | grep -v archive` empty for active.
  - [ ] DESIGN.md and design/ have 2026-06 notes + open decision ref.
  - [ ] Provenance .claude/projects links removed or noted missing.
  - [ ] `bun run test:run` passes.
  - [ ] Commit + push done.
  - [ ] PR updated.
  - [ ] Todo marked complete, next (s2) in_progress.
ESTIMATE: 60-90 min (multiple reads/edits + verify + gates).
==========================