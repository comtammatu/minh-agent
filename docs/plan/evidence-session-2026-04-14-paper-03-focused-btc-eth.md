# Evidence Capture

Date: 2026-04-14
Operator: Codex
Exchange: Bybit
Mode: PAPER
Universe: `BTC,ETH` via `FOCUSED_TRACKED_COINS`
Session ID: paper-2026-04-14-03-focused-btc-eth

## Session Summary

- Start time: 2026-04-14 07:23 ICT
- End time: 2026-04-14 07:24 ICT
- Strategy set: `smc-sd`
- Size policy: paper only, focused operator drill
- Session verdict: focused paper execution drill passed
- Promotion impact: improves paper evidence quality; does not change unattended-live gate

## Startup Evidence

- `ARMED` observed: yes
- exchange bootstrap succeeded: yes
- unexpected live positions: yes, startup reported existing Bybit open positions on the real account
- TUI / Telegram / exchange matched in first 5 minutes: not fully checked in this drill

Observed startup facts:

- process started with:
  - `PAPER_TRADE=true`
  - `FOCUSED_TRACKED_COINS=BTC,ETH`
- startup logged:
  - `FOCUSED TRACKED COINS override active: BTC, ETH`
  - `COINS | 2 coins selected (2 native + 0 HIP-3)`
  - `ARMED | 2 coins: 2 fully ready, 0 partial | 6 TFs`
- focused TUI run showed a narrow 2-coin dashboard instead of the normal 80-coin universe

## Incident Notes

- Category: exchange state mismatch risk
- Severity: medium
- Trigger: startup account bootstrap in paper mode
- Impact: Bybit account reported real open positions even though the bot itself was in paper mode
- Operator response: continue paper drill only; do not interpret this as supervised-live readiness
- Final state: drill remained safe because order path stayed simulated

Important note:

- During this focused paper drill, startup logged `POS | 5 open position(s)` on the Bybit account.
- This is a real operational blocker for any supervised-live session until those live positions are intentionally reviewed and resolved.

## Restart Drill

- Result: not run in this focused drill
- Counted toward unattended gate: no
- Ownership ambiguity: n/a
- Manual rescue needed: n/a

Why:

- paper-mode restart restoration is not currently part of the startup recovery path.
- `src/index.ts` only runs `restoreOpenPositions()` when `!getEffectivePaperTrade()`.
- so focused paper was used here for clean execution evidence, not for recovery proof.

## Shutdown Drill

- Result: pass
- Counted toward unattended gate: no
- Residual exposure: none for paper order path; process was stopped intentionally
- Manual rescue needed: no

## Review

- What stayed consistent:
  - focused universe override worked exactly as intended
  - `BTC` and `ETH` both produced paper setups and paper fills
  - both positions were tracked and moved into `IN_POSITION`
  - narrow drill was much easier to inspect than the 80-coin run
- What drifted:
  - startup still surfaced real Bybit open positions, which means paper safety and live-account cleanliness are separate concerns
- Root cause or hypothesis:
  - the bot is correctly simulating orders in paper mode, but it still reads real account state during startup/bootstrap
- Next action:
  - manually inspect and resolve the real Bybit open positions before any supervised-live session
  - use `FOCUSED_TRACKED_COINS` again for future paper drills when you want clearer, low-noise evidence
