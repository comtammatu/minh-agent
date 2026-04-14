# Evidence Capture

Date: 2026-04-14
Operator: Codex
Exchange: Bybit
Mode: PAPER
Universe: dynamic top coins
Session ID: paper-2026-04-14-02

## Session Summary

- Start time: 2026-04-14 07:19 ICT
- End time: 2026-04-14 07:20 ICT
- Strategy set: `smc-sd`
- Size policy: paper only, no live orders
- Session verdict: paper runtime with actual simulated entries confirmed; restart drill attempted but restore behavior remains inconclusive
- Promotion impact: stronger paper evidence, still not enough for supervised-live promotion

## Startup Evidence

- `ARMED` observed: not captured verbatim in the excerpt, but startup completed and began trading logic normally
- exchange bootstrap succeeded: yes
- unexpected live positions: none observed
- TUI / Telegram / exchange matched in first 5 minutes: not fully checked in this run; primary evidence came from `minh.log`

Observed runtime evidence from `minh.log`:

- `MODE | PAPER TRADE — orders are SIMULATED, no real exchange calls`
- multiple simulated fills were created and tracked, including:
  - `ETH long`
  - `BTC long`
  - `NEAR long`
  - `PENGU long`
  - `LIT long`
  - `LDO long`
  - `STRK long`
  - `POPCAT long`
  - `PUMPFUN long`
  - `CL short`
- simulated SL/TP triggers were created for those positions
- `PositionMonitor` logged `Tracking position: ...`
- agents transitioned `ENTERING -> IN_POSITION`

This confirms the bot was not merely connected to feed; it was actively running the paper execution path.

## Incident Notes

- Category: none
- Severity: none
- Trigger: n/a
- Impact: n/a
- Operator response: n/a
- Final state: positions were opened in paper mode, then the process was interrupted intentionally for a restart drill

## Restart Drill

- Result: inconclusive
- Counted toward unattended gate: no
- Ownership ambiguity: none logged explicitly
- Manual rescue needed: no

What happened:

- a paper session was allowed to open multiple simulated positions
- the process was stopped with `SIGINT`
- the bot was started again immediately in `PAPER` mode
- the restart itself succeeded and the bot resumed scanning / entering new paper positions

What was not confirmed:

- no fresh `Restored ... open position(s) into PositionMonitor after restart` log line was observed for this specific drill
- because of that, this run does **not** yet prove restart restoration of pre-existing paper positions

Interpretation:

- paper restart is operationally safe enough to re-launch quickly
- but the evidence for paper-position restoration after restart is still incomplete and should be treated as open

## Shutdown Drill

- Result: pass for controlled stop
- Counted toward unattended gate: no
- Residual exposure: not applicable for paper mode, but the process stopped cleanly
- Manual rescue needed: no

## Review

- What stayed consistent:
  - paper mode was applied correctly
  - simulated entries, SL/TP triggers, and tracked positions were clearly exercised
  - controlled shutdown and immediate relaunch both worked
- What drifted:
  - restart drill did not produce explicit restore evidence for the pre-restart paper positions
- Root cause or hypothesis:
  - restart may be reopening from fresh bootstrap setups faster than the restore path becomes visible in current logs, or paper restore may need a more targeted harness to verify deterministically
- Next action:
  - run a more surgical paper restart drill with a narrower universe and a short pause after restart to inspect restore logs / tracked positions explicitly
  - pair that drill with Telegram `/positions` or a focused TUI check so restart evidence is not inferred from log flow alone
