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
import { TRAILING_STOP, PARTIAL_CLOSE } from '../config.js'

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
      // Price at +1.5% — above activation threshold
      const actions = evaluatePosition(pos, 101.5)
      // Should get trail_update (first activation)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeDefined()
      if (update?.type === 'trail_update') {
        // Trail at 0.5% below highest: 101.5 * (1 - 0.005) = ~101.0
        expect(update.newSlPrice).toBeCloseTo(101.5 * (1 - TRAILING_STOP.trailPct), 2)
      }
    })

    it('activates trailing after +1% profit (short)', () => {
      const pos = makePosition({ side: 'short', entryPrice: 100, slPrice: 105 })
      // Price at 98.5 — +1.5% profit for short
      const actions = evaluatePosition(pos, 98.5)
      const update = findAction(actions, 'trail_update')
      expect(update).toBeDefined()
      if (update?.type === 'trail_update') {
        // Trail at 0.5% above lowest: 98.5 * (1 + 0.005) = ~98.99
        expect(update.newSlPrice).toBeCloseTo(98.5 * (1 + TRAILING_STOP.trailPct), 2)
      }
    })

    it('closes position when trailing stop is hit (long)', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        trailingState: {
          active: true,
          highestPrice: 103,
          currentStopPrice: 103 * (1 - TRAILING_STOP.trailPct),  // ~102.485
        },
      })
      // Price drops below trail stop
      const actions = evaluatePosition(pos, 102)
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
      // Previous trail at 101.0, new trail would be 101.05 — ~0.05% change < 0.1% threshold
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        trailingState: {
          active: true,
          highestPrice: 101.5,
          currentStopPrice: 101.0,
        },
      })
      // Price at 101.55 — trail moves to ~101.05, a ~0.05% change
      const actions = evaluatePosition(pos, 101.55)
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
          currentStopPrice: 106 * (1 - TRAILING_STOP.trailPct),  // ~105.47
        },
      })
      // Price is 105 — hits trail AND would trigger partial close at 1R (105)
      // Trail stop hit should take priority → only close action
      const actions = evaluatePosition(pos, 105)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('close')
    })
  })

  describe('partial close', () => {
    it('triggers first partial close at 1R (long)', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,  // 5 point stop
      })
      // 1R target = 100 + 5 = 105. Price at 105.5 → hit
      const actions = evaluatePosition(pos, 105.5)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()
      if (partial?.type === 'partial_close') {
        expect(partial.closePct).toBe(PARTIAL_CLOSE.firstClosePct)  // 0.5
        expect(partial.newSlPrice).toBe(100)  // breakeven
      }
    })

    it('triggers first partial close at 1R (short)', () => {
      const pos = makePosition({
        side: 'short',
        entryPrice: 100,
        slPrice: 105,  // 5 point stop
      })
      // 1R target = 100 - 5 = 95. Price at 94.5 → hit
      const actions = evaluatePosition(pos, 94.5)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()
      if (partial?.type === 'partial_close') {
        expect(partial.closePct).toBe(PARTIAL_CLOSE.firstClosePct)
        expect(partial.newSlPrice).toBe(100)  // breakeven
      }
    })

    it('does not trigger partial close below 1R', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,  // 1R = 105
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
      // Level 0 already fired, level 1 (2R = 110) not hit yet
      expect(partial).toBeUndefined()
    })

    it('triggers second partial close at 2R', () => {
      const pos = makePosition({
        side: 'long',
        entryPrice: 100,
        slPrice: 95,
        partialClosesFired: [0],  // level 0 already fired
      })
      // 2R = 100 + 10 = 110. Price at 110.5 → hit
      const actions = evaluatePosition(pos, 110.5)
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
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })
      expect(pos.positionId).toBe('pos-1')
      expect(pm.getPosition('pos-1')).toBeDefined()
      expect(pm.getPositionByCoin('BTC')).toBeDefined()
    })

    it('removes a position on close', () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })
      pm.closePositionTracking('pos-1')
      expect(pm.getPosition('pos-1')).toBeNull()
    })

    it('getPositions returns all tracked', () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })
      pm.openPosition({
        positionId: 'pos-2', coin: 'ETH', side: 'short',
        entryPrice: 2000, size: 5.0, slPrice: 2100, tpPrice: 1800, entryOrderId: 'ord-2',
      })
      expect(pm.getPositions().size).toBe(2)
    })
  })

  describe('monitorPosition', () => {
    it('returns hold for small price move', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })
      const actions = await pm.monitorPosition('pos-1', 100.3)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })

    it('updates trailing state after each call', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
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
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })

      // Simulate trailing stop being active and hit
      const pos = pm.getPosition('pos-1')!
      pos.trailingState = {
        active: true,
        highestPrice: 103,
        currentStopPrice: 103 * (1 - TRAILING_STOP.trailPct),
      }

      // Price drops to trigger trail stop
      await pm.monitorPosition('pos-1', 102)

      expect(dispatched).not.toBeNull()
      expect(dispatched!.coin).toBe('BTC')
      expect((dispatched!.event as { type: string }).type).toBe('trail_stop_hit')
    })

    it('records partial close in partialClosesFired', async () => {
      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })

      // Price at 1R = 105
      const actions = await pm.monitorPosition('pos-1', 106)
      const partial = findAction(actions, 'partial_close')
      expect(partial).toBeDefined()

      const pos = pm.getPosition('pos-1')!
      expect(pos.partialClosesFired).toContain(0)
      expect(pos.currentSize).toBeCloseTo(0.5, 2)
      expect(pos.slPrice).toBe(100)  // moved to breakeven
    })

    it('returns hold for unknown position', async () => {
      const actions = await pm.monitorPosition('unknown', 100)
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('hold')
    })
  })

  describe('syncWithExchange', () => {
    it('returns empty when no positions tracked', async () => {
      const actions = await pm.syncWithExchange()
      expect(actions).toHaveLength(0)
    })

    it('detects position gone (stub returns empty)', async () => {
      let dispatched: { coin: string; event: unknown } | null = null
      pm.setAgentDispatch((coin, event) => { dispatched = { coin, event } })

      pm.openPosition({
        positionId: 'pos-1', coin: 'BTC', side: 'long',
        entryPrice: 100, size: 1.0, slPrice: 95, tpPrice: 110, entryOrderId: 'ord-1',
      })

      // Stub returns empty → position gone
      const actions = await pm.syncWithExchange()
      expect(actions).toHaveLength(1)
      expect(actions[0]!.type).toBe('close')

      // Position removed from tracking
      expect(pm.getPosition('pos-1')).toBeNull()

      // Event dispatched
      expect(dispatched).not.toBeNull()
      expect((dispatched!.event as { type: string }).type).toBe('position_closed')
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
