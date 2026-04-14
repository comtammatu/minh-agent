/**
 * OrderManager tests (Sprint 2 S6, updated S10).
 *
 * Tests the order lifecycle: place, fill, reject, cancel, timeout, SL/TP triggers.
 * Mocks DB via bun:test mock.module — pure logic verification.
 * S10: Also mocks ExchangeService (replaces old stubs).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock the DB connection BEFORE importing OrderManager
let mockSqlResponses: Record<string, unknown>[][] = []

mock.module('../db/connection.js', () => {
  const sqlTag = () => {
    const next = mockSqlResponses.shift()
    return Promise.resolve(next ?? [])
  }
  return {
    sql: Object.assign(sqlTag, { end: () => Promise.resolve() }),
  }
})

// S10: Mock ExchangeService so OrderManager's exchange wrappers return success
let mockOrderSuccess = true
let mockCancelSuccess = true
let mockTriggerSuccess = true

mock.module('../execution/hl-exchange-service.js', () => ({
  getHLExchangeService: () => ({
    getCachedAccountValue: () => 10_000,
    setLeverage: () => Promise.resolve(),
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
    getFillAggregateByCloid: () => Promise.resolve(null),
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
import type { AgentEvent, Order, TriggerOrder } from './types.js'
import type { ExchangePool, IExchangeService } from '../execution/exchange-pool.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Access the private orders map. */
function getOrdersMap(om: OrderManager): Map<string, Order> {
  return (om as unknown as { orders: Map<string, Order> }).orders
}

/** Inject an order into the cache (bypasses DB). */
function injectOrder(om: OrderManager, order: Order): void {
  getOrdersMap(om).set(order.id, order)
}

/** Access the private triggerOrders map. */
function getTriggerOrdersMap(om: OrderManager): Map<string, TriggerOrder[]> {
  return (om as unknown as { triggerOrders: Map<string, TriggerOrder[]> }).triggerOrders
}

/** Inject trigger orders for a parent order (test-only helper). */
function injectTriggers(om: OrderManager, parentOrderId: string, triggers: TriggerOrder[]): void {
  getTriggerOrdersMap(om).set(parentOrderId, triggers)
}

function queueSqlResult(rows: Record<string, unknown>[]): void {
  mockSqlResponses.push(rows)
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
    strategyId: 'smc-sd',
    positionId: null,
    exchange: 'HL',
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
  let partialCloseEvents: Array<{ positionId: string; closePct: number }>
  const originalActiveExchange = process.env.ACTIVE_EXCHANGE

  beforeEach(() => {
    process.env.ACTIVE_EXCHANGE = 'HL'
    resetOrderManager()
    mockOrderSuccess = true
    mockCancelSuccess = true
    mockTriggerSuccess = true
    mockSqlResponses = []
    om = new OrderManager()
    dispatchedEvents = []
    partialCloseEvents = []
    om.setAgentDispatch((coin, event) => {
      dispatchedEvents.push({ coin, event })
    })
    om.setPositionPartialCloseCallback((positionId, closePct) => {
      partialCloseEvents.push({ positionId, closePct })
    })
  })

  afterEach(() => {
    if (originalActiveExchange === undefined) {
      delete process.env.ACTIVE_EXCHANGE
    } else {
      process.env.ACTIVE_EXCHANGE = originalActiveExchange
    }
  })

  it('getOrder returns null for malformed order ids without hitting DB', async () => {
    expect(await om.getOrder('abc-123')).toBeNull()
    expect(await om.getOrder('not-a-uuid')).toBeNull()
  })

  describe('DB row mapping + recovery lookup', () => {
    it('loadActiveOrders maps cloid from DB cloid column (not exchange_order_id)', async () => {
      process.env.ACTIVE_EXCHANGE = 'BB'
      const rowId = crypto.randomUUID()
      queueSqlResult([{
        id: rowId,
        coin: 'BTC',
        side: 'long',
        type: 'limit',
        price: 50000,
        size: 0.1,
        status: 'filled',
        setup_id: 'setup-1',
        sl_price: 49000,
        tp_price: 52000,
        cloid: 'bb-link-123',
        exchange_order_id: 'be411c88-aaaa-bbbb-cccc-111122223333',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        filled_at: new Date().toISOString(),
        fill_price: 50010,
        fill_size: 0.1,
        strategy_id: 'smc-sd',
        position_id: 'pos-1',
        exchange: 'BB',
      }])

      await om.loadActiveOrders()

      const loaded = getOrdersMap(om).get(rowId)
      expect(loaded).not.toBeUndefined()
      expect(loaded?.cloid).toBe('bb-link-123')
      expect(loaded?.exchangeOrderId).toBe('be411c88-aaaa-bbbb-cccc-111122223333')
    })

    it('loadActiveOrders does not infer Bybit cloid from exchange_order_id when cloid is empty', async () => {
      process.env.ACTIVE_EXCHANGE = 'BB'
      const rowId = crypto.randomUUID()
      queueSqlResult([{
        id: rowId,
        coin: 'ETH',
        side: 'short',
        type: 'limit',
        price: 3000,
        size: 1,
        status: 'submitted',
        setup_id: 'setup-2',
        sl_price: 3100,
        tp_price: 2800,
        cloid: '',
        exchange_order_id: 'be411c88-aaaa-bbbb-cccc-111122223333',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        filled_at: null,
        fill_price: null,
        fill_size: 0,
        strategy_id: 'smc-sd',
        position_id: null,
        exchange: 'BB',
      }])

      await om.loadActiveOrders()

      const loaded = getOrdersMap(om).get(rowId)
      expect(loaded).not.toBeUndefined()
      expect(loaded?.cloid).toBe('')
      expect(loaded?.exchangeOrderId).toBe('be411c88-aaaa-bbbb-cccc-111122223333')
    })

    it('syncSubmittedEntryFills prefers cloid lookup when cloid exists', async () => {
      const order = makeOrder({
        exchange: 'BB',
        status: 'submitted',
        size: 1,
        fillSize: 0,
        cloid: 'bb-link-live',
        exchangeOrderId: 'bb-order-1',
      })
      injectOrder(om, order)

      const getFillAggregateByCloid = mock(() =>
        Promise.resolve({ avgPx: 50000, totalSz: 0.4, isFilled: false }),
      )
      const getFillAggregateByOrderId = mock(() => Promise.resolve(null))
      const bbSvc = {
        exchangeId: 'BB',
        getFillAggregateByCloid,
        getFillAggregateByOrderId,
      } as unknown as IExchangeService
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool
      om.setExchangePool(fakePool)

      await om.syncSubmittedEntryFills()

      expect(getFillAggregateByCloid).toHaveBeenCalledTimes(1)
      expect(getFillAggregateByCloid).toHaveBeenCalledWith('bb-link-live', 'BTC')
      expect(getFillAggregateByOrderId).toHaveBeenCalledTimes(0)
      expect(getOrdersMap(om).get(order.id)?.status).toBe('partial')
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.4)
    })

    it('syncSubmittedEntryFills falls back to orderId lookup when cloid lookup misses', async () => {
      const order = makeOrder({
        exchange: 'BB',
        status: 'submitted',
        size: 1,
        fillSize: 0,
        cloid: 'bb-link-stale',
        exchangeOrderId: 'bb-order-fallback',
      })
      injectOrder(om, order)

      const getFillAggregateByCloid = mock(() => Promise.resolve(null))
      const getFillAggregateByOrderId = mock(() =>
        Promise.resolve({ avgPx: 49990, totalSz: 0.25, isFilled: false }),
      )
      const bbSvc = {
        exchangeId: 'BB',
        getFillAggregateByCloid,
        getFillAggregateByOrderId,
      } as unknown as IExchangeService
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool
      om.setExchangePool(fakePool)

      await om.syncSubmittedEntryFills()

      expect(getFillAggregateByCloid).toHaveBeenCalledTimes(1)
      expect(getFillAggregateByOrderId).toHaveBeenCalledTimes(1)
      expect(getFillAggregateByOrderId).toHaveBeenCalledWith('bb-order-fallback', 'BTC')
      expect(getOrdersMap(om).get(order.id)?.status).toBe('partial')
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.25)
    })
  })

  describe('restoreOpenPositions', () => {
    it('restores the latest filled order per open coin+side and prefers fillSize', () => {
      const restored: Array<{
        positionId: string
        coin: string
        size: number
        entryPrice: number
        leverage: number
        strategyId?: string
      }> = []
      om.setPositionOpenCallback((params) => {
        restored.push({
          positionId: params.positionId,
          coin: params.coin,
          size: params.size,
          entryPrice: params.entryPrice,
          leverage: params.leverage,
          strategyId: params.strategyId,
        })
      })

      injectOrder(om, makeOrder({
        coin: 'BTC',
        status: 'filled',
        size: 1,
        fillSize: 0.4,
        fillPrice: 50000,
        positionId: 'btc-old',
        slPrice: 49000,
        tpPrice: 52000,
        filledAt: 1000,
        updatedAt: 1000,
      }))
      injectOrder(om, makeOrder({
        coin: 'BTC',
        status: 'filled',
        size: 1,
        fillSize: 0.25,
        fillPrice: 50100,
        positionId: 'btc-new',
        slPrice: 49100,
        tpPrice: 52100,
        filledAt: 2000,
        updatedAt: 2000,
      }))
      injectOrder(om, makeOrder({
        coin: 'ETH',
        side: 'short',
        status: 'filled',
        size: 0.75,
        fillSize: 0.5,
        fillPrice: 3000,
        positionId: 'eth-pos',
        slPrice: 3100,
        tpPrice: 2800,
        filledAt: 1500,
        updatedAt: 1500,
      }))

      om.restoreOpenPositions([
        { coin: 'BTC', size: 0.25, entryPrice: 50100 },
        { coin: 'ETH', size: -0.5, entryPrice: 3000 },
      ])

      expect(restored).toHaveLength(2)

      const btc = restored.find(position => position.coin === 'BTC')
      expect(btc).toEqual({
        positionId: 'btc-new',
        coin: 'BTC',
        size: 0.25,
        entryPrice: 50100,
        leverage: 0,
        strategyId: 'smc-sd',
      })

      const eth = restored.find(position => position.coin === 'ETH')
      expect(eth).toEqual({
        positionId: 'eth-pos',
        coin: 'ETH',
        size: 0.5,
        entryPrice: 3000,
        leverage: 0,
        strategyId: 'smc-sd',
      })
    })

    it('prefers exact strategy match when exchange snapshot includes strategyId', () => {
      const restored: Array<{ coin: string; strategyId?: string; positionId: string }> = []
      om.setPositionOpenCallback((params) => {
        restored.push({ coin: params.coin, strategyId: params.strategyId, positionId: params.positionId })
      })

      injectOrder(om, makeOrder({
        coin: 'BTC',
        status: 'filled',
        side: 'long',
        fillPrice: 50000,
        fillSize: 0.2,
        positionId: 'btc-trend',
        strategyId: 'trend',
        filledAt: 1000,
        updatedAt: 1000,
      }))
      injectOrder(om, makeOrder({
        coin: 'BTC',
        status: 'filled',
        side: 'long',
        fillPrice: 50100,
        fillSize: 0.25,
        positionId: 'btc-mean',
        strategyId: 'mean-revert',
        filledAt: 2000,
        updatedAt: 2000,
      }))

      om.restoreOpenPositions([
        { coin: 'BTC', size: 0.25, entryPrice: 50100, strategyId: 'trend' },
      ])

      expect(restored).toEqual([{
        coin: 'BTC',
        strategyId: 'trend',
        positionId: 'btc-trend',
      }])
    })

    it('falls back to original size for legacy rows and ignores incomplete fills', () => {
      const restored: Array<{ coin: string; size: number; positionId: string }> = []
      om.setPositionOpenCallback((params) => {
        restored.push({ coin: params.coin, size: params.size, positionId: params.positionId })
      })

      injectOrder(om, makeOrder({
        coin: 'SOL',
        status: 'filled',
        size: 2,
        fillSize: 0,
        fillPrice: 150,
        positionId: 'sol-pos',
        slPrice: 145,
        tpPrice: 165,
        filledAt: 2500,
        updatedAt: 2500,
      }))
      injectOrder(om, makeOrder({
        coin: 'SOL',
        status: 'filled',
        size: 1,
        fillSize: 1,
        fillPrice: null,
        positionId: 'ignored-missing-price',
        filledAt: 3000,
        updatedAt: 3000,
      }))
      injectOrder(om, makeOrder({
        coin: 'ARB',
        status: 'filled',
        size: 100,
        fillSize: 100,
        fillPrice: 1.2,
        positionId: null,
        filledAt: 3500,
        updatedAt: 3500,
      }))

      om.restoreOpenPositions([
        { coin: 'SOL', size: 2, entryPrice: 150 },
        { coin: 'ARB', size: 100, entryPrice: 1.2 },
      ])

      expect(restored).toEqual([{ coin: 'SOL', size: 2, positionId: 'sol-pos' }])
    })
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
      expect(tp.isMarket).toBe(true)   // TP = trigger-market
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

    it('uses Bybit position-level stop update without requiring triggerOrders', async () => {
      const order = makeOrder({
        status: 'filled',
        strategyId: 'smc-sd',
        exchange: 'BB',
        slPrice: 49000,
      })
      injectOrder(om, order)

      const modifyTrigger = mock(() =>
        Promise.resolve({ success: true, oid: 67890, avgPx: null, totalSz: null, status: 'modified', error: null }),
      )
      const updatePositionStop = mock(() =>
        Promise.resolve({ success: true, oid: null, avgPx: null, totalSz: null, status: 'submitted', error: null }),
      )
      const bbSvc = {
        exchangeId: 'BB',
        modifyTrigger,
        updatePositionStop,
      } as unknown as IExchangeService
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool
      om.setExchangePool(fakePool)

      await om.modifySLPrice(order.id, 49500)

      expect(updatePositionStop).toHaveBeenCalledTimes(1)
      expect(modifyTrigger).toHaveBeenCalledTimes(0)
      const params = (updatePositionStop.mock.calls[0] as [{
        coin: string
        positionSide: 'long' | 'short'
        triggerPrice: number
        tpsl: 'tp' | 'sl'
      }])[0]
      expect(params.coin).toBe('BTC')
      expect(params.positionSide).toBe('long')
      expect(params.triggerPrice).toBe(49500)
      expect(params.tpsl).toBe('sl')
    })

    it('keeps HL path on modifyTrigger for trailing SL updates', async () => {
      const order = makeOrder({
        status: 'filled',
        strategyId: 'smc-sd',
        exchange: 'HL',
      })
      injectOrder(om, order)
      injectTriggers(om, order.id, [{
        type: 'sl',
        coin: 'BTC',
        side: 'short',
        triggerPrice: 49000,
        size: 0.1,
        isMarket: true,
        cloid: generateCloid(),
        exchangeOrderId: '67890',
        parentOrderId: order.id,
      }])

      const modifyTrigger = mock(() =>
        Promise.resolve({ success: true, oid: 67890, avgPx: null, totalSz: null, status: 'modified', error: null }),
      )
      const updatePositionStop = mock(() =>
        Promise.resolve({ success: true, oid: null, avgPx: null, totalSz: null, status: 'submitted', error: null }),
      )
      const hlSvc = {
        exchangeId: 'HL',
        modifyTrigger,
        updatePositionStop,
      } as unknown as IExchangeService
      const fakePool = {
        isInitialized: () => true,
        get: () => hlSvc,
      } as unknown as ExchangePool
      om.setExchangePool(fakePool)

      await om.modifySLPrice(order.id, 49500)

      expect(modifyTrigger).toHaveBeenCalledTimes(1)
      expect(updatePositionStop).toHaveBeenCalledTimes(0)
      expect(om.getTriggerOrders(order.id).find(t => t.type === 'sl')?.triggerPrice).toBe(49500)
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

    it('executes partial_close and mirrors remaining protection size', async () => {
      const order = makeOrder({
        status: 'filled',
        fillPrice: 50000,
        fillSize: 2,
        positionId: 'pos-1',
      })
      injectOrder(om, order)
      injectTriggers(om, order.id, [
        { type: 'sl', coin: 'BTC', side: 'short', triggerPrice: 49000, size: 2, isMarket: true, cloid: generateCloid(), exchangeOrderId: '111', parentOrderId: order.id },
        { type: 'tp', coin: 'BTC', side: 'short', triggerPrice: 52000, size: 2, isMarket: true, cloid: generateCloid(), exchangeOrderId: '222', parentOrderId: order.id },
      ])
      om.setPositionSizeResolver(() => 2)

      await om.handleAction({ type: 'partial_close', positionId: 'pos-1', closePct: 0.25 })

      expect(partialCloseEvents).toEqual([{ positionId: 'pos-1', closePct: 0.25 }])
      const triggers = getTriggerOrdersMap(om).get(order.id) ?? []
      expect(triggers[0]?.size).toBeCloseTo(1.5, 8)
      expect(triggers[1]?.size).toBeCloseTo(1.5, 8)
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
        isMarket: true,
        cloid: generateCloid(),
        exchangeOrderId: null,
        parentOrderId: 'test-order-id',
      })
      expect(result.success).toBe(true)
      expect(result.exchangeOrderId).toStartWith('paper_trigger_')
    })
  })
})
