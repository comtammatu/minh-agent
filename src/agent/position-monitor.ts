/**
 * Position Monitor (Sprint 2 S7).
 *
 * Responsibilities:
 *   - Trail stop: activate after +1% profit, trail 0.5% below peak, dispatch update_stop
 *   - Partial close: close 50% at 1R, move SL to breakeven
 *   - Exchange-sync heartbeat (R3): poll HL clearinghouseState every ~10s
 *     → detect liquidation, external close, missed fills
 *
 * Design:
 *   - Pure monitor logic in `evaluatePosition()` — returns MonitorAction[]
 *   - I/O in class methods: exchange sync, interval management
 *   - PositionState tracks trailing state + partial close progress per position
 *   - Exchange sync stubbed until S10 (same pattern as order-manager)
 */

import type {
  PositionState,
  MonitorAction,
  ExchangePositionSnapshot,
  AgentEvent,
} from './types.js'
import {
  computeTrailingStop,
  isTrailingStopHit,
  computePartialCloseLevels,
  getDefaultTrailingConfig,
  getDefaultPartialCloseConfig,
} from './exits.js'
import type { TrailingStopState } from './exits.js'
import type { SignalSide } from '../types.js'
import {
  EXCHANGE_SYNC_INTERVAL_MS,
  PAPER_WALLET_STRATEGY_IDS,
  TRAIL_UPDATE_THRESHOLD,
  tryGetActiveExchange,
} from '../config.js'
import { getHLExchangeService as getExchangeService } from '../execution/hl-exchange-service.js'
import type { IExchangeService as ExchangeService, AccountState } from '../execution/exchange-service.js'
import { getExchangePool, type IExchangeService as PoolExchangeService } from '../execution/exchange-pool.js'
import { log } from '../lib/logger.js'
import { getEffectivePaperTrade, PAPER_SLIPPAGE_PCT } from '../config.js'
import { getPaperTracker, getTotalPaperBalance } from './paper-tracker.js'
import { getOrderManager } from './order-manager.js'

// ─── Exchange Query (S10: real HL clearinghouseState) ──────────────────────

function isBybitLiveMode(): boolean {
  if (getEffectivePaperTrade()) return false
  return tryGetActiveExchange() === 'BB'
}

/**
 * Query exchange for current positions via ExchangeService.
 * Returns ExchangePositionSnapshot[] on success, null on API/network error.
 * Callers must treat null as "skip reconciliation" to avoid false position closes.
 */
export async function queryExchangePositions(): Promise<ExchangePositionSnapshot[] | null> {
  try {
    if (getEffectivePaperTrade()) return []

    const pool = getExchangePool()
    if (!pool.isInitialized()) {
      if (isBybitLiveMode()) {
        throw new Error('PositionMonitor: ExchangePool must be initialized in BB live mode (HL fallback blocked)')
      }
      return await getExchangeService().getPositions()
    }

    // Single shared HL account: one clearinghouse query (snapshots have no strategyId).
    if (!pool.isMultiWallet()) {
      return await pool.getShared().getPositions()
    }

    // One main account per strategy: query each wallet and tag rows for reconciliation.
    const out: ExchangePositionSnapshot[] = []
    for (const sid of PAPER_WALLET_STRATEGY_IDS) {
      const snaps = await pool.get(sid).getPositions()
      for (const s of snaps) {
        out.push({ ...s, strategyId: sid })
      }
    }
    return out
  } catch (err) {
    log.error('position-monitor', `queryExchangePositions failed: ${err instanceof Error ? err.message : err}`)
    return null  // null = API error; caller skips reconciliation to avoid false position closes
  }
}

// ─── Pure Monitor Logic ─────────────────────────────────────────────────────

/**
 * Evaluate a position and return actions to take.
 * Pure function — no I/O, no side effects. Caller executes actions.
 *
 * Check order: trail stop hit → partial close → trail update → hold
 */
export function evaluatePosition(
  position: PositionState,
  currentPrice: number,
): MonitorAction[] {
  if (currentPrice <= 0) return [{ type: 'hold' }]

  const actions: MonitorAction[] = []
  const side = position.side

  // 1. Compute trailing stop state
  const trailingConfig = getDefaultTrailingConfig()
  const newTrailingState = computeTrailingStop(
    side,
    position.entryPrice,
    currentPrice,
    position.trailingState,
    trailingConfig,
  )

  // 2. Check if trailing stop HIT → close position
  if (newTrailingState.active && isTrailingStopHit(side, currentPrice, newTrailingState)) {
    actions.push({
      type: 'close',
      positionId: position.positionId,
      reason: `trail_stop_hit @ ${currentPrice.toFixed(2)} (trail=${newTrailingState.currentStopPrice.toFixed(2)})`,
    })
    return actions  // trailing stop hit takes priority — close immediately
  }

  // 3. Check partial close levels
  const partialConfig = getDefaultPartialCloseConfig()
  const levels = computePartialCloseLevels(
    side,
    position.entryPrice,
    position.slPrice,
    partialConfig,
  )

  for (let i = 0; i < levels.length; i++) {
    if (position.partialClosesFired.includes(i)) continue  // already fired

    const level = levels[i]!
    const hit = side === 'long'
      ? currentPrice >= level.targetPrice
      : currentPrice <= level.targetPrice

    if (hit) {
      actions.push({
        type: 'partial_close',
        positionId: position.positionId,
        closePct: level.closePct,
        ...(level.newSlPrice !== undefined ? { newSlPrice: level.newSlPrice } : {}),
      })
      // Only fire one partial close per tick to avoid cascading
      break
    }
  }

  // 4. Check if trailing stop needs SL update on exchange
  //    Skip if partial close already fired this tick (breakeven SL takes priority)
  const hasPartialClose = actions.some(a => a.type === 'partial_close')
  if (!hasPartialClose && newTrailingState.active && newTrailingState.currentStopPrice > 0) {
    const prevStop = position.trailingState?.currentStopPrice ?? 0
    const changePct = prevStop > 0
      ? Math.abs(newTrailingState.currentStopPrice - prevStop) / prevStop
      : 1  // first activation always sends update

    if (changePct >= TRAIL_UPDATE_THRESHOLD) {
      actions.push({
        type: 'trail_update',
        positionId: position.positionId,
        newSlPrice: newTrailingState.currentStopPrice,
      })
    }
  }

  if (actions.length === 0) {
    actions.push({ type: 'hold' })
  }

  return actions
}

/**
 * Reconcile tracked positions with exchange snapshots.
 * Returns actions for positions that disappeared (liquidation, external close).
 * Pure function — no I/O.
 */
export function reconcilePositions(
  tracked: Map<string, PositionState>,
  exchangeSnapshots: ExchangePositionSnapshot[],
): MonitorAction[] {
  const actions: MonitorAction[] = []
  const exchangeCoins = new Set(exchangeSnapshots.map(s => s.coin))

  for (const [, pos] of tracked) {
    // Match by coin; when rows are tagged with strategyId, require it as well.
    const snap = exchangeSnapshots.find(s => {
      if (s.coin !== pos.coin) return false
      if (s.strategyId !== undefined && s.strategyId !== pos.strategyId) return false
      return true
    })

    if (!snap || snap.size === 0) {
      // Position gone on exchange — liquidation or external close
      actions.push({
        type: 'close',
        positionId: pos.positionId,
        reason: snap ? 'exchange_position_closed' : 'exchange_position_not_found',
      })
    } else {
      // Position exists — check for size mismatch (external partial close)
      const exchangeSize = Math.abs(snap.size)
      if (exchangeSize < pos.currentSize * 0.95) {
        // Significant size reduction — external partial close
        actions.push({
          type: 'alert',
          positionId: pos.positionId,
          message: `Size mismatch: tracked=${pos.currentSize.toFixed(4)} exchange=${exchangeSize.toFixed(4)}`,
        })
      }
    }
  }

  return actions
}

// ─── PositionMonitor Class ──────────────────────────────────────────────────

/** Default strategy ID for backward compatibility. */
const DEFAULT_STRATEGY = 'smc-sd'

export class PositionMonitor {
  /** Tracked open positions — keyed by positionId. */
  private positions: Map<string, PositionState> = new Map()
  /** Exchange sync interval handle. */
  private syncInterval: ReturnType<typeof setInterval> | null = null
  /** Guard against concurrent syncWithExchange calls (setInterval fires even if previous async call hasn't resolved). */
  private syncInProgress = false
  /** Callback to dispatch events to TradingAgent (with strategyId). */
  private dispatchToAgent: ((coin: string, event: AgentEvent, strategyId?: string) => void) | null = null
  /** Callback to update SL on exchange via OrderManager (parentOrderId, newSlPrice). */
  private onUpdateStop: ((parentOrderId: string, newSlPrice: number) => void) | null = null
  /** Callback to update account equity on TradingAgent. */
  private onEquityUpdate: ((equity: number) => void) | null = null
  /** Callback to get current mark price for a coin (paper mode SL/TP checks). */
  private priceGetter: ((coin: string) => number | null) | null = null
  /** Cached exchange position snapshots from last syncWithExchange (TUI reuse — avoids duplicate API calls). */
  private lastExchangeSnapshots: ExchangePositionSnapshot[] | null = null
  /** Cached account state from last syncWithExchange (TUI reuse — avoids duplicate API calls). */
  private lastAccountState: AccountState | null = null

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent, strategyId?: string) => void): void {
    this.dispatchToAgent = fn
  }

  /** Set the callback for SL updates via OrderManager.modifySLPrice. */
  setUpdateStopCallback(fn: (parentOrderId: string, newSlPrice: number) => void): void {
    this.onUpdateStop = fn
  }

  /** Set the callback for updating account equity (Sprint 4.5: portfolio risk). */
  setEquityCallback(fn: (equity: number) => void): void {
    this.onEquityUpdate = fn
  }

  /**
   * Set the callback to get current mark price for a coin.
   * Required for paper mode SL/TP simulation.
   * Wired in index.ts via getLatestAssetCtx().
   */
  setPriceGetter(fn: (coin: string) => number | null): void {
    this.priceGetter = fn
  }

  // ── Position Lifecycle ────────────────────────────────────────────────

  /** Register a new position for monitoring (called on order fill). */
  openPosition(params: {
    positionId: string
    coin: string
    side: 'long' | 'short'
    entryPrice: number
    size: number
    slPrice: number
    tpPrice: number
    entryOrderId: string
    leverage: number
    strategyId?: string
  }): PositionState {
    const state: PositionState = {
      positionId: params.positionId,
      coin: params.coin,
      side: params.side,
      entryPrice: params.entryPrice,
      currentSize: params.size,
      originalSize: params.size,
      slPrice: params.slPrice,
      tpPrice: params.tpPrice,
      entryOrderId: params.entryOrderId,
      leverage: params.leverage,
      strategyId: params.strategyId ?? DEFAULT_STRATEGY,
      trailingState: null,
      partialClosesFired: [],
      lastSyncAt: Date.now(),
      openedAt: Date.now(),
    }
    this.positions.set(params.positionId, state)
    log.info('position-monitor', `Tracking position: ${params.coin} ${params.side} @ ${params.entryPrice} size=${params.size}`)
    return state
  }

  /** Remove a position from monitoring (called on close). */
  closePositionTracking(positionId: string): void {
    const pos = this.positions.get(positionId)
    if (pos) {
      log.info('position-monitor', `Stopped tracking: ${pos.coin} ${positionId}`)
      this.positions.delete(positionId)
    }
  }

  // ── Monitor Tick ──────────────────────────────────────────────────────

  /**
   * Run monitor evaluation for a specific position.
   * Called by agent tick or on price update.
   * Executes returned actions via OrderManager dispatch.
   */
  async monitorPosition(positionId: string, currentPrice: number): Promise<MonitorAction[]> {
    const pos = this.positions.get(positionId)
    if (!pos) return [{ type: 'hold' }]

    const actions = evaluatePosition(pos, currentPrice)

    for (const action of actions) {
      await this.executeAction(pos, action)
    }

    // Update trailing state (always, even if no action — tracks highestPrice)
    const trailingConfig = getDefaultTrailingConfig()
    pos.trailingState = computeTrailingStop(
      pos.side,
      pos.entryPrice,
      currentPrice,
      pos.trailingState,
      trailingConfig,
    )

    return actions
  }

  /** Execute a monitor action — dispatch to agent or order manager. */
  private async executeAction(pos: PositionState, action: MonitorAction): Promise<void> {
    switch (action.type) {
      case 'hold':
        break

      case 'trail_update':
        pos.slPrice = action.newSlPrice
        log.info('position-monitor', `Trail SL update: ${pos.coin} new SL @ ${action.newSlPrice.toFixed(2)}`)
        // Dispatch directly to OrderManager for SL modification on exchange
        this.onUpdateStop?.(pos.entryOrderId, action.newSlPrice)
        break

      case 'partial_close': {
        const levelIdx = this.findPartialCloseLevel(pos, action.closePct)
        if (levelIdx >= 0) {
          pos.partialClosesFired.push(levelIdx)
        }
        const closeSize = pos.currentSize * action.closePct
        pos.currentSize -= closeSize
        if (action.newSlPrice != null) {  // null and undefined both excluded
          pos.slPrice = action.newSlPrice
        }
        log.info('position-monitor', `Partial close: ${pos.coin} ${(action.closePct * 100).toFixed(0)}% (${closeSize.toFixed(4)} coins) remaining=${pos.currentSize.toFixed(4)}`)
        break
      }

      case 'close': {
        log.info('position-monitor', `Position close: ${pos.coin} reason=${action.reason}`)

        // Paper mode: compute P&L from tracker (entry recorded by OrderManager)
        let closePrice = 0
        let pnl = 0
        if (getEffectivePaperTrade()) {
          // Use trailing stop price as close price for trail hits, SL/TP for those triggers
          const trailPrice = pos.trailingState?.currentStopPrice ?? 0
          const estimatedClose = trailPrice > 0
            ? trailPrice
            : pos.slPrice  // fallback to SL as close estimate
          const slippageDir = (pos.side === 'long' ? -1 : 1)  // close side gets adverse slippage
          closePrice = estimatedClose * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
          const trade = getPaperTracker(pos.strategyId).recordExit(pos.entryOrderId, closePrice)
          if (trade) pnl = trade.pnl
        }

        // Determine PnL direction from reason for event type
        if (action.reason.startsWith('trail_stop_hit')) {
          this.dispatchToAgent?.(pos.coin, {
            type: 'trail_stop_hit',
            positionId: pos.positionId,
            closePrice,
            pnl,
          }, pos.strategyId)
        } else {
          this.dispatchToAgent?.(pos.coin, {
            type: 'position_closed',
            positionId: pos.positionId,
            closePrice,
            pnl,
            reason: action.reason,
          }, pos.strategyId)
        }
        break
      }

      case 'alert':
        log.warn('position-monitor', `ALERT ${pos.coin}: ${action.message}`)
        break
    }
  }

  /** Find which partial close level index matches a closePct. */
  private findPartialCloseLevel(pos: PositionState, closePct: number): number {
    const levels = computePartialCloseLevels(
      pos.side,
      pos.entryPrice,
      pos.slPrice,
    )
    return levels.findIndex(l => Math.abs(l.closePct - closePct) < 0.001)
  }

  // ── Exchange Sync (R3) ────────────────────────────────────────────────

  /** Start the exchange-sync heartbeat interval. */
  startSync(): void {
    if (this.syncInterval) return  // already running
    this.syncInterval = setInterval(() => {
      this.syncWithExchange().catch(err => {
        log.error('position-monitor', `Exchange sync error: ${err}`)
      })
    }, EXCHANGE_SYNC_INTERVAL_MS)
    log.info('position-monitor', `Exchange sync started (interval=${EXCHANGE_SYNC_INTERVAL_MS}ms)`)
  }

  /** Stop the exchange-sync heartbeat. */
  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
      log.info('position-monitor', 'Exchange sync stopped')
    }
  }

  /**
   * R3: Poll HL clearinghouseState → reconcile with tracked positions.
   * Detects: liquidation, external close, missed fills.
   */
  async syncWithExchange(): Promise<MonitorAction[]> {
    if (this.syncInProgress) return []
    this.syncInProgress = true
    try {
      // Update account equity for portfolio risk checks (even with 0 positions)
      try {
        if (getEffectivePaperTrade()) {
          // Paper: use simulated wallets — live HL balance would block portfolio logic incorrectly
          this.onEquityUpdate?.(getTotalPaperBalance())
        } else {
          const pool = getExchangePool()
          if (pool.isInitialized()) {
            if (pool.isMultiWallet()) {
              let sum = 0
              const seen = new Set<PoolExchangeService>()
              for (const sid of PAPER_WALLET_STRATEGY_IDS) {
                const svc = pool.get(sid)
                if (seen.has(svc)) continue
                seen.add(svc)
                const st = await svc.getAccountState()
                sum += st.effectiveBalance
              }
              this.onEquityUpdate?.(sum)
            } else {
              const st = await pool.getShared().getAccountState()
              this.lastAccountState = st
              this.onEquityUpdate?.(st.effectiveBalance)
            }
          } else {
            if (isBybitLiveMode()) {
              throw new Error('PositionMonitor: ExchangePool must be initialized in BB live mode (HL fallback blocked)')
            }
            const accountState = await getExchangeService().getAccountState()
            this.lastAccountState = accountState
            this.onEquityUpdate?.(accountState.effectiveBalance)
          }
        }
      } catch {
        // Non-fatal — equity update is best-effort
      }

      // Live: detect entry fills that were not inline in placeOrder (e.g. limit) → onOrderFilled → SL/TP (R9)
      if (!getEffectivePaperTrade()) {
        await getOrderManager().syncSubmittedEntryFills()
      }

      if (this.positions.size === 0) return []

      // Paper mode: simulate SL/TP hits using current mark prices instead of exchange query
      if (getEffectivePaperTrade()) {
        await this.checkPaperExits()
        return []
      }

      const snapshots = await queryExchangePositions()
      this.lastExchangeSnapshots = snapshots
      // null = API/network error — skip reconciliation to avoid false position closes
      if (snapshots === null) {
        log.warn('position-monitor', `getPositions API error — skipping reconciliation this cycle (${this.positions.size} position(s) still tracked)`)
        return []
      }

      const actions = reconcilePositions(this.positions, snapshots)

      for (const action of actions) {
        if (!('positionId' in action)) continue
        const pos = this.positions.get(action.positionId)
        if (pos) {
          await this.executeAction(pos, action)
          if (action.type === 'close') {
            this.positions.delete(pos.positionId)
          }
        }
      }

      // Update sync timestamps
      const now = Date.now()
      for (const [, pos] of this.positions) {
        pos.lastSyncAt = now
      }

      return actions
    } finally {
      this.syncInProgress = false
    }
  }

  // ── Paper SL/TP Simulation ────────────────────────────────────────────

  /**
   * Paper mode: check each tracked position against current mark price.
   * Fires sl_hit or tp_hit events when price crosses the respective level.
   * Called by syncWithExchange() every EXCHANGE_SYNC_INTERVAL_MS (10s).
   *
   * In live mode this is handled by HL trigger orders on exchange.
   * In paper mode those triggers are only simulated — this method replaces them.
   */
  private async checkPaperExits(): Promise<void> {
    if (this.positions.size === 0) return

    // Collect positions to close (avoid mutating map during iteration)
    const toClose: Array<{ pos: PositionState; reason: 'sl_hit' | 'tp_hit'; closePrice: number }> = []

    for (const [, pos] of this.positions) {
      // Skip positions managed by enhanced PaperTracker (multi-TP exits via orchestrator candle ticks)
      if (getPaperTracker(pos.strategyId).hasEnhancedPosition(pos.coin)) continue

      const markPrice = this.priceGetter?.(pos.coin)
      if (!markPrice || markPrice <= 0) continue

      const side = pos.side
      let closeReason: 'sl_hit' | 'tp_hit' | null = null
      let closePrice = 0

      // SL hit: adverse slippage (fills slightly worse than SL level)
      if ((side === 'long' && markPrice <= pos.slPrice) ||
          (side === 'short' && markPrice >= pos.slPrice)) {
        closeReason = 'sl_hit'
        const slippageDir = side === 'long' ? -1 : 1
        closePrice = pos.slPrice * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
      }
      // TP hit: fills at TP level (slight adverse for realism)
      else if ((side === 'long' && markPrice >= pos.tpPrice) ||
               (side === 'short' && markPrice <= pos.tpPrice)) {
        closeReason = 'tp_hit'
        const slippageDir = side === 'long' ? -1 : 1
        closePrice = pos.tpPrice * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
      }

      if (closeReason) {
        toClose.push({ pos, reason: closeReason, closePrice })
      }
    }

    for (const { pos, reason, closePrice } of toClose) {
      const trade = getPaperTracker(pos.strategyId).recordExit(pos.entryOrderId, closePrice)
      const pnl = trade?.pnl ?? 0
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
      log.info('position-monitor', `[PAPER] ${reason.toUpperCase()} | ${pos.coin} ${pos.side.toUpperCase()} | entry=${pos.entryPrice.toFixed(2)} close=${closePrice.toFixed(2)} | pnl=${pnlStr}`)

      this.dispatchToAgent?.(pos.coin, {
        type: reason,
        positionId: pos.positionId,
        closePrice,
        pnl,
      }, pos.strategyId)

      this.positions.delete(pos.positionId)
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /** Get a tracked position by ID. */
  getPosition(positionId: string): PositionState | null {
    return this.positions.get(positionId) ?? null
  }

  /** Get all tracked positions. */
  getPositions(): Map<string, PositionState> {
    return new Map(this.positions)
  }

  /** Get position by coin. */
  getPositionByCoin(coin: string): PositionState | null {
    for (const [, pos] of this.positions) {
      if (pos.coin === coin) return pos
    }
    return null
  }

  /** Check if sync interval is running. */
  isSyncRunning(): boolean {
    return this.syncInterval !== null
  }

  /** Get cached exchange position snapshots from last sync (TUI reuse). */
  getLastExchangeSnapshots(): ExchangePositionSnapshot[] | null {
    return this.lastExchangeSnapshots
  }

  /** Get cached account state from last sync (TUI reuse). */
  getLastAccountState(): AccountState | null {
    return this.lastAccountState
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: PositionMonitor | null = null

/** Get or create the singleton PositionMonitor. */
export function getPositionMonitor(): PositionMonitor {
  if (!instance) {
    instance = new PositionMonitor()
  }
  return instance
}

/** Reset PositionMonitor (tests only). */
export function resetPositionMonitor(): void {
  instance?.stopSync()
  instance = null
}
