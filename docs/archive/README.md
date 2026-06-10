# Archive

This directory holds documentation that is still useful for rationale, experiments, or historical context, but is no longer the source of truth for the live branch.

## Contents

- `plan/` — sprint plans, decision logs, and superseded implementation roadmaps
- `spec/` — older architecture and future-system design docs
- `ref/` — reference material captured during earlier design passes
- `external/` — pointers for vendor or external documentation snapshots; large generated copies are fetched on demand
- `oracle-data/` — summarized static-analysis history from earlier codebase mapping; raw generated JSON is not tracked

## Usage

- Prefer the root docs (`README.md`, `SETUP.md`, `docs/*.md`) for current runtime behavior.
- Use this archive when you need rationale, migration history, or old implementation assumptions.
- Verify anything here against the current filesystem before treating it as implemented.
