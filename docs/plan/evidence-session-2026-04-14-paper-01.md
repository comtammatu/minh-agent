# Evidence Capture

Date: 2026-04-14
Operator: Codex
Exchange: Bybit
Mode: PAPER
Universe: dynamic top coins
Session ID: paper-2026-04-14-01

## Session Summary

- Start time: 2026-04-14 06:29 ICT
- End time: 2026-04-14 06:30 ICT
- Strategy set: `smc-sd`
- Size policy: paper only, no live orders
- Session verdict: startup and short-run paper session passed
- Promotion impact: evidence only, no change to release gate

## Startup Evidence

- `ARMED` observed: not captured verbatim in the short console excerpt, but startup completed into live TUI dashboard state
- exchange bootstrap succeeded: yes
- unexpected live positions: none observed in the short paper session
- TUI / Telegram / exchange matched in first 5 minutes: TUI only verified in this run; Telegram and exchange UI were not manually cross-checked in this session

Observed startup facts:

- process started explicitly with `PAPER_TRADE=true`
- startup banner showed `Minh (明) v2.0.0 — Autonomous Trading Agent [PAPER]`
- DB migrations completed with `All migrations up to date`
- coin selection completed with `COINS | 80 coins selected (80 native + 0 HIP-3)`
- TUI reached steady dashboard state with:
  - mode `PAPER`
  - `80 coins`
  - `11 active`
  - core health `ok`
  - no manual operator actions yet

## Incident Notes

- Category: none
- Severity: none
- Trigger: n/a
- Impact: n/a
- Operator response: n/a
- Final state: stable short paper run, then controlled shutdown

## Restart Drill

- Result: partial pass
- Counted toward unattended gate: no
- Ownership ambiguity: none observed
- Manual rescue needed: no

Notes:

- A second paper startup was run immediately after the first shutdown.
- Second startup again entered `PAPER` mode, ran migrations cleanly, selected 80 coins, and resumed startup/backfill normally.
- This is useful evidence for repeated startup, but it was not a restart-with-open-exposure drill, so it does not count toward unattended-live gate.

## Shutdown Drill

- Result: pass for process cleanup
- Counted toward unattended gate: no
- Residual exposure: none expected in paper mode
- Manual rescue needed: no

Notes:

- Both paper runs were terminated intentionally with `SIGINT`.
- Both `bun run src/index.ts` processes were confirmed stopped after shutdown.

## Review

- What stayed consistent:
  - paper mode override worked as intended
  - startup repeatedly completed into TUI/dashboard state
  - no immediate health degradation was visible
  - no manual operator actions were triggered
- What drifted:
  - not enough session duration to validate Telegram, exchange UI parity, or recovery under open exposure
- Root cause or hypothesis:
  - ops path for paper startup is healthy enough to begin collecting evidence, but current evidence is still limited to short startup/shutdown behavior
- Next action:
  - run a longer paper session with Telegram cross-check
  - run a deliberate restart drill while paper positions are open
  - only then consider a tiny supervised-live session with the operator sheet
