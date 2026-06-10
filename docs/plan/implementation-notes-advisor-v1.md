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

## Integration decisions (fan-out implementation, 2026-06-10)

- **Mark price derivation**: `ExchangePositionSnapshot` has no mark-price
  field, so mark = entry + unrealizedPnl/signedSize, tracked per position and
  refreshed each sync; a reconcile-detected close can use a ~10s-stale mark.
  Estimate covers only the final-close portion after partial closes
  (`pnlEstimated: true` marks every estimated row for future fill-based
  accounting to supersede).
- **Dispatch revert restructure**: the orchestrator's state-revert check moved
  from reference equality (`filteredActions !== result.actions`) to a semantic
  check (place_order present before filters, absent after) — reference
  equality would have falsely reverted on dampen/shadow where the array is new
  but place_order survives.
- **`applied` semantics**: advisor journal `applied:true` only when mode is
  active AND the verdict altered actions (veto/dampen). Active+allow journals
  `applied:false`, so counterfactual queries can filter cleanly.
- **Gate ordering**: advisor runs after portfolio-risk, so portfolio-blocked
  entries produce no advisor journal (no double-veto noise; accepted tradeoff:
  no shadow counterfactual for those entries).
- **Size multiplier window** is strictly (0,1) exclusive; exactly 1 is a
  silent no-op. Dampening applies to whatever size was resolved, including a
  `positionSizeCoins` override.
- **Insight ordering**: `queryMemories` ranks by composite score, not
  created_at; surfaces re-sort the returned rows by createdAt desc so
  "latest insights" is truthful.
- **Boot wiring**: advisor cache + setAdvisor injected after `connectMetrics`
  and before pipeline subscription (verdicts cover bootstrap-time setups);
  both intervals registered in `activeIntervals` for cleanup; initial refresh
  is void-fired so boot is never delayed.

## Pre-existing issues surfaced (follow-ups, NOT fixed here)

1. **Thesis-close double-dispatch**: `position_closed` dispatched twice →
   `recordPnl` runs twice (dailyPnl double-count, consecutiveLosses +2 per
   thesis loss). Was invisible while pnl was always 0; now conservative-biased
   (CB trips earlier). Fix: positionId-level dedupe in recordPnl/applyEventContext.
2. **Reconcile-close strands EXITING**: a reconcile-detected close dispatches
   `position_closed` once; the coin transitions IN_POSITION→EXITING and nothing
   moves it to IDLE (tick-retry needs positionId, which was nulled).
3. **`positions` table has no writer** — analytics live metrics read an empty
   table. The journal/memory outcome path is now fixed; the analytics path
   still needs a positions-row writer.
