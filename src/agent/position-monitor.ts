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
  TRAIL_UPDATE_THRESHOLD,
} from '../config.js'
import { getExchangeService } from '../execution/exchange-service.js'
import { log } from '../lib/logger.js'

// ─── Exchange Query (S10: real HL clearinghouseState) ──────────────────────

/**
 * Query exchange for current positions via ExchangeService.
 * Returns ExchangePositionSnapshot[] from HL clearinghouseState.
 */
export async function queryExchangePositions(): Promise<ExchangePositionSnapshot[]> {
  try {
    return await getExchangeService().getPositions()
  } catch (err) {
    log.error('position-monitor', `queryExchangePositions failed: ${err instanceof Error ? err.message : err}`)
    return []
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
        newSlPrice: level.newSlPrice ?? null,
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
    // Check if exchange still has this position
    const snap = exchangeSnapshots.find(s => s.coin === pos.coin)

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

export class PositionMonitor {
  /** Tracked open positions — keyed by positionId. */
  private positions: Map<string, PositionState> = new Map()
  /** Exchange sync interval handle. */
  private syncInterval: ReturnType<typeof setInterval> | null = null
  /** Callback to dispatch events to TradingAgent. */
  private dispatchToAgent: ((coin: string, event: AgentEvent) => void) | null = null

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent) => void): void {
    this.dispatchToAgent = fn
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
        // Dispatch update_stop action to OrderManager via agent
        this.dispatchToAgent?.(pos.coin, {
          type: 'tick',  // agent processes update_stop via handleInPosition
        })
        break

      case 'partial_close': {
        const levelIdx = this.findPartialCloseLevel(pos, action.closePct)
        if (levelIdx >= 0) {
          pos.partialClosesFired.push(levelIdx)
        }
        const closeSize = pos.currentSize * action.closePct
        pos.currentSize -= closeSize
        if (action.newSlPrice !== null) {
          pos.slPrice = action.newSlPrice
        }
        log.info('position-monitor', `Partial close: ${pos.coin} ${(action.closePct * 100).toFixed(0)}% (${closeSize.toFixed(4)} coins) remaining=${pos.currentSize.toFixed(4)}`)
        break
      }

      case 'close':
        log.info('position-monitor', `Position close: ${pos.coin} reason=${action.reason}`)
        // Determine PnL direction from reason for event type
        if (action.reason.startsWith('trail_stop_hit')) {
          this.dispatchToAgent?.(pos.coin, {
            type: 'trail_stop_hit',
            positionId: pos.positionId,
            closePrice: 0,  // filled by execution layer (S10)
            pnl: 0,         // computed by execution layer (S10)
          })
        } else {
          this.dispatchToAgent?.(pos.coin, {
            type: 'position_closed',
            positionId: pos.positionId,
            closePrice: 0,
            pnl: 0,
            reason: action.reason,
          })
        }
        break

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
    if (this.positions.size === 0) return []

    const snapshots = await queryExchangePositions()
    const actions = reconcilePositions(this.positions, snapshots)

    for (const action of actions) {
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
