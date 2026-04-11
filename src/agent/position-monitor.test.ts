/**
 * PositionMonitor tests (Sprint 2 S7).
 *
 * Tests: trail stop, partial close, exchange-sync reconciliation.
 * Pure function tests (evaluatePosition, reconcilePositions) + class integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  evaluatePosition,
  reconcilePositions,
  PositionMonitor,
  resetPositionMonitor,
} from './position-monitor.js'
import type { PositionState, ExchangePositionSnapshot, MonitorAction } from './types.js'
import {
  TRAILING_STOP,
  PARTIAL_CLOSE,
  resetPaperTradeRuntimeOverrideForTests,
  setPaperTradeRuntimeOverride,
} from '../config.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makePosition(overrides: Partial<PositionState> = {}): PositionState {
  return {
    positionId: 'pos-1',
    coin: 'BTC',
    side: 'long',
    entryPrice: 100,
    currentSize: 1.0,
    originalSize: 1.0,
    slPrice: 95,      // 5% SL
    tpPrice: 110,     // 10% TP
    entryOrderId: 'ord-1',
    leverage: 10,
    strategyId: 'smc-sd',
    trailingState: null,
    partialClosesFired: [],
    lastSyncAt: Date.now(),
    openedAt: Date.now(),
    ...overrides,
  }
}

function findAction(actions: MonitorAction[], type: string): MonitorAction | undefined {
  return actions.find(a => a.type === type)
}

// ─── Pure Function Tests ────────────────────────────────────────────────────

describe('evaluatePosition', () => {
  describe('hold', () => {
    it('returns hold when price unchanged from entry', () => {
      const pos = makePosition()
      const actions = evaluatePosition(pos, 100)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })

    it('returns hold when price moves slightly up (below trail activation)', () => {
      const pos = makePosition()
      // TRAILING_STOP.activationPct = 0.01 (1%), so 0.5% move doesn't activate
      const actions = evaluatePosition(pos, 100.5)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })

    it('returns hold for invalid price', () => {
      const pos = makePosition()
      const actions = evaluatePosition(pos, 0)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })

    it('returns hold for negative price', () => {
      const pos = makePosition()
      const actions = evaluatePosition(pos, -10)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })
  })

  describe('trailing stop', () => {
    it('activates trailing after +1% profit (long)', () => {
      const pos = makePosition({ side: 'long', entryPrice: 100 })
      // Price at +3.5% — above activation threshold (activationPct=0.03)
      const actions = evaluatePosition(pos, 103.5)
      // Should get trail_update (first activation)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeDefined()
      if (update?.type === 'trail_update') {
        // Trail at 1% below highest: 103.5 * (1 - 0.01) = ~102.465
        expect(update.newSlPrice).toBeCloseTo(103.5 * (1 - TRAILING_STOP.trailPct), 2)
      }
    })

    it('activates trailing after +1% profit (short)', () => {
      const pos = makePosition({ side: 'short', entryPrice: 100, slPrice: 105 })
      // Price at 96.5 — +3.5% profit for short (activationPct=0.03)
      const actions = evaluatePosition(pos, 96.5)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeDefined()
      if (update?.type === 'trail_update') {
        // Trail at 1% above lowest: 96.5 * (1 + 0.01) = ~97.465
        expect(update.newSlPrice).toBeCloseTo(96.5 * (1 + TRAILING_STOP.trailPct), 2)
      }
    })

    it('closes position when trailing stop is hit (long)', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        trailingState: {
          active: true,
          highestPrice: 103,
          currentStopPrice: 103 * (1 - TRAILING_STOP.trailPct),  // 103 * 0.99 = 101.97
        },
      })
      // Price drops below trail stop (101.5 < 101.97)
      const actions = evaluatePosition(pos, 101.5)
      const close = findAction(actions, 'close')
      expect(close).toBeDefined()
      if (close?.type === 'close') {
        expect(close.reason).toContain('trail_stop_hit')
      }
    })

    it('closes position when trailing stop is hit (short)', () => {
      const pos = makePosition({
        side: 'short',
        entryPrice: 100,
        slPrice: 105,
        trailingState: {
          active: true,
          highestPrice: 97,  // lowest price for short
          currentStopPrice: 97 * (1 + TRAILING_STOP.trailPct),  // ~97.485
        },
      })
      // Price rises above trail stop
      const actions = evaluatePosition(pos, 98)
      const close = findAction(actions, 'close')
      expect(close).toBeDefined()
      if (close?.type === 'close') {
        expect(close.reason).toContain('trail_stop_hit')
      }
    })

    it('does not send trail_update when change is below threshold', () => {
      // trailPct=1%: current stop at 101.0 (highestPrice=102.02)
      // New price 102.05 → new stop = 102.05*0.99 = 101.0295, change ~0.03% < 0.1% threshold
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        trailingState: {
          active: true,
          highestPrice: 102.02,
          currentStopPrice: 101.0,
        },
      })
      // Price at 102.05 — trail moves to ~101.03, a ~0.03% change from 101.0
      const actions = evaluatePosition(pos, 102.05)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeUndefined()
    })

    it('sends trail_update when change exceeds threshold', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        trailingState: {
          active: true,
          highestPrice: 102,
          currentStopPrice: 102 * (1 - TRAILING_STOP.trailPct),  // ~101.49
        },
      })
      // Price jumps to 104 — new trail at ~103.48, change >1% from 101.49
      const actions = evaluatePosition(pos, 104)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeDefined()
    })

    it('trail stop hit takes priority over partial close', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,
        trailingState: {
          active: true,
          highestPrice: 106,
          currentStopPrice: 106 * (1 - TRAILING_STOP.trailPct),  // 106 * 0.99 = 104.94
        },
      })
      // Price is 104.5 — below trail stop (104.94), triggers close before 1.5R partial (107.5)
      // Trail stop hit should take priority → only close action
      const actions = evaluatePosition(pos, 104.5)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('close')
    })
  })

  describe('partial close', () => {
    it('triggers first partial close at 1R (long)', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,  // 5 point stop, R=5
      })
      // 1.5R target = 100 + 7.5 = 107.5. Price at 108 → hit
      const actions = evaluatePosition(pos, 108)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()
      if (partial?.type === 'partial_close') {
        expect(partial.closePct).toBe(PARTIAL_CLOSE.firstClosePct)  // 0.5
        // moveSlToBreakeven=false → SL not moved
        expect(partial.newSlPrice).toBeUndefined()
      }
    })

    it('triggers first partial close at 1R (short)', () => {
      const pos = makePosition({
        side: 'short',
        entryPrice: 100,
        slPrice: 105,  // 5 point stop, R=5
      })
      // 1.5R target = 100 - 7.5 = 92.5. Price at 92 → hit
      const actions = evaluatePosition(pos, 92)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()
      if (partial?.type === 'partial_close') {
        expect(partial.closePct).toBe(PARTIAL_CLOSE.firstClosePct)
        // moveSlToBreakeven=false → SL not moved
        expect(partial.newSlPrice).toBeUndefined()
      }
    })

    it('does not trigger partial close below 1R', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,  // 1.5R target = 107.5
      })
      const actions = evaluatePosition(pos, 104)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeUndefined()
    })

    it('does not re-fire already-triggered partial close', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,
        partialClosesFired: [0],  // level 0 already fired
      })
      const actions = evaluatePosition(pos, 106)
      const partial = findAction(actions, 'partial_close')
      // Level 0 already fired, level 1 (3R = 115) not hit yet
      expect(partial).toBeUndefined()
    })

    it('triggers second partial close at 2R', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,
        partialClosesFired: [0],  // level 0 already fired
      })
      // 3R = 100 + 15 = 115. Price at 115.5 → hit
      const actions = evaluatePosition(pos, 115.5)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()
      if (partial?.type === 'partial_close') {
        expect(partial.closePct).toBe(1 - PARTIAL_CLOSE.firstClosePct)  // 0.5 (remainder)
      }
    })
  })
})

// ─── Reconcile Tests ────────────────────────────────────────────────────────

describe('reconcilePositions', () => {
  it('returns close action when exchange position is gone', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-1', makePosition({ coin: 'BTC' }))

    // Exchange returns empty — position liquidated
    const actions = reconcilePositions(tracked, [])
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('close')
    if (actions[0]!.type === 'close') {
      expect(actions[0]!.reason).toBe('exchange_position_not_found')
    }
  })

  it('returns close action when exchange position size is 0', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-1', makePosition({ coin: 'BTC' }))

    const snaps: ExchangePositionSnapshot[] = [{
      coin: 'BTC', size: 0, entryPrice: 100, unrealizedPnl: 0, liquidationPrice: null,
    }]
    const actions = reconcilePositions(tracked, snaps)
    expect(actions).toHaveLength(1)
    if (actions[0]!.type === 'close') {
      expect(actions[0]!.reason).toBe('exchange_position_closed')
    }
  })

  it('returns alert on significant size mismatch', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-1', makePosition({ coin: 'BTC', currentSize: 1.0 }))

    // Exchange shows much smaller size (external partial close)
    const snaps: ExchangePositionSnapshot[] = [{
      coin: 'BTC', size: 0.5, entryPrice: 100, unrealizedPnl: 50, liquidationPrice: 80,
    }]
    const actions = reconcilePositions(tracked, snaps)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('alert')
  })

  it('returns no actions when positions match', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-1', makePosition({ coin: 'BTC', currentSize: 1.0 }))

    const snaps: ExchangePositionSnapshot[] = [{
      coin: 'BTC', size: 1.0, entryPrice: 100, unrealizedPnl: 50, liquidationPrice: 80,
    }]
    const actions = reconcilePositions(tracked, snaps)
    expect(actions).toHaveLength(0)
  })

  it('handles multiple tracked positions', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-1', makePosition({ positionId: 'pos-1', coin: 'BTC' }))
    tracked.set('pos-2', makePosition({ positionId: 'pos-2', coin: 'ETH' }))

    // Only BTC on exchange, ETH gone
    const snaps: ExchangePositionSnapshot[] = [{
      coin: 'BTC', size: 1.0, entryPrice: 100, unrealizedPnl: 0, liquidationPrice: null,
    }]
    const actions = reconcilePositions(tracked, snaps)
    expect(actions).toHaveLength(1)
    if (actions[0]!.type === 'close') {
      expect(actions[0]!.positionId).toBe('pos-2')
    }
  })

  it('matches exchange row by strategyId when snapshots are tagged (multi-wallet)', () => {
    const tracked = new Map<string, PositionState>()
    tracked.set('pos-q', makePosition({ positionId: 'pos-q', coin: 'BTC', strategyId: 'alpha' }))
    // Exchange has BTC for layered only — quant position missing on its account
    const snaps: ExchangePositionSnapshot[] = [{
      coin: 'BTC',
      size: 1.0,
      entryPrice: 100,
      unrealizedPnl: 0,
      liquidationPrice: null,
      strategyId: 'smc-sd',
    }]
    const actions = reconcilePositions(tracked, snaps)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('close')
    if (actions[0]!.type === 'close') {
      expect(actions[0]!.positionId).toBe('pos-q')
      expect(actions[0]!.reason).toBe('exchange_position_not_found')
    }
  })

  it('returns empty for no tracked positions', () => {
    const tracked = new Map<string, PositionState>()
    const actions = reconcilePositions(tracked, [])
    expect(actions).toHaveLength(0)
  })
})

// ─── PositionMonitor Class Tests ────────────────────────────────────────────

describe('PositionMonitor', () => {
  let pm: PositionMonitor

  beforeEach(() => {
    resetPositionMonitor()
    pm = new PositionMonitor()
  })

  afterEach(() => {
    pm.stopSync()
  })

  describe('openPosition / closePositionTracking', () => {
    it('tracks a new position', () => {
      const pos = pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })
      expect(pos.positionId).toBe('pos-1')
      expect(pm.getPosition('pos-1')).toBeDefined()
      expect(pm.getPositionByCoin('BTC')).toBeDefined()
    })

    it('removes a position on close', () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })
      pm.closePositionTracking('pos-1')
      expect(pm.getPosition('pos-1')).toBeNull()
    })

    it('getPositions returns all tracked', () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })
      pm.openPosition({
        positionId: 'pos-2', coin: 'ETH', side: 'short',
        entryPrice: 2000, size: 5.0, slPrice: 2100, tpPrice: 1800, entryOrderId: 'ord-2', leverage: 10,
      })
      expect(pm.getPositions().size).toBe(2)
    })
  })

  describe('monitorPosition', () => {
    it('returns hold for small price move', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })
      const actions = await pm.monitorPosition('pos-1', 100.3)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })

    it('updates trailing state after each call', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })
      await pm.monitorPosition('pos-1', 102)
      const pos = pm.getPosition('pos-1')!
      expect(pos.trailingState).not.toBeNull()
      expect(pos.trailingState!.highestPrice).toBe(102)
    })

    it('dispatches trail_stop_hit event on close', async () => {
      let dispatched: { coin: string; event: unknown } | null = null
      pm.setAgentDispatch((coin, event) => { dispatched = { coin, event } })

      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })

      // Simulate trailing stop being active and hit
      const pos = pm.getPosition('pos-1')!
      pos.trailingState = {
        active: true,
        highestPrice: 103,
        currentStopPrice: 103 * (1 - TRAILING_STOP.trailPct),  // 103 * 0.99 = 101.97
      }

      // Price drops below trail stop (101.5 < 101.97)
      await pm.monitorPosition('pos-1', 101.5)

      expect(dispatched).not.toBeNull()
      expect(dispatched!.coin).toBe('BTC')
      expect((dispatched!.event as { type: string }).type).toBe('trail_stop_hit')
    })

    it('records partial close in partialClosesFired', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })

      // Price at 1.5R = 107.5. Use 108 to trigger partial close
      const actions = await pm.monitorPosition('pos-1', 108)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()

      const pos = pm.getPosition('pos-1')!
      expect(pos.partialClosesFired).toContain(0)
      expect(pos.currentSize).toBeCloseTo(0.5, 2)
      // moveSlToBreakeven=false → SL stays at original 95
      expect(pos.slPrice).toBe(95)
    })

    it('returns hold for unknown position', async () => {
      const actions = await pm.monitorPosition('unknown', 100)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })
  })

  describe('syncWithExchange', () => {
    afterEach(() => {
      resetPaperTradeRuntimeOverrideForTests()
    })

    it('returns empty when no positions tracked', async () => {
      const actions = await pm.syncWithExchange()
      expect(actions).toHaveLength(0)
    })

    it('skips reconciliation in paper mode (no false closes)', async () => {
      setPaperTradeRuntimeOverride(true)
      // In paper mode, syncWithExchange must NOT close paper positions via exchange reconciliation.
      // Real positions only exist in PositionMonitor, not on HL — reconciliation would falsely close them.
      let dispatched: { coin: string; event: unknown } | null = null
      pm.setAgentDispatch((coin, event) => { dispatched = { coin, event } })

      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1', leverage: 10,
      })

      const actions = await pm.syncWithExchange()
      // Paper mode: reconciliation skipped → no actions, position still tracked
      expect(actions).toHaveLength(0)
      expect(pm.getPosition('pos-1')).not.toBeNull()
      expect(dispatched).toBeNull()
    })
  })

  describe('startSync / stopSync', () => {
    it('starts and stops sync interval', () => {
      expect(pm.isSyncRunning()).toBe(false)
      pm.startSync()
      expect(pm.isSyncRunning()).toBe(true)
      pm.stopSync()
      expect(pm.isSyncRunning()).toBe(false)
    })

    it('startSync is idempotent', () => {
      pm.startSync()
      pm.startSync()  // should not create second interval
      expect(pm.isSyncRunning()).toBe(true)
      pm.stopSync()
    })
  })
})
