/**
 * Trading Orchestrator — extracted from trading-agent.ts (E28).
 *
 * Sprint 4.5: Per-strategy state isolation.
 *   - State map keyed by `coin:strategyId` (V2)
 *   - Per-strategy GlobalContext (V6) — each strategy has own dailyPnl, circuit breakers
 *   - Cross-strategy allowed (V7) — same coin can be traded by different strategies
 *
 * Pure handlers remain in trading-agent.ts. This file owns the orchestrator class.
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
  GlobalSnapshotEntry,
} from './types.js'
import { handlers } from './trading-agent.js'
import { runAllChecks, prunePnlHistory } from './circuit-breakers.js'
import { shouldBlockCorrelatedEntry } from './correlation-guard.js'
import { checkPortfolioEntry, type PortfolioPosition } from './portfolio-risk.js'
import { DEFAULT_RISK_PERCENT } from '../config.js'
import { log } from '../lib/logger.js'

/** Default strategy ID for backward compatibility (single-strategy mode). */
const DEFAULT_STRATEGY = 'layered'

// ─── State Key Helpers ──────────────────────────────────────────────────────

/** Build state map key from coin + strategyId. */
export function stateKey(coin: string, strategyId: string = DEFAULT_STRATEGY): string {
  return `${coin}:${strategyId}`
}

/** Parse state map key back to coin + strategyId. */
export function parseStateKey(key: string): { coin: string; strategyId: string } {
  const idx = key.lastIndexOf(':')
  if (idx === -1) return { coin: key, strategyId: DEFAULT_STRATEGY }
  return { coin: key.slice(0, idx), strategyId: key.slice(idx + 1) }
}

// ─── Trading Agent (Orchestrator) ───────────────────────────────────────────

export class TradingAgent {
  /** Per-coin-strategy state: keyed by `coin:strategyId`. */
  private coins: Map<string, CoinContext> = new Map()
  /** Per-strategy global context. */
  private globals: Map<string, GlobalContext> = new Map()
  private emitter = new EventEmitter()
  private tradeCloseListeners: Array<(coin: string, pnl: number) => void> = []
  private startedAt: number
  /** Shared account equity for portfolio risk checks (updated by position monitor). */
  private accountEquity = 0

  constructor() {
    this.startedAt = Date.now()
    // Initialize default strategy global
    this.getOrCreateGlobal(DEFAULT_STRATEGY)
  }

  /** Set account equity (called by position monitor / exchange sync). */
  setAccountEquity(equity: number): void {
    this.accountEquity = equity
  }

  /** Get current account equity. */
  getAccountEquity(): number {
    return this.accountEquity
  }

  // ── Per-Strategy Global Context ─────────────────────────────────────────

  /** Get or create GlobalContext for a strategy. */
  private getOrCreateGlobal(strategyId: string): GlobalContext {
    const existing = this.globals.get(strategyId)
    if (existing) return existing
    const g: GlobalContext = {
      dailyPnl: 0,
      peakAccountValue: 0,
      totalConsecutiveLosses: 0,
      lastTradeTime: 0,
      globalPaused: false,
      globalPauseReason: null,
      startedAt: this.startedAt,
      pnlHistory: [],
    }
    this.globals.set(strategyId, g)
    return g
  }

  /** Get strategy's global context (read-only). */
  getStrategyGlobal(strategyId: string): Readonly<GlobalContext> {
    return this.getOrCreateGlobal(strategyId)
  }

  // ── Pipeline Integration (R10) ───────────────────────────────────────────

  subscribeToPipeline(pipelineEmitter: EventEmitter): void {
    pipelineEmitter.on('setup', (setup: ActiveSetup) => {
      this.onSetup(setup)
    })
  }

  /** Handle incoming setup from pipeline. */
  onSetup(setup: ActiveSetup): void {
    const strategyId = setup.strategyId ?? DEFAULT_STRATEGY
    const key = stateKey(setup.coin, strategyId)
    const coinState = this.getCoinStateByKey(key)

    // Guard: skip if coin+strategy already has a pending order or is mid-entry.
    // Without this, the pipeline re-detects the same setup every tick and spams
    // IDLE → ENTERING → order_rejected → IDLE cycles against the DB idempotency guard.
    const ctx = this.coins.get(key)
    if (ctx && (ctx.pendingOrderId || ctx.state === 'ENTERING')) {
      return  // silent — duplicate setup noise is not worth logging every tick
    }

    // S12: Anti-correlation guard
    if (coinState === 'IDLE' || coinState === 'WATCHING') {
      const openCoins = this.getOpenPositionCoins()
      const check = shouldBlockCorrelatedEntry(setup.coin, openCoins)
      if (check.blocked) {
        const strategyTag = strategyId !== DEFAULT_STRATEGY ? ` [${strategyId}]` : ''
        log.info('agent', `${setup.coin.padEnd(8)} SKIP correlation guard: ${check.reason}${strategyTag}`)
        this.emitter.emit('action', journalAction('skip', setup.coin, {
          reason: check.reason,
          setupId: setup.id,
          blockedGroups: check.blockedGroups,
          strategyId,
        }))
        return
      }
    }

    this.dispatch(setup.coin, { type: 'setup_detected', setup }, strategyId)
  }

  // ── Event Dispatch ───────────────────────────────────────────────────────

  /** Dispatch an event to a coin+strategy state machine. */
  dispatch(coin: string, event: AgentEvent, strategyId: string = DEFAULT_STRATEGY): import('./types.js').TransitionResult {
    const key = stateKey(coin, strategyId)
    const ctx = this.getOrCreateCoinContext(key, coin, strategyId)
    const global = this.getOrCreateGlobal(strategyId)
    const prevState = ctx.state
    const handler = handlers[ctx.state]
    const result = handler(ctx, event, global)
    const strategyTag = strategyId !== DEFAULT_STRATEGY ? ` [${strategyId}]` : ''

    // Apply transition
    if (result.nextState !== prevState) {
      ctx.stateEnteredAt = Date.now()

      const setup = ctx.activeSetup ?? (event.type === 'setup_detected' ? event.setup : null)
      const detail = setup ? ` | ${setup.type} ${setup.side}` : ''
      const reason = event.type === 'setup_invalidated' ? ` | reason: ${event.reason}` : ''
      log.info('agent', `${coin.padEnd(8)} ${prevState} → ${result.nextState}${detail}${reason}${strategyTag}`)
    }
    ctx.state = result.nextState

    // Portfolio risk check: block place_order if over-exposed (S6)
    const filteredActions = this.filterByPortfolioRisk(result.actions, coin, strategyId, ctx)
    if (filteredActions !== result.actions) {
      // place_order was blocked — stay IDLE when entry was direct from IDLE (no watch/activeSetup)
      ctx.state = prevState === 'IDLE' ? 'IDLE' : prevState
      result.nextState = ctx.state
    }

    // Log every skip journal (including portfolio-blocked and handler-emitted skips)
    for (const action of filteredActions) {
      if (action.type === 'log_journal' && action.eventType === 'skip') {
        const r = action.details?.reason
        const reason = typeof r === 'string' && r.length > 0 ? r : '(reason missing)'
        log.info('agent', `${coin.padEnd(8)} SKIP ${reason}${strategyTag}`)
      }
    }

    // Apply event-driven context updates (once per dispatch — must run even when filteredActions is empty)
    this.applyEventContext(ctx, event)
    // Apply action-driven context updates
    for (const action of filteredActions) {
      this.applyActionContext(ctx, action)
    }

    // Emit actions for orchestrator (S6/S7)
    for (const action of filteredActions) {
      this.emitter.emit('action', action)
    }

    this.coins.set(key, ctx)
    return result
  }

  /** Dispatch event to all coins (e.g., tick, global pause). */
  dispatchAll(event: AgentEvent): void {
    for (const [key] of this.coins) {
      const { coin, strategyId } = parseStateKey(key)
      this.dispatch(coin, event, strategyId)
    }
  }

  /** Tick all coins — check timeouts, cooldowns. */
  tick(): void {
    this.dispatchAll({ type: 'tick' })
  }

  // ── Global Controls ──────────────────────────────────────────────────────

  /** Emergency pause all strategies. */
  pauseAll(reason: string): void {
    for (const [, g] of this.globals) {
      g.globalPaused = true
      g.globalPauseReason = reason
    }
    this.dispatchAll({ type: 'pause', reason })
  }

  /** Resume all strategies. */
  resumeAll(): void {
    for (const [, g] of this.globals) {
      g.globalPaused = false
      g.globalPauseReason = null
    }
    this.dispatchAll({ type: 'resume' })
  }

  /** Pause a specific strategy only. */
  pauseStrategy(strategyId: string, reason: string): void {
    const g = this.getOrCreateGlobal(strategyId)
    g.globalPaused = true
    g.globalPauseReason = reason
    for (const [key] of this.coins) {
      const parsed = parseStateKey(key)
      if (parsed.strategyId === strategyId) {
        this.dispatch(parsed.coin, { type: 'pause', reason }, strategyId)
      }
    }
  }

  /** Resume a specific strategy only. */
  resumeStrategy(strategyId: string): void {
    const g = this.getOrCreateGlobal(strategyId)
    g.globalPaused = false
    g.globalPauseReason = null
    for (const [key] of this.coins) {
      const parsed = parseStateKey(key)
      if (parsed.strategyId === strategyId) {
        this.dispatch(parsed.coin, { type: 'resume' }, strategyId)
      }
    }
  }

  /**
   * Update daily PnL + pnlHistory for a strategy.
   * Runs circuit breaker checks after recording. If tripped, pauses
   * non-IN_POSITION coins for that strategy only (R5).
   */
  recordPnl(pnl: number, accountValue?: number, coin?: string, strategyId: string = DEFAULT_STRATEGY): void {
    const now = Date.now()
    const g = this.getOrCreateGlobal(strategyId)
    g.dailyPnl += pnl
    g.lastTradeTime = now
    g.pnlHistory.push({ ts: now, pnl })

    if (pnl < 0) {
      g.totalConsecutiveLosses++
    } else {
      g.totalConsecutiveLosses = 0
    }

    if (accountValue !== undefined && accountValue > g.peakAccountValue) {
      g.peakAccountValue = accountValue
    }

    if (accountValue !== undefined) {
      this.checkCircuitBreakers(accountValue, now, strategyId)
    }

    if (coin) {
      for (const listener of this.tradeCloseListeners) {
        try { listener(coin, pnl) } catch { /* listeners must not crash agent */ }
      }
    }
  }

  /** Reset daily PnL for all strategies (called at UTC midnight). */
  resetDailyPnl(): void {
    for (const [, g] of this.globals) {
      g.dailyPnl = 0
    }
  }

  /** Update account value for a strategy. */
  updateAccountValue(accountValue: number, strategyId: string = DEFAULT_STRATEGY): void {
    const g = this.getOrCreateGlobal(strategyId)
    if (accountValue > g.peakAccountValue) {
      g.peakAccountValue = accountValue
    }
  }

  /**
   * Run circuit breaker checks for a specific strategy.
   * If tripped, pause only that strategy's non-IN_POSITION coins (R5).
   */
  checkCircuitBreakers(accountValue: number, now: number = Date.now(), strategyId: string = DEFAULT_STRATEGY): void {
    const g = this.getOrCreateGlobal(strategyId)
    g.pnlHistory = prunePnlHistory(g.pnlHistory, now)

    const result = runAllChecks({
      dailyPnl: g.dailyPnl,
      accountValue,
      peakAccountValue: g.peakAccountValue,
      consecutiveLosses: g.totalConsecutiveLosses,
      pnlHistory: g.pnlHistory,
      now,
    })

    if (result.tripped && !g.globalPaused) {
      const strategyTag = strategyId !== DEFAULT_STRATEGY ? ` [${strategyId}]` : ''
      log.warn('agent', `CIRCUIT BREAK${strategyTag} | ${result.reason} | dailyPnl=$${g.dailyPnl.toFixed(2)} | pause until ${result.pauseUntil ? new Date(result.pauseUntil).toISOString().slice(11, 19) : 'manual resume'}`)

      g.globalPaused = true
      g.globalPauseReason = result.reason

      // Dispatch circuit_break to this strategy's coins NOT in position (R5)
      for (const [key, ctx] of this.coins) {
        const parsed = parseStateKey(key)
        if (parsed.strategyId === strategyId && ctx.state !== 'IN_POSITION') {
          this.dispatch(parsed.coin, {
            type: 'circuit_break',
            reason: result.reason!,
            pauseUntil: result.pauseUntil,
          }, strategyId)
        }
      }

      this.emitter.emit('action', {
        type: 'log_journal',
        eventType: 'circuit_break',
        coin: '*',
        details: {
          reason: result.reason,
          pauseUntil: result.pauseUntil,
          dailyPnl: g.dailyPnl,
          accountValue,
          peakAccountValue: g.peakAccountValue,
          strategyId,
        },
      })
    }
  }

  // ── Crash Recovery Skeleton (R1) ─────────────────────────────────────────

  recoverFromCrash(
    exchangePositions: Array<{ coin: string; size: number; entryPrice: number }>,
    dbPositions: Array<{ coin: string; positionId: string; side: string; strategyId?: string }>,
  ): void {
    for (const pos of exchangePositions) {
      if (Math.abs(pos.size) > 0) {
        const dbMatch = dbPositions.find(p => p.coin === pos.coin)
        const strategyId = dbMatch?.strategyId ?? DEFAULT_STRATEGY
        const key = stateKey(pos.coin, strategyId)
        const ctx = this.getOrCreateCoinContext(key, pos.coin, strategyId)
        ctx.state = 'IN_POSITION'
        ctx.positionId = dbMatch?.positionId ?? `orphan-${pos.coin}`
        ctx.stateEnteredAt = Date.now()
        this.coins.set(key, ctx)
      }
    }

    for (const dbPos of dbPositions) {
      const onExchange = exchangePositions.some(p => p.coin === dbPos.coin && Math.abs(p.size) > 0)
      if (!onExchange) {
        const strategyId = dbPos.strategyId ?? DEFAULT_STRATEGY
        const key = stateKey(dbPos.coin, strategyId)
        const ctx = this.getOrCreateCoinContext(key, dbPos.coin, strategyId)
        ctx.state = 'IDLE'
        ctx.positionId = null
        ctx.activeSetup = null
        this.coins.set(key, ctx)
        this.emitter.emit('action', journalAction('exit', dbPos.coin, {
          reason: 'crash_recovery_closed',
          positionId: dbPos.positionId,
          strategyId,
        }))
      }
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Get snapshot for API (backward-compat: aggregates across strategies). */
  getSnapshot(): AgentSnapshot {
    const coins: AgentSnapshot['coins'] = {}
    const now = Date.now()
    for (const [key, ctx] of this.coins) {
      coins[key] = {
        state: ctx.state,
        activeSetup: ctx.activeSetup,
        pendingOrderId: ctx.pendingOrderId,
        positionId: ctx.positionId,
        consecutiveLosses: ctx.consecutiveLosses,
        stateAge: now - ctx.stateEnteredAt,
        strategyId: ctx.strategyId,
      }
    }

    const defaultGlobal = this.getOrCreateGlobal(DEFAULT_STRATEGY)
    const strategyGlobals: Record<string, GlobalSnapshotEntry> = {}
    for (const [sid, g] of this.globals) {
      strategyGlobals[sid] = {
        dailyPnl: g.dailyPnl,
        totalConsecutiveLosses: g.totalConsecutiveLosses,
        globalPaused: g.globalPaused,
        globalPauseReason: g.globalPauseReason,
        uptime: now - g.startedAt,
      }
    }

    return {
      coins,
      global: {
        dailyPnl: defaultGlobal.dailyPnl,
        totalConsecutiveLosses: defaultGlobal.totalConsecutiveLosses,
        globalPaused: defaultGlobal.globalPaused,
        globalPauseReason: defaultGlobal.globalPauseReason,
        uptime: now - defaultGlobal.startedAt,
      },
      strategyGlobals,
    }
  }

  /** Get state for a specific coin+strategy. Defaults to 'layered'. */
  getCoinState(coin: string, strategyId: string = DEFAULT_STRATEGY): AgentState {
    const key = stateKey(coin, strategyId)
    return this.coins.get(key)?.state ?? 'IDLE'
  }

  /** Get full coin context (for invalidation bridge setup ID matching). */
  getCoinContext(coin: string, strategyId: string = DEFAULT_STRATEGY): Readonly<CoinContext> | null {
    const key = stateKey(coin, strategyId)
    return this.coins.get(key) ?? null
  }

  /** Get coins that are currently in position or entering (across ALL strategies). */
  getOpenPositionCoins(): string[] {
    const coins: string[] = []
    for (const [, ctx] of this.coins) {
      if (ctx.state === 'IN_POSITION' || ctx.state === 'ENTERING') {
        if (!coins.includes(ctx.coin)) {
          coins.push(ctx.coin)
        }
      }
    }
    return coins
  }

  /** Get global context for default strategy (backward compat). */
  getGlobal(): Readonly<GlobalContext> {
    return this.getOrCreateGlobal(DEFAULT_STRATEGY)
  }

  /** Subscribe to agent actions (for orchestrator in S6/S7). */
  onAction(listener: (action: AgentAction) => void): void {
    this.emitter.on('action', listener)
  }

  /** Subscribe to trade close events (for metrics refresh). */
  onTradeClose(listener: (coin: string, pnl: number) => void): void {
    this.tradeCloseListeners.push(listener)
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getOrCreateCoinContext(key: string, coin: string, strategyId: string): CoinContext {
    const existing = this.coins.get(key)
    if (existing) return existing
    const ctx: CoinContext = {
      state: 'IDLE',
      coin,
      strategyId,
      activeSetup: null,
      pendingOrderId: null,
      positionId: null,
      stateEnteredAt: Date.now(),
      consecutiveLosses: 0,
      pauseReason: null,
      pauseUntil: null,
    }
    this.coins.set(key, ctx)
    return ctx
  }

  /** Apply event-driven context mutations. Called once per dispatch, regardless of action count. */
  private applyEventContext(ctx: CoinContext, event: AgentEvent): void {
    if (event.type === 'order_submitted') {
      ctx.pendingOrderId = event.orderId
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
      // Update global dailyPnl + circuit breakers
      this.recordPnl(pnl, undefined, ctx.coin, ctx.strategyId)
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

  /** Apply action-driven context mutations. Called once per emitted action. */
  private applyActionContext(ctx: CoinContext, action: AgentAction): void {
    if (action.type === 'watch' || action.type === 'place_order') {
      ctx.activeSetup = action.setup
    }
  }

  /**
   * Filter place_order actions through portfolio risk check (S6).
   * Returns original array if no place_order, or filtered array if blocked.
   */
  private filterByPortfolioRisk(
    actions: AgentAction[],
    coin: string,
    strategyId: string,
    ctx: CoinContext,
  ): AgentAction[] {
    const hasPlaceOrder = actions.some(a => a.type === 'place_order')
    if (!hasPlaceOrder || this.accountEquity <= 0) return actions

    // Build current portfolio positions from IN_POSITION/ENTERING coins.
    // Exclude the current coin:strategy — ctx.state was already set to ENTERING before this check,
    // so it would otherwise count against itself (off-by-one: effective max becomes max-1).
    const portfolioPositions = this.getPortfolioPositions()
      .filter(p => !(p.coin === coin && p.strategyId === strategyId))

    // Estimate proposed notional from setup (use risk per trade × account as fallback)
    const placeAction = actions.find(a => a.type === 'place_order')
    // Use a conservative estimate: account equity × risk per trade as proposed notional
    // Real notional will be computed by PositionSizer in S7, but we need an estimate here
    const proposedNotional = this.accountEquity * DEFAULT_RISK_PERCENT

    const check = checkPortfolioEntry({
      positions: portfolioPositions,
      accountEquity: this.accountEquity,
      strategyId,
      proposedNotional,
    })

    if (!check.allowed) {
      // Replace place_order with skip journal entry, keep other actions (dispatch logs SKIP line)
      return [
        ...actions.filter(a => a.type !== 'place_order'),
        journalAction('skip', coin, {
          reason: `portfolio risk: ${check.reason}`,
          strategyId,
          setupId: ctx.activeSetup?.id,
        }),
      ]
    }

    return actions
  }

  /** Build portfolio positions from current IN_POSITION/ENTERING coins. */
  private getPortfolioPositions(): PortfolioPosition[] {
    const positions: PortfolioPosition[] = []
    for (const [, ctx] of this.coins) {
      if (ctx.state === 'IN_POSITION' || ctx.state === 'ENTERING') {
        // Estimate notional as accountEquity × DEFAULT_RISK_PERCENT per position
        // Real notional tracked by PositionMonitor in S7
        positions.push({
          coin: ctx.coin,
          strategyId: ctx.strategyId,
          notionalValue: this.accountEquity * DEFAULT_RISK_PERCENT,
        })
      }
    }
    return positions
  }

  /** Get state by full key (internal). */
  private getCoinStateByKey(key: string): AgentState {
    return this.coins.get(key)?.state ?? 'IDLE'
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
