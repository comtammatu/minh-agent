# Supervised Live Runbook

Date: 2026-04-14

This runbook is the operator quickstart for the first tiny-size supervised live sessions.

## 1. Before Starting

- confirm `bun run typecheck` passes
- confirm `bun test --run` passes
- make sure API keys and exchange mode are intentional
- confirm no unexpected live positions exist
- read the operator sheet before starting

Operator sheet:

- [Supervised Live Operator Sheet](./supervised-live-operator-sheet.md)

## 2. Start

```bash
bun run src/index.ts
```

Wait for:

- `ARMED`
- exchange bootstrap success
- balance printed
- tracked positions visible

If startup shows an unexpected live position, stop and inspect before continuing.

## 3. Run The Session

- keep the universe narrow
- keep size tiny
- do not widen scope mid-session
- do not switch mode mid-session
- check `TUI`, Telegram, and exchange together after every restart

Useful commands:

- `/status`
- `/positions`
- `/risk`
- `/trace`
- `/operator`

## 4. Stop Conditions

Stop or pause entries if:

- reconciliation keeps failing
- sync blindness pause repeats
- ownership is ambiguous after restart
- circuit breaker trips repeatedly
- exchange and bot state disagree

## 5. Evidence And Review

Record one block per session:

- [Evidence Capture Template](./evidence-capture-template.md)

At session end, review:

- startup quality
- incident count
- restart quality
- shutdown quality
- operator consistency across channels

If the session needed repeated manual rescue, do not promote it.
