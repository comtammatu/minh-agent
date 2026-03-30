/**
 * Agent type definitions — state machine, context, events, actions.
 *
 * Design:
 *   - Per-coin state: each coin has its own AgentState (IDLE/WATCHING/etc.)
 *   - Global state: circuit breakers, daily PnL, pause override
 *   - Handlers return TransitionResult (next state + action) — no side effects
 *   - Actions are discriminated unions — orchestrator executes them in S6/S7
 */

import type { ActiveSetup, ConfluenceGrade } from '../types.js'

// ─── Agent States ────────────────────────────────────────────────────────────

export type AgentState =
  | 'IDLE'          // scanning, no active setup for this coin
  | 'WATCHING'      // setup detected, waiting for entry trigger
  | 'ENTERING'      // order placed, awaiting fill
  | 'IN_POSITION'   // position open, monitoring SL/TP/trail
  | 'EXITING'       // closing position
  | 'PAUSED'        // circuit breaker or manual override

// ─── Per-Coin Context ────────────────────────────────────────────────────────

export interface CoinContext {
  state: AgentState
  coin: string
  /** The setup being watched/entered (null when IDLE/PAUSED). */
  activeSetup: ActiveSetup | null
  /** Pending order ID (set in ENTERING, cleared on fill/reject). */
  pendingOrderId: string | null
  /** Open position ID (set in IN_POSITION). */
  positionId: string | null
  /** Timestamp when current state was entered. */
  stateEnteredAt: number
  /** Number of consecutive losses for this coin. */
  consecutiveLosses: number
  /** Reason for current PAUSED state (null if not paused). */
  pauseReason: string | null
  /** When PAUSED state should auto-resume (null = manual resume only). */
  pauseUntil: number | null
}

// ─── Global Context ──────────────────────────────────────────────────────────

export interface GlobalContext {
  /** Daily realized PnL (resets at UTC midnight). */
  dailyPnl: number
  /** Peak account value for drawdown tracking. */
  peakAccountValue: number
  /** Total consecutive losses across all coins. */
  totalConsecutiveLosses: number
  /** Timestamp of last trade close. */
  lastTradeTime: number
  /** Global pause override (emergency). */
  globalPaused: boolean
  /** Reason for global pause. */
  globalPauseReason: string | null
  /** Agent start time. */
  startedAt: number
}

// ─── Actions (returned by handlers, executed by orchestrator) ────────────────

export type AgentAction =
  | { type: 'none' }
  | { type: 'watch'; setup: ActiveSetup }
  | { type: 'place_order'; setup: ActiveSetup }
  | { type: 'cancel_order'; orderId: string; reason: string }
  | { type: 'close_position'; positionId: string; reason: string }
  | { type: 'update_stop'; positionId: string; newStopPrice: number }
  | { type: 'partial_close'; positionId: string; closePct: number }
  | { type: 'log_journal'; eventType: string; coin: string; details: Record<string, unknown> }

// ─── Transition Result ───────────────────────────────────────────────────────

export interface TransitionResult {
  nextState: AgentState
  actions: AgentAction[]
}

// ─── Events (input to state machine) ─────────────────────────────────────────

export type AgentEvent =
  | { type: 'setup_detected'; setup: ActiveSetup }
  | { type: 'setup_invalidated'; setupId: string; reason: string }
  | { type: 'order_filled'; orderId: string; fillPrice: number; positionId: string }
  | { type: 'order_rejected'; orderId: string; reason: string }
  | { type: 'order_timeout'; orderId: string }
  | { type: 'sl_hit'; positionId: string; closePrice: number; pnl: number }
  | { type: 'tp_hit'; positionId: string; closePrice: number; pnl: number }
  | { type: 'trail_stop_hit'; positionId: string; closePrice: number; pnl: number }
  | { type: 'position_closed'; positionId: string; closePrice: number; pnl: number; reason: string }
  | { type: 'circuit_break'; reason: string; pauseUntil: number | null }
  | { type: 'pause'; reason: string }
  | { type: 'resume' }
  | { type: 'tick' }  // periodic check (timeouts, cooldowns)

// ─── Pipeline Event (emitted by scanner) ─────────────────────────────────────

export interface PipelineEvents {
  setup: [setup: ActiveSetup]
  invalidation: [setupId: string, reason: string]
}

// ─── Snapshot (for API) ──────────────────────────────────────────────────────

export interface AgentSnapshot {
  coins: Record<string, {
    state: AgentState
    activeSetup: ActiveSetup | null
    pendingOrderId: string | null
    positionId: string | null
    consecutiveLosses: number
    stateAge: number  // ms since state entered
  }>
  global: {
    dailyPnl: number
    totalConsecutiveLosses: number
    globalPaused: boolean
    globalPauseReason: string | null
    uptime: number
  }
}
