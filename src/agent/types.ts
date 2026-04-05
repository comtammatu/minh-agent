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
  /** Strategy that owns this context (Sprint 4.5). Default 'layered' for backward compat. */
  strategyId: string
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

/** Timestamped PnL entry for sliding-window circuit breaker checks. */
export interface PnlEntry {
  ts: number   // ms timestamp
  pnl: number  // realized PnL of this trade
}

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
  /** Recent trade PnL history for rapid-loss sliding window (S11). */
  pnlHistory: PnlEntry[]
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

// ─── Order Types (S6: Order Lifecycle Manager) ──────────────────────────────

export type OrderStatus = 'pending' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected'
export type OrderType = 'limit' | 'market'
export type TriggerOrderType = 'sl' | 'tp'

/** Persisted order record — maps to `orders` table. */
export interface Order {
  id: string             // UUID from DB
  coin: string
  side: 'long' | 'short'
  type: OrderType
  price: number          // limit price or market ref price
  size: number           // in coin units
  status: OrderStatus
  setupId: string | null
  slPrice: number | null
  tpPrice: number | null
  cloid: string          // client order ID for idempotency (0x hex, 128-bit)
  exchangeOrderId: string | null
  createdAt: number      // ms timestamp
  updatedAt: number
  filledAt: number | null
  fillPrice: number | null
  fillSize: number       // filled so far (for partials)
  strategyId: string     // strategy that placed this order (Sprint 4.5)
  positionId: string | null  // set at fill time — links order to position
}

/** SL/TP trigger order placed on exchange after entry fill (R9). */
export interface TriggerOrder {
  type: TriggerOrderType
  coin: string
  side: 'long' | 'short'  // close side (opposite of position)
  triggerPrice: number
  size: number
  isMarket: boolean        // SL = trigger-market, TP = trigger-limit
  cloid: string
  exchangeOrderId: string | null
  parentOrderId: string    // links to entry order
}

/** Result from exchange order submission (stubbed until S10). */
export interface ExchangeOrderResult {
  success: boolean
  exchangeOrderId: string | null
  error: string | null
}

// ─── Position Monitor (S7) ──────────────────────────────────────────────────

/** Tracked state for an open position. Managed by PositionMonitor. */
export interface PositionState {
  positionId: string
  coin: string
  side: 'long' | 'short'
  entryPrice: number
  currentSize: number         // remaining size (decreases on partial close)
  originalSize: number
  slPrice: number
  tpPrice: number
  entryOrderId: string        // links to Order.id
  /** Strategy that owns this position (Sprint 4.5). */
  strategyId: string
  /** Trailing stop state — null until first monitor() call. */
  trailingState: import('./exits.js').TrailingStopState | null
  /** Which partial close levels have been triggered (by index). */
  partialClosesFired: number[]
  /** Timestamp of last exchange sync. */
  lastSyncAt: number
  openedAt: number
}

/** Action returned by monitor() — tells orchestrator what to do. */
export type MonitorAction =
  | { type: 'hold' }
  | { type: 'trail_update'; positionId: string; newSlPrice: number }
  | { type: 'partial_close'; positionId: string; closePct: number; newSlPrice: number | null }
  | { type: 'close'; positionId: string; reason: string }
  | { type: 'alert'; positionId: string; message: string }

/** Exchange position snapshot from clearinghouseState (stubbed until S10). */
export interface ExchangePositionSnapshot {
  coin: string
  size: number          // positive = long, negative = short, 0 = closed
  entryPrice: number
  unrealizedPnl: number
  liquidationPrice: number | null
}

// ─── Trade Journal (S9) ─────────────────────────────────────────────────────

export type JournalEventType =
  | 'signal'
  | 'enter'
  | 'exit'
  | 'skip'
  | 'invalidate'
  | 'circuit_break'
  | 'pause'
  | 'resume'
  | 'error'

/** A persisted journal row from trade_journal table. */
export interface JournalEntry {
  id: number
  ts: Date
  eventType: JournalEventType
  coin: string | null
  details: Record<string, unknown>
  agentState: string | null
}

/** Filter for querying journal entries. */
export interface JournalFilter {
  coin?: string
  eventType?: JournalEventType
  since?: Date
  until?: Date
  limit?: number
}

/** Aggregated daily summary. */
export interface DailySummary {
  date: string         // YYYY-MM-DD
  totalTrades: number
  wins: number
  losses: number
  winRate: number      // 0–1
  totalPnl: number
  avgPnl: number
  largestWin: number
  largestLoss: number
  entryCount: number   // total journal entries for the day
}

// ─── Pipeline Event (emitted by scanner) ─────────────────────────────────────

export interface PipelineEvents {
  setup: [setup: ActiveSetup]
  invalidation: [setupId: string, reason: string]
}

// ─── Self-Healing / Health (S13) ────────────────────────────────────────────

export type ComponentStatus = 'ok' | 'degraded' | 'critical'

export interface ComponentHealth {
  status: ComponentStatus
  lastSuccessAt: number   // ms timestamp of last successful operation
  lastErrorAt: number     // ms timestamp of last error (0 = never)
  lastError: string | null
  consecutiveErrors: number
}

export interface HealthReport {
  overall: ComponentStatus
  uptime: number           // seconds
  rssBytes: number
  components: {
    feed: ComponentHealth
    db: ComponentHealth
    exchange: ComponentHealth
  }
}

// ─── Snapshot (for API) ──────────────────────────────────────────────────────

export interface CoinSnapshotEntry {
  state: AgentState
  activeSetup: ActiveSetup | null
  pendingOrderId: string | null
  positionId: string | null
  consecutiveLosses: number
  stateAge: number  // ms since state entered
  strategyId: string
}

export interface GlobalSnapshotEntry {
  dailyPnl: number
  totalConsecutiveLosses: number
  globalPaused: boolean
  globalPauseReason: string | null
  uptime: number
}

export interface AgentSnapshot {
  /** Keyed by `coin:strategyId` (or just `coin` for backward-compat single-strategy). */
  coins: Record<string, CoinSnapshotEntry>
  /** Default strategy global (backward compat). */
  global: GlobalSnapshotEntry
  /** Per-strategy globals (Sprint 4.5). */
  strategyGlobals?: Record<string, GlobalSnapshotEntry>
}
