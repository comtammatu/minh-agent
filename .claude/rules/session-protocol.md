# Session Protocol

## Core Rules

- **One task = one session.** Context degrades after ~45 minutes.
- **Task Contract required** for 3+ step tasks. Tasks under 3 steps: do directly.
- **Checkpoint commit** before and after every session.
- Short session + clean checkpoint beats long session with degraded output.
- Stay in scope. Discovered out-of-scope work → note it, don't do it.

---

## 1. Sprint Kickoff (once per Sprint)

Run before the first session of a new Sprint.

1. **Review previous Sprint DoD**
   - All checkboxes done? Pending items carried over?
   - Tag remaining items as `[CARRIED]` in sprint-N.md

2. **`/plan-ceo-review`** — Challenge scope
   - Is this the right priority?
   - What can we cut without losing value?
   - What's the simplest version that ships?

3. **`/plan-eng-review`** — Lock architecture
   - Data flow diagrams, edge cases, test matrices
   - Identify risky sessions, flag dependencies

4. **Update `docs/archive/plan/sprint-N.md`**
   - Finalize session roadmap (only detail next 2-3 sessions)
   - Estimate sessions + dependencies
   - Set Definition of Done checkboxes

5. **Update `docs/archive/plan/decisions.md`**
   - Log new architectural decisions with rationale

6. **Checkpoint commit**
   - `chore(plan): sprint N kickoff`

---

## 2. Session Workflow (every coding session)

### START

1. Read current sprint plan (`docs/archive/plan/sprint-N.md`) → find next session
2. Read `CLAUDE.md`
3. `git status` → clean working tree?
4. Checkpoint commit (if uncommitted work exists)
   - `chore: checkpoint before S[N]`
5. Write **Task Contract** (see template below)
   - Analyze operational risk, ask 3 hard questions
   - Owner approves scope before any code

### BUILD

6. Code according to Task Contract
   - Stay in scope — out-of-scope discovery → note in sprint plan, don't do
   - Error recovery: 2-3 attempts max per issue
   - Fail to fix? → `revert to checkpoint → end session → new session`
   - **When implementing from a spec** — keep a running `implementation-notes.md` (or `.html`) alongside the work:
     > *"Implement &lt;SPEC&gt; and while you do keep a running implementation-notes.html file (or markdown) with decisions you had to make weren't in the spec, things you had to change, tradeoffs you had to make or anything else I should know."*
     - Log: decisions not covered by the spec, deviations from the spec, tradeoffs, anything the owner should review
     - Update it as you go (not at the end) — it's a live log, not a post-hoc writeup
     - Commit it alongside the code change so the rationale stays with the diff

### VERIFY

7. `bun test --run` — ALL tests pass (previous sprints + new)
8. Quality Gates checklist (see `quality-gates.md`)
   - No `any`, no magic numbers, no secrets
   - Pure function boundary maintained
   - Category-specific gates (indicator / feed / agent / execution)
9. `/review` — code review for bugs CI won't catch
   - Fix issues found before committing
10. `/cso` — **only when touching wallet, execution, auth, or API keys**
    - Security audit for money-handling code
    - Run after Sprint 2 Phase 2B (execution endpoints)

### CLOSE

11. Checkpoint commit
    - `feat(agent): implement state machine`
    - Follow commit convention: `<type>(<scope>): <description>`
12. Update `docs/archive/plan/sprint-N.md` Session Progress table
    - Mark session DONE + date + notes
13. Update `.claude/memory.md` if significant context changed
14. **END SESSION**

---

## 3. Phase Completion (after last session of a phase)

Run when all sessions in a phase (e.g., Phase 2A) are done.

1. **Verify all phase sessions DONE** in `docs/archive/plan/sprint-N.md`
2. **`/plan-eng-review`** for the next phase
   - Re-evaluate: did building this phase change assumptions?
   - Adjust next phase session estimates if needed
3. **`/retro`** — phase retrospective
   - What worked, what didn't
   - Test health, velocity, any process improvements
4. **Commit**: `chore(plan): phase 2A complete`

---

## 4. Sprint Close (once per Sprint)

Run after the last session of the Sprint.

1. **Verify Definition of Done** — all checkboxes in `docs/archive/plan/sprint-N.md`
2. **Live verification** — run the system, confirm behavior
   - Tag `[CONFIRMED]` in docs for verified items
   - Tag `[CARRIED]` for items deferred to next Sprint
3. **`/retro`** — full sprint retrospective
   - Lessons learned → update this protocol if needed
   - Track: sessions planned vs actual, estimate accuracy
4. **`/cso`** — sprint-level security review (if execution/wallet code was added)
5. **`/document-release`** — sync all docs with reality
6. **Update `decisions.md`** session log with sprint summary
7. **Tag release**: `git tag v0.N.0` (sprint number)
8. **Plan next Sprint kickoff** — prep sprint-N+1.md draft

---

## Task Contract Template

Before generating the Task Contract, analyze operational risk. Push back, challenge the design, ask 3 hard questions. Code only after Task Contract is approved.

```
===== TASK CONTRACT =====
SESSION: #[number]
DATE: [date]
TASK: [Specific description]
OPERATIONAL RISK ASSESSMENT:
  - Risk 1: [What happens if this fails at runtime?]
  - Risk 2: [How hard is this to maintain for a solo dev?]
  - Risk 3: [Is there a simpler way without writing new code?]
SCOPE:
  - Files: [list files to create/modify]
CONSTRAINTS:
  - [Constraint 1]
COMPLETION CRITERIA:
  - [ ] [Condition 1]
  - [ ] bun test --run passes
  - [ ] /review passes
ESTIMATE: [X] exchanges / [Y] minutes
==========================
```

---

## Session Sizing Guide

| Task type | Exchanges | Duration |
|---|---|---|
| Simple bug fix / typo | 4–6 | 10–15 min |
| New indicator | 8–12 | 20–30 min |
| New scanner layer | 12–18 | 30–45 min |
| New feed integration | 10–15 | 25–40 min |
| Agent component (state machine, order mgr) | 12–18 | 30–45 min |
| Database schema + persistence layer | 10–15 | 25–40 min |
| HTTP endpoints (Elysia routes) | 8–12 | 20–30 min |
| Security-sensitive (wallet, execution) | 15–20 | 35–50 min |
| Large feature (cross-layer) | — | Split into 2–3 sessions |

---

## Error Recovery

When agent fails to fix an issue within 2–3 attempts:
```
STOP → revert to checkpoint → end session → open new session
```
Do not let the agent fix its own errors in the same session. Context is already contaminated.

---

## gstack Skills Usage Guide

### Every Session
| Skill | When | Purpose |
|---|---|---|
| `/review` | Before checkpoint commit | Find bugs CI misses |

### When Touching Sensitive Code
| Skill | When | Purpose |
|---|---|---|
| `/cso` | After wallet/execution/auth code | OWASP + STRIDE security audit |
| `/careful` | When writing DROP TABLE, rm, force-push | Prevent destructive accidents |

### Phase/Sprint Boundaries
| Skill | When | Purpose |
|---|---|---|
| `/plan-ceo-review` | Sprint kickoff | Challenge scope and priorities |
| `/plan-eng-review` | Sprint kickoff + phase transitions | Lock architecture, edge cases |
| `/retro` | Phase completion + sprint close | Retrospective, velocity tracking |
| `/document-release` | Sprint close | Sync docs with reality |

### Dashboard Development (Sprint 3D+)
| Skill | When | Purpose |
|---|---|---|
| `/qa` | After dashboard feature complete | Autonomous QA + auto-fix |
| `/browse` | During dashboard development | Visual verification |
| `/benchmark` | Before/after performance changes | Core Web Vitals |
| `/canary` | After dashboard deploy | Monitor for regressions |

---

## Workflow Summary

```
SPRINT KICKOFF
  → /plan-ceo-review → /plan-eng-review → update docs → commit
  │
  ├── SESSION 1: Task Contract → Build → Verify → /review → Commit
  ├── SESSION 2: Task Contract → Build → Verify → /review → Commit
  ├── ...
  ├── SESSION N: Task Contract → Build → Verify → /review → /cso → Commit
  │
  ├── PHASE COMPLETE: /plan-eng-review (next phase) → /retro → commit
  │
  ├── SESSION N+1: ...
  ├── ...
  │
SPRINT CLOSE
  → Verify DoD → Live test → /retro → /cso → /document-release → git tag
```
