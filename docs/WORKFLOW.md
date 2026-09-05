# Workflow — Minh (明) Greenfield

## Local loop

```text
docker-compose up -d          # TimescaleDB
cp .env.example .env          # EXECUTION_MODE=paper, ACTIVE_EXCHANGE=HL
bun install
bun run start                 # OR: bun run dev
# → Ink TUI (Body) in terminal
# → Telegram Voice if TELEGRAM_* set
```

No browser dashboard.

### Safe defaults

| Knob | Safe value |
|---|---|
| `EXECUTION_MODE` | `paper` |
| `ACTIVE_EXCHANGE` | `HL` (or `BB`) |
| `ADVISOR_MODE` | `shadow` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional; Voice disabled if unset |

## Operator

| Surface | Use |
|---|---|
| Ink TUI | Local monitor (Body) |
| Telegram | Remote Case cards + confirm control (Voice) |

## Checks

```bash
bun run test:run
bun run typecheck
```

## Docs

[ARCHITECTURE.md](ARCHITECTURE.md) · [FEATURES.md](FEATURES.md) · [exchanges/HL.md](exchanges/HL.md) · [exchanges/BB.md](exchanges/BB.md)
