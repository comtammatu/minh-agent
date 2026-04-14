# Evidence Capture

Date: 2026-04-14
Operator: Codex + user
Exchange: Bybit
Mode: supervised live
Universe: BTC, ETH (`FOCUSED_TRACKED_COINS=BTC,ETH`)
Session ID: supervised-live-01

## Session Summary

- Start time: 2026-04-14T07:40:34Z
- End time: 2026-04-14T07:41:16Z
- Strategy set: `smc-sd`
- Size policy: default live sizing, narrow universe only
- Session verdict: aborted safely
- Promotion impact: does not count as a clean supervised-live pass

## Startup Evidence

- `ARMED` observed: yes, `ARMED | 2 coins: 2 fully ready, 0 partial | 6 TFs`
- exchange bootstrap succeeded: yes
- unexpected live positions: no, startup reported `0 open position(s)`
- TUI / Telegram / exchange matched in first 5 minutes: no; Telegram polling conflicted immediately

## Incident Notes

- Category: execution sizing + operator channel conflict
- Severity: medium
- Trigger: first live setup on `BTC` and `ETH` attempted with account equity effectively at zero and another Telegram poller already active
- Impact: both live entries were rejected before placement; operator channel health was degraded by repeated Telegram `409 Conflict`
- Operator response: stopped the supervised-live session and terminated both bot instances
- Final state: no live positions opened; no residual exposure

## Restart Drill

- Result: not performed
- Counted toward unattended gate: no
- Ownership ambiguity: none observed
- Manual rescue needed: no

## Shutdown Drill

- Result: pass for safe abort; both running bot instances were terminated and no residual exposure remained
- Counted toward unattended gate: no
- Residual exposure: none
- Manual rescue needed: yes, operator had to stop duplicate instances

## Review

- What stayed consistent: startup reached `LIVE`, `ARMED`, exchange bootstrap succeeded, account check showed no open positions, setup generation and rejection path were logged clearly
- What drifted: Telegram control plane was not single-owner; live sizing tried to enter with `qty=0` because effective balance was too small for exchange minimums
- Root cause or hypothesis: the Bybit account is technically clean but underfunded for the configured live sizing path, and a previous bot process was still long-polling Telegram
- Next action: fund the live wallet to a practical minimum or keep using paper for ops rehearsal, then ensure only one bot instance is running before the next supervised-live attempt
