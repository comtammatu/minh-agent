# .claude/ — Domain rules for Minh (明)

Lean, project-owned rules. Pipeline orientation: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

| Path | Role |
|---|---|
| `rules/` | Path-scoped domain SSOT (feed, strategy, indicators, gates, gotchas, TTLs) |
| `README.md` | This map |

Removed: Cursor Cloud / Claude Teams playbooks, session prompt templates, rolling memory dumps. Workflow → [docs/WORKFLOW.md](../docs/WORKFLOW.md). Features → [docs/FEATURES.md](../docs/FEATURES.md). Entry → [CLAUDE.md](../CLAUDE.md).

| Topic | File |
|---|---|
| Session / Task Contract | [rules/session-protocol.md](rules/session-protocol.md) → WORKFLOW |
| Quality gates | [rules/quality-gates.md](rules/quality-gates.md) |
| Pattern TTLs | [rules/invalidation-table.md](rules/invalidation-table.md) |
| Indicators | [rules/indicators.md](rules/indicators.md) |
| Strategy | [rules/strategy.md](rules/strategy.md) |
| Feed / market data | [rules/feed.md](rules/feed.md) |
| HL + Bybit gotchas | [rules/exchange-gotchas.md](rules/exchange-gotchas.md) |

Optional Cursor pointers: `.cursor/rules/minh-trading.mdc`, `.cursor/skills/minh-review/`.
