# Supervised Live Operator Sheet

Date: 2026-04-14

Use this sheet for paper and tiny-size supervised live sessions. If you need more detail, use the runbook and evidence template linked below.

## 1. Start Only If

- `bun run typecheck` passes
- `bun test --run` passes
- API keys, wallet, and exchange mode are intentional
- No unexpected live positions exist
- You are available for the whole session
- You accept that validation is still the main risk

## 2. Start Sequence

```bash
bun run src/index.ts
```

Wait for:

- `ARMED`
- exchange bootstrap success
- balance printed
- tracked positions visible and sensible

If startup shows unexpected live positions, stop and investigate before doing anything else.

## 3. During Session

- Keep size tiny
- Keep universe narrow
- Do not change mode mid-session
- Treat every recovery or reconciliation warning as evidence to record
- Check `TUI`, Telegram, and exchange UI together after startup and after every restart

Useful commands:

- `/status`
- `/positions`
- `/risk`
- `/trace`
- `/operator`

## 4. Stop Now If

- reconciliation keeps failing
- sync blindness pause fires repeatedly
- ownership is ambiguous after restart
- circuit breaker trips repeatedly
- exchange UI and bot state disagree
- you need repeated manual rescue

## 5. Evidence To Capture

- session header
- startup check
- incident notes
- restart drill result
- shutdown drill result
- final session verdict

Use the template here:

- [Evidence Capture Template](./evidence-capture-template.md)

## 6. Promote Only If

- startup, restart, and shutdown are clean
- operator, Telegram, TUI, and exchange stay consistent
- evidence shows no repeated manual rescue
- validation remains on the narrowest supported universe

## 7. References

- [Supervised Live Runbook](./supervised-live-runbook.md)
- [Go-Live Checklist](./go-live-checklist.md)
- [Unattended Live Release Gate](./unattended-live-release-gate.md)
