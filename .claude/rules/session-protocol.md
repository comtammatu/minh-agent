# Session Protocol

Canonical session workflow for Minh lives in **[docs/WORKFLOW.md](../../docs/WORKFLOW.md)**.

This file remains under `.claude/rules/` so agents that path-scope to `rules/` still find it. Do not fork a second protocol here.

## Quick rules

- Task Contract for ≥ 3 steps — template in `docs/WORKFLOW.md`
- Orient on `docs/ARCHITECTURE.md` (Current vs Proposed) before inventing features
- Verify with `bun run test:run` before marking complete
- Pure boundaries: `src/indicators/` + pure `src/strategy/` helpers stay zero I/O
- Features truth: `docs/FEATURES.md` (not `docs/archive/`)
- Local loop: paper mode + `bun run start` (Ink TUI + optional Telegram)

See also: [quality-gates.md](quality-gates.md).
