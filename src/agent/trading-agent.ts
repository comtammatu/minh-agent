/**
 * Trading Agent — state machine with per-coin tracking.
 *
 * R2:  State-handler pattern — each state has own handler function.
 * R5:  CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange.
 * R10: Subscribes to pipeline EventEmitter 'setup' events.
 * R1:  Crash recovery skeleton — reconcile exchange state on startup (wired S10).
 *
 * Design:
 *   - Per-coin state machine: Map<coin, CoinContext>
 *   - Global context: daily PnL, circuit breakers, pause override
 *   - Handlers are PURE: (context, event) → TransitionResult
 *   - Orchestrator applies transitions + dispatches actions (S6/S7 wire execution)
 *   - EventEmitter bridge: pipeline emits → agent.onSetup()
 */

import { EventEmitter } from 'events'
import type { ActiveSetup } from '../types.js'
import type {
  AgentState,
  AgentEvent,
  AgentAction,
  AgentSnapshot,
  CoinContext,
  GlobalContext,
  TransitionResult,
  PipelineEvents,
} from './types.js'
import { runAllChecks, prunePnlHistory } from './circuit-breakers.js'
import { shouldBlockCorrelatedEntry } from './correlation-guard.js'
import { ANSI } from '../ui/terminal.js'

function ts(): string { return new Date().toISOString().slice(11, 19) }

/** Color-coded state badge for terminal output. */
function stateBadge(state: AgentState): string {
  switch (state) {
    case 'IDLE': return `${ANSI.dim}IDLE${ANSI.reset}`
    case 'WATCHING': return `${ANSI.cyan}WATCHING${ANSI.reset}`
    case 'ENTERING': return `${ANSI.yellow}ENTERING${ANSI.reset}`
    case 'IN_POSITION': return `${ANSI.bold}${ANSI.green}IN_POS${ANSI.reset}`
    case 'EXITING': return `${ANSI.magenta}EXITING${ANSI.reset}`
    case 'PAUSED': return `${ANSI.red}PAUSED${ANSI.reset}`
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum confluence grade to transition from IDLE → WATCHING. */
const MIN_GRADE_FOR_WATCH = new Set(['B', 'A', 'A+'])

/** Order fill timeout (ms) — cancel if not filled within this window. */
const ORDER_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

// Consecutive loss constants moved to config.ts CIRCUIT_BREAKER (S11).
// CB check logic moved to circuit-breakers.ts runAllChecks().

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
        journalAction('signal', ctx.coin, { setupId: setup.id, grade, confidence: setup.confidence }),
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
          journalAction('signal', ctx.coin, { setupId: setup.id, grade, replaced: ctx.activeSetup.id }),
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
    // Setup timeout: if watching for too long without entry, go back to IDLE
    // Actual expiry is handled by pipeline invalidation, but we catch orphans
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
  // So we do NOT transition to PAUSED on circuit_break while in position.

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

    // CB checks are now run by the orchestrator (TradingAgent.checkCircuitBreakers)
    // after recording PnL. handleExiting just logs the exit and goes IDLE or PAUSED
    // if globally paused.
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

  // Tick: check if exit is taking too long (exchange issue)
  if (event.type === 'tick') {
    const age = Date.now() - ctx.stateEnteredAt
    if (age > ORDER_TIMEOUT_MS) {
      return {
        nextState: 'IDLE',
        actions: [journalAction('error', ctx.coin, { reason: 'Exit timeout — position may still be open on exchange' })],
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

const handlers: Record<AgentState, (ctx: CoinContext, event: AgentEvent, global: GlobalContext) => TransitionResult> = {
  IDLE: handleIdle,
  WATCHING: handleWatching,
  ENTERING: handleEntering,
  IN_POSITION: handleInPosition,
  EXITING: handleExiting,
  PAUSED: handlePaused,
}

// ─── Trading Agent Class ─────────────────────────────────────────────────────

export class TradingAgent {
  private coins: Map<string, CoinContext> = new Map()
  private global: GlobalContext
  private emitter = new EventEmitter()

  constructor() {
    this.global = {
      dailyPnl: 0,
      peakAccountValue: 0,
      totalConsecutiveLosses: 0,
      lastTradeTime: 0,
      globalPaused: false,
      globalPauseReason: null,
      startedAt: Date.now(),
      pnlHistory: [],
    }
  }

  // ── Pipeline Integration (R10) ───────────────────────────────────────────

  /**
   * Subscribe to pipeline EventEmitter for setup events.
   * Note: invalidation events are handled by InvalidationBridge (S8),
   * which validates setupId match before dispatching to this agent.
   * Call `bridge.connect(pipelineEmitter, agent)` separately.
   */
  subscribeToPipeline(pipelineEmitter: EventEmitter): void {
    pipelineEmitter.on('setup', (setup: ActiveSetup) => {
      this.onSetup(setup)
    })
    // Invalidation events handled by InvalidationBridge — see S8.
    // Bridge calls agent.dispatch() after setupId matching.
  }

  /** Handle incoming setup from pipeline. */
  onSetup(setup: ActiveSetup): void {
    // S12: Anti-correlation guard — block if correlated positions exceed limit.
    // Only check when the coin is not already active (IDLE → would start new entry path).
    const coinState = this.getCoinState(setup.coin)
    if (coinState === 'IDLE' || coinState === 'WATCHING') {
      const openCoins = this.getOpenPositionCoins()
      const check = shouldBlockCorrelatedEntry(setup.coin, openCoins)
      if (check.blocked) {
        console.log(`[${ts()}] ${ANSI.dim}AGENT${ANSI.reset} | ${setup.coin.padEnd(8)} ${ANSI.yellow}BLOCKED${ANSI.reset} correlation guard: ${check.reason}`)
        this.emitter.emit('action', journalAction('skip', setup.coin, {
          reason: check.reason,
          setupId: setup.id,
          blockedGroups: check.blockedGroups,
        }))
        return  // Don't dispatch — blocked by correlation guard
      }
    }

    this.dispatch(setup.coin, { type: 'setup_detected', setup })
  }

  // ── Event Dispatch ───────────────────────────────────────────────────────

  /** Dispatch an event to a coin's state machine. */
  dispatch(coin: string, event: AgentEvent): TransitionResult {
    const ctx = this.getOrCreateCoinContext(coin)
    const prevState = ctx.state
    const handler = handlers[ctx.state]
    const result = handler(ctx, event, this.global)

    // Apply transition
    if (result.nextState !== prevState) {
      ctx.stateEnteredAt = Date.now()

      // Log state transitions (skip noisy IDLE→IDLE)
      const setup = ctx.activeSetup ?? (event.type === 'setup_detected' ? event.setup : null)
      const detail = setup ? ` | ${setup.type} ${setup.side}` : ''
      const reason = event.type === 'setup_invalidated' ? ` | reason: ${event.reason}` : ''
      console.log(`[${ts()}] ${ANSI.dim}AGENT${ANSI.reset} | ${coin.padEnd(8)} ${stateBadge(prevState)} → ${stateBadge(result.nextState)}${detail}${reason}`)
    }
    ctx.state = result.nextState

    // Log skip/block actions
    for (const action of result.actions) {
      if (action.type === 'log_journal' && action.eventType === 'skip') {
        console.log(`[${ts()}] ${ANSI.dim}AGENT${ANSI.reset} | ${coin.padEnd(8)} ${ANSI.yellow}SKIP${ANSI.reset} ${action.details?.reason ?? ''}`)
      }
    }

    // Apply side-effect context updates from actions
    for (const action of result.actions) {
      this.applyContextUpdate(ctx, action, event)
    }

    // Emit actions for orchestrator (S6/S7)
    for (const action of result.actions) {
      this.emitter.emit('action', action)
    }

    this.coins.set(coin, ctx)
    return result
  }

  /** Dispatch event to all coins (e.g., tick, global pause). */
  dispatchAll(event: AgentEvent): void {
    for (const coin of this.coins.keys()) {
      this.dispatch(coin, event)
    }
  }

  /** Tick all coins — check timeouts, cooldowns. */
  tick(): void {
    this.dispatchAll({ type: 'tick' })
  }

  // ── Global Controls ──────────────────────────────────────────────────────

  /** Emergency pause all coins (R5: IN_POSITION gets close, not hold). */
  pauseAll(reason: string): void {
    this.global.globalPaused = true
    this.global.globalPauseReason = reason
    this.dispatchAll({ type: 'pause', reason })
  }

  /** Resume all paused coins. */
  resumeAll(): void {
    this.global.globalPaused = false
    this.global.globalPauseReason = null
    this.dispatchAll({ type: 'resume' })
  }

  /**
   * Update daily PnL + pnlHistory (called by position monitor on close).
   * Runs circuit breaker checks after recording. If tripped, pauses all
   * non-IN_POSITION coins (R5).
   *
   * @param pnl - Realized PnL from this trade
   * @param accountValue - Current account value from exchange (for CB % checks)
   */
  recordPnl(pnl: number, accountValue?: number): void {
    const now = Date.now()
    this.global.dailyPnl += pnl
    this.global.lastTradeTime = now
    this.global.pnlHistory.push({ ts: now, pnl })

    if (pnl < 0) {
      this.global.totalConsecutiveLosses++
    } else {
      this.global.totalConsecutiveLosses = 0
    }

    // Update peak if account value provided
    if (accountValue !== undefined && accountValue > this.global.peakAccountValue) {
      this.global.peakAccountValue = accountValue
    }

    // Run CB checks if we have account value
    if (accountValue !== undefined) {
      this.checkCircuitBreakers(accountValue, now)
    }
  }

  /** Reset daily PnL (called at UTC midnight). */
  resetDailyPnl(): void {
    this.global.dailyPnl = 0
  }

  /**
   * Update account value — call on startup and periodically from exchange sync.
   * Tracks peak for max drawdown CB.
   */
  updateAccountValue(accountValue: number): void {
    if (accountValue > this.global.peakAccountValue) {
      this.global.peakAccountValue = accountValue
    }
  }

  /**
   * Run all circuit breaker checks against current global state.
   * If any trips, dispatch circuit_break to all non-IN_POSITION coins.
   * R5: IN_POSITION keeps SL/TP on exchange — only new entries blocked.
   */
  checkCircuitBreakers(accountValue: number, now: number = Date.now()): void {
    // Prune stale pnlHistory entries
    this.global.pnlHistory = prunePnlHistory(this.global.pnlHistory, now)

    const result = runAllChecks({
      dailyPnl: this.global.dailyPnl,
      accountValue,
      peakAccountValue: this.global.peakAccountValue,
      consecutiveLosses: this.global.totalConsecutiveLosses,
      pnlHistory: this.global.pnlHistory,
      now,
    })

    if (result.tripped && !this.global.globalPaused) {
      console.log(`[${ts()}] ${ANSI.bold}${ANSI.red}CIRCUIT BREAK${ANSI.reset} | ${result.reason} | dailyPnl=$${this.global.dailyPnl.toFixed(2)} | pause until ${result.pauseUntil ? new Date(result.pauseUntil).toISOString().slice(11, 19) : 'manual resume'}`)

      // Set global pause — prevents new entries
      this.global.globalPaused = true
      this.global.globalPauseReason = result.reason

      // Dispatch circuit_break to all coins NOT in position (R5)
      for (const [coin, ctx] of this.coins) {
        if (ctx.state !== 'IN_POSITION') {
          this.dispatch(coin, {
            type: 'circuit_break',
            reason: result.reason!,
            pauseUntil: result.pauseUntil,
          })
        }
      }

      // Emit alert action for orchestrator (Telegram, logs)
      this.emitter.emit('action', {
        type: 'log_journal',
        eventType: 'circuit_break',
        coin: '*',
        details: {
          reason: result.reason,
          pauseUntil: result.pauseUntil,
          dailyPnl: this.global.dailyPnl,
          accountValue,
          peakAccountValue: this.global.peakAccountValue,
        },
      })
    }
  }

  // ── Crash Recovery Skeleton (R1) ─────────────────────────────────────────

  /**
   * Recover agent state from exchange + DB on startup.
   * Skeleton — actual HL call wired in S10.
   *
   * @param exchangePositions - Open positions from HL clearinghouseState
   * @param dbPositions - Open positions from PostgreSQL
   */
  recoverFromCrash(
    exchangePositions: Array<{ coin: string; size: number; entryPrice: number }>,
    dbPositions: Array<{ coin: string; positionId: string; side: string }>,
  ): void {
    // 1. Exchange-authoritative: trust exchange state over DB
    for (const pos of exchangePositions) {
      if (Math.abs(pos.size) > 0) {
        const ctx = this.getOrCreateCoinContext(pos.coin)
        ctx.state = 'IN_POSITION'
        // positionId from DB if exists, otherwise mark as orphan
        const dbMatch = dbPositions.find(p => p.coin === pos.coin)
        ctx.positionId = dbMatch?.positionId ?? `orphan-${pos.coin}`
        ctx.stateEnteredAt = Date.now()
        this.coins.set(pos.coin, ctx)
      }
    }

    // 2. DB positions not on exchange → mark as closed (missed exit)
    for (const dbPos of dbPositions) {
      const onExchange = exchangePositions.some(p => p.coin === dbPos.coin && Math.abs(p.size) > 0)
      if (!onExchange) {
        const ctx = this.getOrCreateCoinContext(dbPos.coin)
        ctx.state = 'IDLE'
        ctx.positionId = null
        ctx.activeSetup = null
        this.coins.set(dbPos.coin, ctx)
        this.emitter.emit('action', journalAction('exit', dbPos.coin, {
          reason: 'crash_recovery_closed',
          positionId: dbPos.positionId,
        }))
      }
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Get snapshot for API. */
  getSnapshot(): AgentSnapshot {
    const coins: AgentSnapshot['coins'] = {}
    const now = Date.now()
    for (const [coin, ctx] of this.coins) {
      coins[coin] = {
        state: ctx.state,
        activeSetup: ctx.activeSetup,
        pendingOrderId: ctx.pendingOrderId,
        positionId: ctx.positionId,
        consecutiveLosses: ctx.consecutiveLosses,
        stateAge: now - ctx.stateEnteredAt,
      }
    }
    return {
      coins,
      global: {
        dailyPnl: this.global.dailyPnl,
        totalConsecutiveLosses: this.global.totalConsecutiveLosses,
        globalPaused: this.global.globalPaused,
        globalPauseReason: this.global.globalPauseReason,
        uptime: now - this.global.startedAt,
      },
    }
  }

  /** Get state for a specific coin. */
  getCoinState(coin: string): AgentState {
    return this.coins.get(coin)?.state ?? 'IDLE'
  }

  /** Get full coin context (for invalidation bridge setup ID matching). */
  getCoinContext(coin: string): Readonly<CoinContext> | null {
    return this.coins.get(coin) ?? null
  }

  /** Get coins that are currently in position or entering (for correlation guard S12). */
  getOpenPositionCoins(): string[] {
    const coins: string[] = []
    for (const [coin, ctx] of this.coins) {
      if (ctx.state === 'IN_POSITION' || ctx.state === 'ENTERING') {
        coins.push(coin)
      }
    }
    return coins
  }

  /** Get global context (for circuit breakers, risk management). */
  getGlobal(): Readonly<GlobalContext> {
    return this.global
  }

  /** Subscribe to agent actions (for orchestrator in S6/S7). */
  onAction(listener: (action: AgentAction) => void): void {
    this.emitter.on('action', listener)
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getOrCreateCoinContext(coin: string): CoinContext {
    const existing = this.coins.get(coin)
    if (existing) return existing
    const ctx: CoinContext = {
      state: 'IDLE',
      coin,
      activeSetup: null,
      pendingOrderId: null,
      positionId: null,
      stateEnteredAt: Date.now(),
      consecutiveLosses: 0,
      pauseReason: null,
      pauseUntil: null,
    }
    this.coins.set(coin, ctx)
    return ctx
  }

  private applyContextUpdate(ctx: CoinContext, action: AgentAction, event: AgentEvent): void {
    if (action.type === 'watch' || (action.type === 'log_journal' && action.eventType === 'signal')) {
      if (action.type === 'watch') {
        ctx.activeSetup = action.setup
      }
    }

    if (event.type === 'order_filled') {
      ctx.pendingOrderId = null
      ctx.positionId = event.positionId
    }

    if (event.type === 'order_rejected' || event.type === 'order_timeout') {
      ctx.pendingOrderId = null
      ctx.activeSetup = null
    }

    if (event.type === 'setup_invalidated') {
      if (ctx.state === 'IDLE' || ctx.state === 'WATCHING') {
        ctx.activeSetup = null
      }
    }

    if (event.type === 'position_closed' || event.type === 'sl_hit' ||
        event.type === 'tp_hit' || event.type === 'trail_stop_hit') {
      const pnl = 'pnl' in event ? event.pnl : 0
      if (pnl < 0) {
        ctx.consecutiveLosses++
      } else {
        ctx.consecutiveLosses = 0
      }
      ctx.positionId = null
      ctx.activeSetup = null
    }

    if (event.type === 'pause' || event.type === 'circuit_break') {
      ctx.pauseReason = event.reason
      ctx.pauseUntil = event.type === 'circuit_break' ? event.pauseUntil : null
    }

    if (event.type === 'resume') {
      ctx.pauseReason = null
      ctx.pauseUntil = null
      ctx.activeSetup = null
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function journalAction(eventType: string, coin: string, details: Record<string, unknown>): AgentAction {
  return { type: 'log_journal', eventType, coin, details }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let agentInstance: TradingAgent | null = null

/** Get or create the singleton agent. */
export function getAgent(): TradingAgent {
  if (!agentInstance) {
    agentInstance = new TradingAgent()
  }
  return agentInstance
}

/** Reset agent (tests only). */
export function resetAgent(): void {
  agentInstance = null
}
