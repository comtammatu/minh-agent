/**
 * OrderManager tests (Sprint 2 S6, updated S10).
 *
 * Tests the order lifecycle: place, fill, reject, cancel, timeout, SL/TP triggers.
 * Mocks DB via bun:test mock.module — pure logic verification.
 * S10: Also mocks ExchangeService (replaces old stubs).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Mock the DB connection BEFORE importing OrderManager
mock.module('../db/connection.js', () => {
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === 'end') return () => Promise.resolve()
      // Return a tagged template function that resolves to empty array
      return () => Promise.resolve([])
    },
    apply() {
      return Promise.resolve([])
    },
  }
  const sqlProxy = new Proxy(function () { return Promise.resolve([]) } as unknown as object, handler)
  return { sql: sqlProxy }
})

// S10: Mock ExchangeService so OrderManager's exchange wrappers return success
let mockOrderSuccess = true
let mockCancelSuccess = true
let mockTriggerSuccess = true

mock.module('../execution/exchange-service.js', () => ({
  getExchangeService: () => ({
    placeOrder: () => Promise.resolve(
      mockOrderSuccess
        ? { success: true, oid: 12345, avgPx: 50000, totalSz: 0.1, status: 'filled', error: null }
        : { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'Mock rejection' }
    ),
    placeTrigger: () => Promise.resolve(
      mockTriggerSuccess
        ? { success: true, oid: 67890, avgPx: null, totalSz: null, status: 'waitingForTrigger', error: null }
        : { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'Mock trigger fail' }
    ),
    cancelByOid: () => Promise.resolve(
      mockCancelSuccess
        ? { success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null }
        : { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'Mock cancel fail' }
    ),
    cancelByCloid: () => Promise.resolve(
      mockCancelSuccess
        ? { success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null }
        : { success: false, oid: null, avgPx: null, totalSz: null, status: null, error: 'Mock cancel fail' }
    ),
    modifyTrigger: () => Promise.resolve(
      { success: true, oid: 67890, avgPx: null, totalSz: null, status: 'modified', error: null }
    ),
  }),
}))

import {
  OrderManager,
  resetOrderManager,
  generateCloid,
  paperSimulateFill,
  paperSimulateCancel,
  paperSimulateTrigger,
} from './order-manager.js'
import type { AgentEvent, Order } from './types.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Access the private orders map. */
function getOrdersMap(om: OrderManager): Map<string, Order> {
  return (om as unknown as { orders: Map<string, Order> }).orders
}

/** Inject an order into the cache (bypasses DB). */
function injectOrder(om: OrderManager, order: Order): void {
  getOrdersMap(om).set(order.id, order)
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: crypto.randomUUID(),
    coin: 'BTC',
    side: 'long',
    type: 'market',
    price: 50000,
    size: 0.1,
    status: 'submitted',
    setupId: 'BTC|1h|order-block|long',
    slPrice: 49000,
    tpPrice: 52000,
    cloid: generateCloid(),
    exchangeOrderId: `sim-${Date.now()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filledAt: null,
    fillPrice: null,
    fillSize: 0,
    ...overrides,
  }
}

// ── generateCloid ──────────────────────────────────────────────────────────

describe('generateCloid', () => {
  it('returns a 0x-prefixed 32-char hex string', () => {
    const cloid = generateCloid()
    expect(cloid).toStartWith('0x')
    expect(cloid).toHaveLength(34) // 0x + 32 hex chars
    expect(/^0x[0-9a-f]{32}$/.test(cloid)).toBe(true)
  })

  it('generates unique values', () => {
    const a = generateCloid()
    const b = generateCloid()
    expect(a).not.toBe(b)
  })
})

// ── OrderManager (unit, mocked DB) ─────────────────────────────────────────

describe('OrderManager', () => {
  let om: OrderManager
  let dispatchedEvents: Array<{ coin: string; event: AgentEvent }>

  beforeEach(() => {
    resetOrderManager()
    mockOrderSuccess = true
    mockCancelSuccess = true
    mockTriggerSuccess = true
    om = new OrderManager()
    dispatchedEvents = []
    om.setAgentDispatch((coin, event) => {
      dispatchedEvents.push({ coin, event })
    })
  })

  it('getOrder returns null for malformed order ids without hitting DB', async () => {
    expect(await om.getOrder('abc-123')).toBeNull()
    expect(await om.getOrder('not-a-uuid')).toBeNull()
  })

  // ── Cancel ───────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('cancels a submitted order', async () => {
      const order = makeOrder({ status: 'submitted' })
      injectOrder(om, order)

      await om.cancelOrder(order.id, 'invalidation')

      expect(getOrdersMap(om).get(order.id)?.status).toBe('cancelled')
    })

    it('cancels a pending order', async () => {
      const order = makeOrder({ status: 'pending', exchangeOrderId: null })
      injectOrder(om, order)

      await om.cancelOrder(order.id, 'timeout')

      expect(getOrdersMap(om).get(order.id)?.status).toBe('cancelled')
    })

    it('is idempotent on filled order', async () => {
      const order = makeOrder({ status: 'filled', fillPrice: 50000, filledAt: Date.now() })
      injectOrder(om, order)

      await om.cancelOrder(order.id, 'test')

      expect(getOrdersMap(om).get(order.id)?.status).toBe('filled')
    })

    it('is idempotent on already-cancelled order', async () => {
      const order = makeOrder({ status: 'cancelled' })
      injectOrder(om, order)

      await om.cancelOrder(order.id, 'double-cancel')

      expect(getOrdersMap(om).get(order.id)?.status).toBe('cancelled')
    })

    it('is no-op for unknown order', async () => {
      // Should not throw
      await om.cancelOrder('nonexistent-id', 'test')
    })
  })

  // ── Fill ─────────────────────────────────────────────────────────────

  describe('onOrderFilled', () => {
    it('transitions to filled and places SL/TP triggers', async () => {
      const order = makeOrder({ coin: 'BTC', side: 'long', slPrice: 49000, tpPrice: 52000 })
      injectOrder(om, order)

      await om.onOrderFilled(order.id, 50050, 0.1)

      // Order should be filled
      const cached = getOrdersMap(om).get(order.id)!
      expect(cached.status).toBe('filled')
      expect(cached.fillPrice).toBe(50050)
      expect(cached.fillSize).toBe(0.1)

      // SL/TP triggers should exist
      const triggers = om.getTriggerOrders(order.id)
      expect(triggers).toHaveLength(2)

      const sl = triggers.find(t => t.type === 'sl')!
      expect(sl.triggerPrice).toBe(49000)
      expect(sl.isMarket).toBe(true)   // R9: SL = trigger-market
      expect(sl.side).toBe('short')    // close side = opposite of entry

      const tp = triggers.find(t => t.type === 'tp')!
      expect(tp.triggerPrice).toBe(52000)
      expect(tp.isMarket).toBe(false)  // R9: TP = trigger-limit
      expect(tp.side).toBe('short')

      // Agent receives order_filled event
      expect(dispatchedEvents).toHaveLength(1)
      expect(dispatchedEvents[0]!.coin).toBe('BTC')
      expect(dispatchedEvents[0]!.event.type).toBe('order_filled')
    })

    it('places triggers with short close side for short entry', async () => {
      const order = makeOrder({ coin: 'ETH', side: 'short', slPrice: 3100, tpPrice: 2800 })
      injectOrder(om, order)

      await om.onOrderFilled(order.id, 3000, 1)

      const triggers = om.getTriggerOrders(order.id)
      expect(triggers[0]!.side).toBe('long')  // close side for short = long
      expect(triggers[1]!.side).toBe('long')
    })

    it('skips SL/TP if prices are null', async () => {
      const order = makeOrder({ slPrice: null, tpPrice: null })
      injectOrder(om, order)

      await om.onOrderFilled(order.id, 50000, 0.1)

      expect(om.getTriggerOrders(order.id)).toHaveLength(0)
      expect(dispatchedEvents).toHaveLength(1)  // still dispatches fill
    })

    it('is no-op for unknown order', async () => {
      await om.onOrderFilled('unknown-id', 50000, 0.1)
      expect(dispatchedEvents).toHaveLength(0)
    })
  })

  // ── Partial Fill ─────────────────────────────────────────────────────

  describe('onPartialFill', () => {
    it('marks as partial when size < requested', async () => {
      const order = makeOrder({ size: 1.0 })
      injectOrder(om, order)

      await om.onPartialFill(order.id, 0.5)

      expect(getOrdersMap(om).get(order.id)?.status).toBe('partial')
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.5)
      expect(dispatchedEvents).toHaveLength(0)  // no agent dispatch yet
    })

    it('auto-promotes to filled when partial >= size', async () => {
      const order = makeOrder({ coin: 'SOL', side: 'short', size: 10, slPrice: 105, tpPrice: 90 })
      injectOrder(om, order)

      await om.onPartialFill(order.id, 10)

      expect(getOrdersMap(om).get(order.id)?.status).toBe('filled')
      expect(om.getTriggerOrders(order.id)).toHaveLength(2)
      expect(dispatchedEvents).toHaveLength(1)
      expect(dispatchedEvents[0]!.event.type).toBe('order_filled')
    })
  })

  // ── Timeout ──────────────────────────────────────────────────────────

  describe('checkTimeouts', () => {
    it('cancels orders older than ORDER_FILL_TIMEOUT_MS', async () => {
      const oldTime = Date.now() - 6 * 60 * 1000  // 6 min ago (> 5 min timeout)
      const order = makeOrder({ coin: 'HYPE', createdAt: oldTime, updatedAt: oldTime })
      injectOrder(om, order)

      await om.checkTimeouts()

      expect(getOrdersMap(om).get(order.id)?.status).toBe('cancelled')
      expect(dispatchedEvents).toHaveLength(1)
      expect(dispatchedEvents[0]!.event.type).toBe('order_timeout')
      expect(dispatchedEvents[0]!.coin).toBe('HYPE')
    })

    it('does not cancel recent orders', async () => {
      const order = makeOrder({ coin: 'TAO' })
      injectOrder(om, order)

      await om.checkTimeouts()

      expect(getOrdersMap(om).get(order.id)?.status).toBe('submitted')
      expect(dispatchedEvents).toHaveLength(0)
    })

    it('skips already-cancelled and filled orders', async () => {
      const cancelled = makeOrder({ coin: 'A', status: 'cancelled', createdAt: 0 })
      const filled = makeOrder({ coin: 'B', status: 'filled', createdAt: 0 })
      injectOrder(om, cancelled)
      injectOrder(om, filled)

      await om.checkTimeouts()

      expect(getOrdersMap(om).get(cancelled.id)?.status).toBe('cancelled')
      expect(getOrdersMap(om).get(filled.id)?.status).toBe('filled')
      expect(dispatchedEvents).toHaveLength(0)
    })
  })

  // ── Modify SL ────────────────────────────────────────────────────────

  describe('modifySLPrice', () => {
    it('updates SL trigger price in memory', async () => {
      const order = makeOrder()
      injectOrder(om, order)
      await om.onOrderFilled(order.id, 50000, 0.1)

      const triggers = om.getTriggerOrders(order.id)
      expect(triggers.find(t => t.type === 'sl')?.triggerPrice).toBe(49000)

      await om.modifySLPrice(order.id, 49500)

      const updated = om.getTriggerOrders(order.id)
      expect(updated.find(t => t.type === 'sl')?.triggerPrice).toBe(49500)
    })

    it('is no-op for unknown parent order', async () => {
      // Should not throw
      await om.modifySLPrice('nonexistent', 50000)
    })
  })

  // ── handleAction ─────────────────────────────────────────────────────

  describe('handleAction', () => {
    it('routes cancel_order to cancelOrder', async () => {
      const order = makeOrder()
      injectOrder(om, order)

      await om.handleAction({ type: 'cancel_order', orderId: order.id, reason: 'test' })

      expect(getOrdersMap(om).get(order.id)?.status).toBe('cancelled')
    })

    it('ignores non-order actions', async () => {
      // Should not throw for watch, none, log_journal
      await om.handleAction({ type: 'none' })
      await om.handleAction({ type: 'watch', setup: {} as never })
      await om.handleAction({ type: 'log_journal', eventType: 'test', coin: 'BTC', details: {} })
    })
  })

  // ── Query ────────────────────────────────────────────────────────────

  describe('getOrders / getTriggerOrders', () => {
    it('returns empty map when nothing cached', () => {
      expect(om.getOrders().size).toBe(0)
    })

    it('returns empty array for unknown trigger parent', () => {
      expect(om.getTriggerOrders('nonexistent')).toEqual([])
    })

    it('returns cached orders', () => {
      const order = makeOrder()
      injectOrder(om, order)
      expect(om.getOrders().size).toBe(1)
    })
  })
})

// ── Paper Trade Simulation Functions ─────────────────────────────────────────

describe('Paper Trade Simulation', () => {
  describe('paperSimulateFill', () => {
    it('returns success with paper_ prefixed exchangeOrderId', () => {
      const result = paperSimulateFill('BTC', 'long', 50000, 0.1, '0xabcdef1234567890')
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toStartWith('paper_')
      expect(result.error).toBeNull()
    })

    it('always succeeds regardless of parameters', () => {
      const result = paperSimulateFill('ETH', 'short', 3000, 1.5, '0x0000000000000000')
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toStartWith('paper_')
    })
  })

  describe('paperSimulateCancel', () => {
    it('always returns success', () => {
      const result = paperSimulateCancel('paper_abc123', 'BTC')
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toBeNull()
      expect(result.error).toBeNull()
    })

    it('handles missing coin gracefully', () => {
      const result = paperSimulateCancel('paper_abc123')
      expect(result.success).toBe(true)
    })
  })

  describe('paperSimulateTrigger', () => {
    it('returns success with paper_trigger_ prefixed exchangeOrderId', () => {
      const result = paperSimulateTrigger({
        type: 'sl',
        coin: 'BTC',
        side: 'short',
        triggerPrice: 49000,
        size: 0.1,
        isMarket: true,
        cloid: generateCloid(),
        exchangeOrderId: null,
        parentOrderId: 'test-order-id',
      })
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toStartWith('paper_trigger_')
      expect(result.error).toBeNull()
    })

    it('works for TP triggers', () => {
      const result = paperSimulateTrigger({
        type: 'tp',
        coin: 'ETH',
        side: 'long',
        triggerPrice: 3500,
        size: 1.0,
        isMarket: false,
        cloid: generateCloid(),
        exchangeOrderId: null,
        parentOrderId: 'test-order-id',
      })
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toStartWith('paper_trigger_')
    })
  })
})
