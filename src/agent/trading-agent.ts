/**
 * Trading Agent — pure state handlers for the per-coin state machine.
 *
 * R2:  State-handler pattern — each state has own handler function.
 * R5:  CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange.
 *
 * Sprint 4.5 (E28): Orchestrator class extracted to trading-orchestrator.ts.
 * This file keeps pure handlers + exports handler dispatch table.
 * TradingAgent, getAgent, resetAgent re-exported for backward compatibility.
 */

import type { ActiveSetup, ConfluenceGrade, SignalSide } from "../types.js";
import type {
  AgentAction,
  AgentEvent,
  AgentState,
  CoinContext,
  GlobalContext,
  TransitionResult,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum confluence grade to transition from IDLE → WATCHING. */
const MIN_GRADE_FOR_WATCH = new Set(["B", "A", "A+"]);

/** Order fill timeout (ms) — cancel if not filled within this window. */
const ORDER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Pure State Handlers ─────────────────────────────────────────────────────

export function handleIdle(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  if (global.globalPaused) {
    return {
      nextState: "PAUSED",
      actions: [
        journalAction("pause", ctx.coin, { reason: global.globalPauseReason }),
      ],
    };
  }

  if (event.type === "setup_detected") {
    const { setup } = event;
    const grade = setup.confluenceGrade ?? "C";
    if (!MIN_GRADE_FOR_WATCH.has(grade)) {
      return {
        nextState: "IDLE",
        actions: [
          journalAction("skip", ctx.coin, {
            reason: `Grade ${grade} below B`,
            setupId: setup.id,
          }),
        ],
      };
    }
    return {
      nextState: "ENTERING",
      actions: [
        { type: "place_order", setup },
        journalAction(
          "signal",
          ctx.coin,
          buildSignalJournalDetails(setup, grade),
        ),
      ],
    };
  }

  if (event.type === "pause") {
    return {
      nextState: "PAUSED",
      actions: [journalAction("pause", ctx.coin, { reason: event.reason })],
    };
  }

  return { nextState: "IDLE", actions: [] };
}

export function handleWatching(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  if (global.globalPaused) {
    return {
      nextState: "PAUSED",
      actions: [
        journalAction("pause", ctx.coin, { reason: global.globalPauseReason }),
      ],
    };
  }

  if (event.type === "setup_invalidated") {
    return {
      nextState: "IDLE",
      actions: [
        journalAction("invalidate", ctx.coin, {
          setupId: event.setupId,
          reason: event.reason,
        }),
      ],
    };
  }

  // A new, better setup replaces the current one
  if (event.type === "setup_detected" && ctx.activeSetup) {
    const { setup } = event;
    const grade = setup.confluenceGrade ?? "C";
    if (!MIN_GRADE_FOR_WATCH.has(grade)) {
      return {
        nextState: "WATCHING",
        actions: [
          journalAction("skip", ctx.coin, {
            reason: `Grade ${grade} below B — keep watching active setup`,
            setupId: setup.id,
            activeSetupId: ctx.activeSetup.id,
          }),
        ],
      };
    }
    // Higher confidence → upgrade
    if (setup.confidence > ctx.activeSetup.confidence) {
      return {
        nextState: "WATCHING",
        actions: [
          { type: "watch", setup },
          journalAction(
            "signal",
            ctx.coin,
            buildSignalJournalDetails(setup, grade, {
              replaced: ctx.activeSetup.id,
            }),
          ),
        ],
      };
    }
    const newPct = Math.round(setup.confidence * 100);
    const curPct = Math.round(ctx.activeSetup.confidence * 100);
    return {
      nextState: "WATCHING",
      actions: [
        journalAction("skip", ctx.coin, {
          reason: `New setup conf ${newPct}% not above active ${curPct}% — no upgrade`,
          setupId: setup.id,
          activeSetupId: ctx.activeSetup.id,
        }),
      ],
    };
  }

  // Entry trigger confirmed — place order
  if (event.type === "setup_detected" && !ctx.activeSetup) {
    // Shouldn't happen (WATCHING requires activeSetup), but handle gracefully
    return handleIdle(ctx, event, global);
  }

  // Tick: check if setup expired (based on stateEnteredAt)
  if (event.type === "tick" && ctx.activeSetup) {
    const watchAge = Date.now() - ctx.stateEnteredAt;
    if (watchAge > ORDER_TIMEOUT_MS * 2) {
      return {
        nextState: "IDLE",
        actions: [
          journalAction("invalidate", ctx.coin, {
            reason: "watch_timeout",
            setupId: ctx.activeSetup.id,
          }),
        ],
      };
    }
  }

  if (event.type === "pause") {
    return {
      nextState: "PAUSED",
      actions: [journalAction("pause", ctx.coin, { reason: event.reason })],
    };
  }

  return { nextState: "WATCHING", actions: [] };
}

export function handleEntering(
  ctx: CoinContext,
  event: AgentEvent,
  _global: GlobalContext,
): TransitionResult {
  if (event.type === "order_filled") {
    return {
      nextState: "IN_POSITION",
      actions: [
        journalAction("enter", ctx.coin, {
          orderId: event.orderId,
          fillPrice: event.fillPrice,
          positionId: event.positionId,
          setupId: ctx.activeSetup?.id,
          side: ctx.activeSetup?.side,
        }),
      ],
    };
  }

  if (event.type === "order_rejected") {
    return {
      nextState: "IDLE",
      actions: [
        journalAction("skip", ctx.coin, {
          orderId: event.orderId,
          reason: `Order rejected: ${event.reason}`,
        }),
      ],
    };
  }

  if (event.type === "order_timeout") {
    return {
      nextState: "IDLE",
      actions: [
        { type: "cancel_order", orderId: event.orderId, reason: "timeout" },
        journalAction("skip", ctx.coin, {
          orderId: event.orderId,
          reason: "Order timeout",
        }),
      ],
    };
  }

  // Tick: check order timeout — fires regardless of pendingOrderId to unblock stuck ENTERING
  if (event.type === "tick") {
    const age = Date.now() - ctx.stateEnteredAt;
    if (age > ORDER_TIMEOUT_MS) {
      const actions: AgentAction[] = [
        journalAction("skip", ctx.coin, {
          orderId: ctx.pendingOrderId,
          reason: "Order timeout",
        }),
      ];
      if (ctx.pendingOrderId) {
        // Cancel on exchange only if we have an order ID (live limit order)
        actions.unshift({
          type: "cancel_order",
          orderId: ctx.pendingOrderId,
          reason: "timeout",
        });
      }
      return { nextState: "IDLE", actions };
    }
  }

  if (event.type === "setup_invalidated") {
    const actions: AgentAction[] = [];
    if (ctx.pendingOrderId) {
      actions.push({
        type: "cancel_order",
        orderId: ctx.pendingOrderId,
        reason: event.reason,
      });
    }
    actions.push(
      journalAction("invalidate", ctx.coin, {
        setupId: event.setupId,
        reason: event.reason,
      }),
    );
    return { nextState: "IDLE", actions };
  }

  if (event.type === "pause" || event.type === "circuit_break") {
    const reason = event.reason;
    const actions: AgentAction[] = [
      journalAction("pause", ctx.coin, { reason }),
    ];
    if (ctx.pendingOrderId) {
      actions.unshift({
        type: "cancel_order",
        orderId: ctx.pendingOrderId,
        reason,
      });
    }
    return { nextState: "PAUSED", actions };
  }

  if (event.type === "setup_detected") {
    const { setup } = event;
    return {
      nextState: "ENTERING",
      actions: [
        journalAction("skip", ctx.coin, {
          reason: `Order pending — ignored new setup until fill/cancel`,
          setupId: setup.id,
          pendingOrderId: ctx.pendingOrderId,
        }),
      ],
    };
  }

  return { nextState: "ENTERING", actions: [] };
}

export function handleInPosition(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  // R5: CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange.

  // Close events are notifications of an ALREADY-completed close (reconcile
  // detected the position gone, or an exchange trigger fired) — there is
  // nothing to await, so transition straight to IDLE. EXITING is reserved for
  // agent-initiated closes (close_position submitted, awaiting confirmation).
  if (
    event.type === "sl_hit" ||
    event.type === "tp_hit" ||
    event.type === "trail_stop_hit" ||
    event.type === "position_closed"
  ) {
    return {
      nextState: global.globalPaused ? "PAUSED" : "IDLE",
      actions: [
        journalAction(
          "exit",
          ctx.coin,
          buildExitJournalDetails(event, ctx.activeSetup),
        ),
      ],
    };
  }

  if (event.type === "setup_invalidated" && ctx.positionId) {
    return {
      nextState: "EXITING",
      actions: [
        {
          type: "close_position",
          positionId: ctx.positionId,
          reason: `Invalidated: ${event.reason}`,
        },
        journalAction("invalidate", ctx.coin, {
          setupId: event.setupId,
          reason: event.reason,
          positionId: ctx.positionId,
        }),
      ],
    };
  }

  // Emergency pause: close position immediately
  if (event.type === "pause" && ctx.positionId) {
    return {
      nextState: "EXITING",
      actions: [
        {
          type: "close_position",
          positionId: ctx.positionId,
          reason: `Emergency: ${event.reason}`,
        },
        journalAction("pause", ctx.coin, {
          reason: event.reason,
          positionId: ctx.positionId,
        }),
      ],
    };
  }

  return { nextState: "IN_POSITION", actions: [] };
}

export function handleExiting(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  // Any close event completes the exit — position_closed from reconcile is
  // the normal confirmation; sl/tp/trail arriving here mean an exchange
  // trigger fired while our close was in flight (same terminal outcome).
  // activeSetup is still set here (only cleared by close events / IDLE states),
  // so invalidation-driven closes get full setup context in their exit row —
  // analytics and trade_outcome memories depend on it.
  if (
    event.type === "position_closed" ||
    event.type === "sl_hit" ||
    event.type === "tp_hit" ||
    event.type === "trail_stop_hit"
  ) {
    return {
      nextState: global.globalPaused ? "PAUSED" : "IDLE",
      actions: [
        journalAction(
          "exit",
          ctx.coin,
          buildExitJournalDetails(event, ctx.activeSetup),
        ),
      ],
    };
  }

  if (event.type === "tick") {
    // Safety net: EXITING with no positionId has nothing left to confirm or
    // retry (the close-event context update already nulled it) — finish the
    // exit instead of stranding the coin until restart.
    if (!ctx.positionId) {
      return {
        nextState: global.globalPaused ? "PAUSED" : "IDLE",
        actions: [
          journalAction("exit", ctx.coin, {
            reason: "exit_complete_no_position",
          }),
        ],
      };
    }

    // Exit taking too long (exchange issue) — retry close, don't lose position
    const age = Date.now() - ctx.stateEnteredAt;
    if (age > ORDER_TIMEOUT_MS) {
      return {
        nextState: "EXITING",
        actions: [
          {
            type: "close_position",
            positionId: ctx.positionId,
            reason: "exit_timeout_retry",
          },
          journalAction("error", ctx.coin, {
            reason: "Exit timeout — retrying close",
            positionId: ctx.positionId,
          }),
        ],
      };
    }
  }

  return { nextState: "EXITING", actions: [] };
}

export function handlePaused(
  ctx: CoinContext,
  event: AgentEvent,
  _global: GlobalContext,
): TransitionResult {
  if (event.type === "setup_detected") {
    const { setup } = event;
    const why = ctx.pauseReason ?? "unknown";
    return {
      nextState: "PAUSED",
      actions: [
        journalAction("skip", ctx.coin, {
          reason: `Agent paused (${why}) — setup ignored`,
          setupId: setup.id,
        }),
      ],
    };
  }

  if (event.type === "resume") {
    return {
      nextState: "IDLE",
      actions: [
        journalAction("resume", ctx.coin, { previousPause: ctx.pauseReason }),
      ],
    };
  }

  // Tick: check if auto-resume time has passed
  if (event.type === "tick" && ctx.pauseUntil) {
    if (Date.now() >= ctx.pauseUntil) {
      return {
        nextState: "IDLE",
        actions: [
          journalAction("resume", ctx.coin, {
            reason: "cooldown_expired",
            previousPause: ctx.pauseReason,
          }),
        ],
      };
    }
  }

  return { nextState: "PAUSED", actions: [] };
}

// ─── Handler Dispatch Table ──────────────────────────────────────────────────

export const handlers: Record<
  AgentState,
  (
    ctx: CoinContext,
    event: AgentEvent,
    global: GlobalContext,
  ) => TransitionResult
> = {
  IDLE: handleIdle,
  WATCHING: handleWatching,
  ENTERING: handleEntering,
  IN_POSITION: handleInPosition,
  EXITING: handleExiting,
  PAUSED: handlePaused,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Journal payload for setup signals — Telegram + terminal show entry / SL / TP / side / TF. */
function buildSignalJournalDetails(
  setup: ActiveSetup,
  grade: ConfluenceGrade,
  extra?: { replaced?: string },
): Record<string, unknown> {
  const patternRaw = setup.patternData.pattern;
  const pattern = typeof patternRaw === "string" ? patternRaw : undefined;
  const base: Record<string, unknown> = {
    setupId: setup.id,
    grade,
    confidence: setup.confidence,
    side: setup.side,
    interval: setup.interval,
    entryPrice: setup.entryPrice,
    slPrice: setup.slPrice,
    tpPrice: setup.tpPrice,
  };
  if (pattern !== undefined) base.pattern = pattern;
  if (extra?.replaced !== undefined) base.replaced = extra.replaced;
  return base;
}

/** Exit events that carry a close outcome (closePrice/pnl, optionally estimated). */
type ExitEvent = Extract<
  AgentEvent,
  { type: "sl_hit" | "tp_hit" | "trail_stop_hit" | "position_closed" }
>;

/** Setup dimensions copied into exit journal details for the advisor learning loop. */
const EXIT_PATTERN_DATA_KEYS = [
  "regime",
  "zoneOrigin",
  "entryType",
  "tradeStyle",
] as const;

/**
 * Price-based R multiple of a closed trade. Risk unit = entry↔SL distance.
 * Long: (close − entry) / (entry − sl); short: (entry − close) / (sl − entry).
 * Pure — returns null when inputs are non-finite or risk distance is not positive.
 */
function computePriceBasedPnlR(
  side: SignalSide,
  entryPrice: number,
  slPrice: number,
  closePrice: number,
): number | null {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(slPrice) ||
    !Number.isFinite(closePrice) ||
    closePrice <= 0
  ) {
    return null;
  }
  const risk = side === "long" ? entryPrice - slPrice : slPrice - entryPrice;
  if (risk <= 0) return null;
  const move =
    side === "long" ? closePrice - entryPrice : entryPrice - closePrice;
  const pnlR = move / risk;
  return Number.isFinite(pnlR) ? pnlR : null;
}

/**
 * Exit journal payload — close outcome + setup dimensions (pnlR, regime,
 * zone/entry/style) consumed by trade_outcome memories and the advisor.
 * Pure — derives everything from the event and the active setup.
 */
function buildExitJournalDetails(
  event: ExitEvent,
  setup: ActiveSetup | null,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    positionId: event.positionId,
    closePrice: event.closePrice,
    pnl: event.pnl,
    reason: event.type,
  };
  if (event.type === "position_closed") details.closeReason = event.reason;
  if (event.pnlEstimated === true) details.pnlEstimated = true;
  if (!setup) return details;

  details.setupId = setup.id;
  details.interval = setup.interval;
  details.side = setup.side;
  details.confidence = setup.confidence;
  details.pattern = setup.type;
  if (setup.confluenceGrade) details.grade = setup.confluenceGrade;

  const pnlR = computePriceBasedPnlR(
    setup.side,
    setup.entryPrice,
    setup.slPrice,
    event.closePrice,
  );
  if (pnlR !== null) details.pnlR = pnlR;

  for (const key of EXIT_PATTERN_DATA_KEYS) {
    const value = setup.patternData[key];
    if (typeof value === "string" && value.length > 0) details[key] = value;
  }
  return details;
}

function journalAction(
  eventType: string,
  coin: string,
  details: Record<string, unknown>,
): AgentAction {
  return { type: "log_journal", eventType, coin, details };
}

// ─── Re-exports from trading-orchestrator.ts ────────────────────────────────

export {
  getAgent,
  resetAgent,
  stateKey,
  TradingAgent,
} from "./trading-orchestrator.js";
