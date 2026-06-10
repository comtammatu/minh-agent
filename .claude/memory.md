# Minh (明) — Session Memory

## Current state (2026-06-04; updated during arch+ai refactor)

**AI Agent System:** .claude/ restructured (environment/cursor-cloud.md, agents/ as playbooks, .cursor/ optional, protocol updated for Cloud tools). Old Claude Code Teams fiction isolated. See task-contract and .claude/README.md .

**Stack:** Bun / TypeScript. **Exchanges:** Hyperliquid + Bybit behind one exchange-service boundary. **Live runtime:** one active exchange per process, one shared wallet/account per process, one concrete `smc-sd` setup engine.

### Runtime shape

- Thin process entrypoint in `src/index.ts`; long-lived boot/reconnect/shutdown orchestration in `src/runtime/app.ts`.
- Strategy runtime collapsed to one canonical engine path in `src/strategy/engine.ts`.
- Agent / execution runtime keyed by `coin` only (no `strategyId` dimension).
- Browser dashboard (`dashboard/` + `src/server/`) is wired into the runtime alongside the TUI and Telegram surfaces.
- `src/memory/` is a trade-memory foundation (storage + scored retrieval, commit `ef441e6`). Journal `exit` events with numeric `pnl` now create `trade_outcome` memories. There is no live `src/advisor/` module on this branch.

### Docs hierarchy

- Active impl docs: repo root (`README.md`, `SETUP.md`, `TODOS.md`, `CONTRIBUTING.md`, `CLAUDE.md`) and `docs/*.md`.
- Per-topic rules: `.claude/rules/*.md` — each file is the single source for its topic, CLAUDE.md only points to them.
- Historical / superseded: `docs/archive/`.

### Research / diagnostics pointers

- `bun run scripts/backtest/run-drilldown-diag.ts [coins]`
- `bun run scripts/backtest/run-wf-universe-compare.ts [baseline] [subset]`
- `bun run src/backtest/optimize.ts [trials] [coins]`
- Historical decision log: `docs/archive/plan/decisions.md`
