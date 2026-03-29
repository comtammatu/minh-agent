# Session Protocol

## Core Rules

- **One task = one session.** Context degrades after ~45 minutes.
- **Task Contract required** for 3+ step tasks. Tasks under 3 steps: do directly.
- **Checkpoint commit** before and after every session.
- Short session + clean checkpoint beats long session with degraded output.
- Stay in scope. Discovered out-of-scope work → note it, don't do it.

## Session Boot Sequence

1. Read current sprint plan (`docs/plan/sprint-1.md` or `sprint-2.md`)
2. Read CLAUDE.md
3. Write Task Contract, confirm scope
4. Build according to plan (stay in scope)
5. Verify → Commit → END SESSION

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
ESTIMATE: [X] exchanges / [Y] minutes
==========================
```

## Session Sizing Guide

| Task type | Exchanges | Duration |
|---|---|---|
| Simple bug fix / typo | 4–6 | 10–15 min |
| New indicator | 8–12 | 20–30 min |
| New scanner layer | 12–18 | 30–45 min |
| New feed integration | 10–15 | 25–40 min |
| Large feature (cross-layer) | — | Split into 2–3 sessions |

## Error Recovery

When agent fails to fix an issue within 2–3 attempts:
```
STOP → revert to checkpoint → end session → open new session
```
Do not let the agent fix its own errors in the same session. Context is already contaminated.