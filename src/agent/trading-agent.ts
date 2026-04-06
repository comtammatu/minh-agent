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

import type { ActiveSetup, ConfluenceGrade } from '../types.js'
import type {
  AgentState,
  AgentEvent,
  AgentAction,
  CoinContext,
  GlobalContext,
  TransitionResult,
} from './types.js'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum confluence grade to transition from IDLE → WATCHING. */
const MIN_GRADE_FOR_WATCH = new Set(['B', 'A', 'A+'])

/** Order fill timeout (ms) — cancel if not filled within this window. */
const ORDER_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

// ─── Pure State Handlers ─────────────────────────────────────────────────────

export function handleIdle(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  if (global.globalPaused) {
    return { nextState: 'PAUSED', actions: [journalAction('pause', ctx.coin, { reason: global.globalPauseReason })] }
  }

  if (event.type === 'setup_detected') {
    const { setup } = event
    const grade = setup.confluenceGrade ?? 'C'
    if (!MIN_GRADE_FOR_WATCH.has(grade)) {
      return { nextState: 'IDLE', actions: [journalAction('skip', ctx.coin, { reason: `Grade ${grade} below B`, setupId: setup.id })] }
    }
    return {
      nextState: 'WATCHING',
      actions: [
        { type: 'watch', setup },
        journalAction('signal', ctx.coin, { setupId: setup.id, grade, confidence: setup.confidence, side: setup.side }),
      ],
    }
  }

  if (event.type === 'pause') {
    return { nextState: 'PAUSED', actions: [journalAction('pause', ctx.coin, { reason: event.reason })] }
  }

  return { nextState: 'IDLE', actions: [] }
}

export function handleWatching(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  if (global.globalPaused) {
    return { nextState: 'PAUSED', actions: [journalAction('pause', ctx.coin, { reason: global.globalPauseReason })] }
  }

  if (event.type === 'setup_invalidated') {
    return {
      nextState: 'IDLE',
      actions: [journalAction('invalidate', ctx.coin, { setupId: event.setupId, reason: event.reason })],
    }
  }

  // A new, better setup replaces the current one
  if (event.type === 'setup_detected' && ctx.activeSetup) {
    const { setup } = event
    const grade = setup.confluenceGrade ?? 'C'
    if (!MIN_GRADE_FOR_WATCH.has(grade)) {
      return { nextState: 'WATCHING', actions: [] }
    }
    // Higher confidence → upgrade
    if (setup.confidence > ctx.activeSetup.confidence) {
      return {
        nextState: 'WATCHING',
        actions: [
          { type: 'watch', setup },
          journalAction('signal', ctx.coin, { setupId: setup.id, grade, confidence: setup.confidence, side: setup.side, replaced: ctx.activeSetup.id }),
        ],
      }
    }
    return { nextState: 'WATCHING', actions: [] }
  }

  // Entry trigger confirmed — place order
  if (event.type === 'setup_detected' && !ctx.activeSetup) {
    // Shouldn't happen (WATCHING requires activeSetup), but handle gracefully
    return handleIdle(ctx, event, global)
  }

  // Tick: check if setup expired (based on stateEnteredAt)
  if (event.type === 'tick' && ctx.activeSetup) {
    const watchAge = Date.now() - ctx.stateEnteredAt
    if (watchAge > ORDER_TIMEOUT_MS * 2) {
      return {
        nextState: 'IDLE',
        actions: [journalAction('invalidate', ctx.coin, { reason: 'watch_timeout', setupId: ctx.activeSetup.id })],
      }
    }
  }

  if (event.type === 'pause') {
    return { nextState: 'PAUSED', actions: [journalAction('pause', ctx.coin, { reason: event.reason })] }
  }

  return { nextState: 'WATCHING', actions: [] }
}

export function handleEntering(
  ctx: CoinContext,
  event: AgentEvent,
  _global: GlobalContext,
): TransitionResult {
  if (event.type === 'order_filled') {
    return {
      nextState: 'IN_POSITION',
      actions: [journalAction('enter', ctx.coin, {
        orderId: event.orderId,
        fillPrice: event.fillPrice,
        positionId: event.positionId,
        setupId: ctx.activeSetup?.id,
      })],
    }
  }

  if (event.type === 'order_rejected') {
    return {
      nextState: 'IDLE',
      actions: [journalAction('skip', ctx.coin, {
        orderId: event.orderId,
        reason: `Order rejected: ${event.reason}`,
      })],
    }
  }

  if (event.type === 'order_timeout') {
    return {
      nextState: 'IDLE',
      actions: [
        { type: 'cancel_order', orderId: event.orderId, reason: 'timeout' },
        journalAction('skip', ctx.coin, { orderId: event.orderId, reason: 'Order timeout' }),
      ],
    }
  }

  // Tick: check order timeout
  if (event.type === 'tick' && ctx.pendingOrderId) {
    const age = Date.now() - ctx.stateEnteredAt
    if (age > ORDER_TIMEOUT_MS) {
      return {
        nextState: 'IDLE',
        actions: [
          { type: 'cancel_order', orderId: ctx.pendingOrderId, reason: 'timeout' },
          journalAction('skip', ctx.coin, { orderId: ctx.pendingOrderId, reason: 'Order timeout' }),
        ],
      }
    }
  }

  if (event.type === 'setup_invalidated' && ctx.pendingOrderId) {
    return {
      nextState: 'IDLE',
      actions: [
        { type: 'cancel_order', orderId: ctx.pendingOrderId, reason: event.reason },
        journalAction('invalidate', ctx.coin, { setupId: event.setupId, reason: event.reason }),
      ],
    }
  }

  if (event.type === 'pause') {
    const actions: AgentAction[] = [journalAction('pause', ctx.coin, { reason: event.reason })]
    if (ctx.pendingOrderId) {
      actions.unshift({ type: 'cancel_order', orderId: ctx.pendingOrderId, reason: 'paused' })
    }
    return { nextState: 'PAUSED', actions }
  }

  return { nextState: 'ENTERING', actions: [] }
}

export function handleInPosition(
  ctx: CoinContext,
  event: AgentEvent,
  _global: GlobalContext,
): TransitionResult {
  // R5: CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange.

  if (event.type === 'sl_hit' || event.type === 'tp_hit' ||
      event.type === 'trail_stop_hit' || event.type === 'position_closed') {
    return {
      nextState: 'EXITING',
      actions: [journalAction('exit', ctx.coin, {
        positionId: event.positionId,
        closePrice: event.closePrice,
        pnl: event.pnl,
        reason: event.type,
      })],
    }
  }

  if (event.type === 'setup_invalidated' && ctx.positionId) {
    return {
      nextState: 'EXITING',
      actions: [
        { type: 'close_position', positionId: ctx.positionId, reason: `Invalidated: ${event.reason}` },
        journalAction('invalidate', ctx.coin, { setupId: event.setupId, reason: event.reason, positionId: ctx.positionId }),
      ],
    }
  }

  // Emergency pause: close position immediately
  if (event.type === 'pause' && ctx.positionId) {
    return {
      nextState: 'EXITING',
      actions: [
        { type: 'close_position', positionId: ctx.positionId, reason: `Emergency: ${event.reason}` },
        journalAction('pause', ctx.coin, { reason: event.reason, positionId: ctx.positionId }),
      ],
    }
  }

  return { nextState: 'IN_POSITION', actions: [] }
}

export function handleExiting(
  ctx: CoinContext,
  event: AgentEvent,
  global: GlobalContext,
): TransitionResult {
  if (event.type === 'position_closed') {
    const pnl = event.pnl
    const exitAction = journalAction('exit', ctx.coin, { pnl, reason: event.reason, positionId: event.positionId })

    if (global.globalPaused) {
      return {
        nextState: 'PAUSED',
        actions: [exitAction],
      }
    }

    return {
      nextState: 'IDLE',
      actions: [exitAction],
    }
  }

  // Tick: check if exit is taking too long (exchange issue) — retry close, don't lose position
  if (event.type === 'tick' && ctx.positionId) {
    const age = Date.now() - ctx.stateEnteredAt
    if (age > ORDER_TIMEOUT_MS) {
      return {
        nextState: 'EXITING',
        actions: [
          { type: 'close_position', positionId: ctx.positionId, reason: 'exit_timeout_retry' },
          journalAction('error', ctx.coin, { reason: 'Exit timeout — retrying close', positionId: ctx.positionId }),
        ],
      }
    }
  }

  return { nextState: 'EXITING', actions: [] }
}

export function handlePaused(
  ctx: CoinContext,
  event: AgentEvent,
  _global: GlobalContext,
): TransitionResult {
  if (event.type === 'resume') {
    return {
      nextState: 'IDLE',
      actions: [journalAction('resume', ctx.coin, { previousPause: ctx.pauseReason })],
    }
  }

  // Tick: check if auto-resume time has passed
  if (event.type === 'tick' && ctx.pauseUntil) {
    if (Date.now() >= ctx.pauseUntil) {
      return {
        nextState: 'IDLE',
        actions: [journalAction('resume', ctx.coin, { reason: 'cooldown_expired', previousPause: ctx.pauseReason })],
      }
    }
  }

  return { nextState: 'PAUSED', actions: [] }
}

// ─── Handler Dispatch Table ──────────────────────────────────────────────────

export const handlers: Record<AgentState, (ctx: CoinContext, event: AgentEvent, global: GlobalContext) => TransitionResult> = {
  IDLE: handleIdle,
  WATCHING: handleWatching,
  ENTERING: handleEntering,
  IN_POSITION: handleInPosition,
  EXITING: handleExiting,
  PAUSED: handlePaused,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function journalAction(eventType: string, coin: string, details: Record<string, unknown>): AgentAction {
  return { type: 'log_journal', eventType, coin, details }
}

// ─── Re-exports from trading-orchestrator.ts (backward compatibility) ───────

export { TradingAgent, getAgent, resetAgent, stateKey, parseStateKey } from './trading-orchestrator.js'
