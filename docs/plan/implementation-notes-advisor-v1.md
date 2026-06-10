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

## Review fixes (post-integration, 2026-06-10)

- **recordPnl double-count fixed**: close-event context block in
  `applyEventContext` now guards on `ctx.positionId !== null` — the thesis
  close completion dispatch (EXITING→IDLE) no longer double-counts dailyPnl
  or loss streaks. The completion dispatch also carries `pnl: 0` so daily
  summaries (which sum every exit journal row) stay correct. Regression
  tests added in trading-orchestrator.test.ts.
- **`advisor` journal eventType registered** in `JournalEventType` union and
  the server's `JOURNAL_EVENTS` filter list — `/api/dashboard/journal?eventType=advisor`
  now works, which counterfactual measurement depends on.
- **Pre-enrichment rows self-exclude**: old trade_outcome rows (pnl=0,
  pnlR=null) are skipped by `isWin()` as signal-less, so historical garbage
  cannot poison bucket stats. No backfill needed for correctness.
- **Paper/live blending**: stats cache does NOT filter by executionMode —
  paper outcomes inform live verdicts (intentional v1: paper data is the only
  data at first). Tagged in metadata for a future mode-aware filter.

## Pre-existing issues surfaced (follow-ups, NOT fixed here)

1. **Thesis-close double-dispatch**: `position_closed` dispatched twice →
   `recordPnl` runs twice (dailyPnl double-count, consecutiveLosses +2 per
   thesis loss). Was invisible while pnl was always 0; now conservative-biased
   (CB trips earlier). Fix: positionId-level dedupe in recordPnl/applyEventContext.
   → FIXED 2026-06-10 (review pass): positionId guard in applyEventContext.
2. **Reconcile-close strands EXITING**: a reconcile-detected close dispatches
   `position_closed` once; the coin transitions IN_POSITION→EXITING and nothing
   moves it to IDLE (tick-retry needs positionId, which was nulled).
   → FIXED 2026-06-10 (follow-up session): see "EXITING stranding fix" below.
3. **`positions` table has no writer** — analytics live metrics read an empty
   table. The journal/memory outcome path is now fixed; the analytics path
   still needs a positions-row writer.
   → FIXED 2026-06-11 (follow-up session): see "Journal-derived analytics" below.

## Journal-derived analytics (follow-up session, 2026-06-11)

**Decision: option (b) — analytics derive from trade_journal exit rows.**
Option (a) (write positions rows at open/close) was rejected because it
creates permanent dual bookkeeping (positions table vs journal vs in-memory
monitor state) and every present and future close path would have to remember
the write — the exact failure mode that left the table empty. After the
EXITING-stranding fix, every position close produces exactly ONE exit journal
row carrying pnl/side/pattern/grade/setupId, making the journal the canonical
closed-trade record. The old pattern_performance matview had also never
worked: it joined on JSON keys the agent never wrote
(`position_id`/`pattern_type`/`signal_grade` vs `positionId`/`pattern`/`grade`).

- **Migration 013** re-creates daily_performance, pattern_performance, and
  pnl_hourly over journal exits. Keys are COALESCE'd to 'unknown' so the
  unique indexes needed by REFRESH CONCURRENTLY never see NULLs.
- **Signal-less row convention** (aligned with the advisor's isWin rule):
  exit rows with NULL pnl are audit-only (safety net, crash recovery); pnl=0
  rows (legacy pre-estimate data, estimate-fallback closes) are excluded from
  trade metrics. Tradeoff: true breakeven closes are also excluded — rare and
  statistically irrelevant vs poisoning win rates with legacy zero rows.
- **handleExiting enrichment**: completion exits now use
  buildExitJournalDetails, so invalidation-driven closes carry full setup
  context — which ALSO closes a learning-loop gap: those closes previously
  wrote no trade_outcome memory (no setupId). Builder gained `grade`
  (confluenceGrade) for the pattern matview.
- **openPositionCount** now comes from the in-memory PositionMonitor (live
  truth) instead of the dead table; `getOpenPositionCount` removed.
- **`reason` semantics**: exit rows use reason=event type and
  closeReason=granular cause (both handler paths now identical); the telegram
  exit alert prefers closeReason.
- **positions table left in place** (migrations are append-only) but nothing
  reads or writes it anymore; candidates for a cleanup migration later.

## EXITING stranding fix (follow-up session, 2026-06-10)

- **Semantics clarified**: close events (sl/tp/trail/position_closed) are
  notifications of an ALREADY-completed close → `handleInPosition` goes
  straight to IDLE (PAUSED under global pause). EXITING now means exactly one
  thing: agent-initiated close in flight (`close_position` submitted,
  positionId retained for tick-retry). The thesis double-dispatch workaround
  was removed.
- **handleExiting hardened**: any close event completes the exit (a trigger
  firing mid-close is the same terminal outcome); tick with null positionId
  finishes via `exit_complete_no_position` journal instead of stranding.
- **Thesis paper-tiger close discovered + fixed**: thesisToActions 'severe'
  emitted a `close` MonitorAction, but executeAction only dispatched a fake
  `position_closed` to the agent — NOBODY submitted an exchange close. The
  position stayed open (unmanaged) while the agent went flat → double-position
  risk on re-entry. Now: monitor-initiated close reasons route to
  `onClose` (new `setCloseCallback`, wired in app.ts to
  `om.handleAction({type:'close_position'})`); the agent stays IN_POSITION and
  reconcile confirms with the PnL estimate once the exchange shows the
  position gone. Trail (`trail_stop_hit…`) and reconcile
  (`exchange_position_closed/not_found`) reasons remain pure notifications.
- **Repeat-submit pacing**: if the thesis close doesn't fill before the next
  thesis check, the cooldown (entry TF × cooldownMultiplier) paces re-submits;
  reduce-only orders cannot over-close. Accepted noise.
- **Late/duplicate close events in IDLE** are harmless: handleIdle ignores
  them and the applyEventContext positionId guard skips PnL recording.
