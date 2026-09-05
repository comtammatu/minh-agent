# Minh (明)

Greenfield Bun trading runtime: **`minh`** strategy, HL | BB (one per process), paper/live execution, deterministic advisor, **Ink TUI (Body)** + **Telegram Voice**.

## Quick start

```bash
docker-compose up -d
cp .env.example .env   # EXECUTION_MODE=paper, ACTIVE_EXCHANGE=HL
bun install
bun run start          # Ink TUI; Telegram if TELEGRAM_* set
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/FEATURES.md](docs/FEATURES.md)
- [docs/WORKFLOW.md](docs/WORKFLOW.md)
- [docs/exchanges/](docs/exchanges/)
- [docs/presence/VOICE.md](docs/presence/VOICE.md)

## Checks

```bash
bun run test:run
bun run typecheck
```
