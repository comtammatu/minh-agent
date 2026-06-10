# Implementation Notes — Advisor + Learning Loop v1 (live log)

Decisions made during implementation that the contract didn't fully specify.

- **Outcome signal was broken pre-existing**: all position-monitor close paths
  dispatched `pnl: 0`; `sl_hit`/`tp_hit` events are defined but never emitted
  anywhere; the `positions` table (read by analytics) has no writer. v1 fixes
  the journal/memory path with a price-based estimate; the `positions` table
  writer + analytics fix is OUT of scope here (flagged as follow-up).
- **pnlR is price-based** ((close−entry)/(entry−sl), signed by side), not
  size/fee-aware. Good enough to bucket outcomes; tagged `pnlEstimated: true`
  in journal details so future fill-based accounting can supersede it.
- **Dedupe rule**: one trade_outcome memory per position close keyed on the
  exit event carrying `setupId` (handleInPosition path). The handleExiting
  `position_closed` re-journal stays for audit but no longer writes memory.
