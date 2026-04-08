/**
 * End-to-end integration test (Sprint 2 S16).
 *
 * Tests the full agent wiring: setup event → state transition → order placement
 * → fill → position tracking → exit. All with mocked ExchangeService + DB.
 *
 * Validates that index.ts wiring pattern works correctly.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { EventEmitter } from 'events'

// Mock DB before any imports
mock.module('../db/connection.js', () => {
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === 'end') return () => Promise.resolve()
      return () => Promise.resolve([])
    },
    apply() {
      return Promise.resolve([])
    },
  }
  const sqlProxy = new Proxy(function () { return Promise.resolve([]) } as unknown as object, handler)
  return { sql: sqlProxy }
})

// Mock ExchangeService — all operations succeed
mock.module('../execution/hl-exchange-service.js', () => ({
  getHLExchangeService: () => ({
    getCachedAccountValue: () => 10_000,
    setLeverage: () => Promise.resolve(),
    placeOrder: () => Promise.resolve({
      success: true, oid: 12345, avgPx: 50000, totalSz: 0.1, status: 'filled', error: null,
    }),
    placeTrigger: () => Promise.resolve({
      success: true, oid: 67890, avgPx: null, totalSz: null, status: 'waitingForTrigger', error: null,
    }),
    cancelByOid: () => Promise.resolve({
      success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null,
    }),
    cancelByCloid: () => Promise.resolve({
      success: true, oid: null, avgPx: null, totalSz: null, status: 'cancelled', error: null,
    }),
    modifyTrigger: () => Promise.resolve({
      success: true, oid: 67890, avgPx: null, totalSz: null, status: 'modified', error: null,
    }),
    getPositions: () => Promise.resolve([]),
    getFillAggregateByCloid: () => Promise.resolve(null),
  }),
}))

import { TradingAgent, getAgent, resetAgent } from './trading-agent.js'
import { OrderManager, getOrderManager, resetOrderManager } from './order-manager.js'
import { PositionMonitor, getPositionMonitor, resetPositionMonitor } from './position-monitor.js'
import { InvalidationBridge, getInvalidationBridge, resetInvalidationBridge } from './invalidation-bridge.js'
import type { ActiveSetup, AgentAction } from './types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: 'BTC|15m|order-block|long',
    coin: 'BTC',
    interval: '15m',
    detectedAt: Date.now(),
    detectedAtBar: 0,
    expiresAtBar: 100,
    type: 'order-block',
    side: 'long',
    confidence: 0.85,
    entryPrice: 50000,
    slPrice: 49500,
    tpPrice: 51500,
    patternData: {},
    confluenceGrade: 'A',
    confluenceCount: 3,
    riskAssessment: {
      tradeable: true,
      suggestedSize: 'standard',
      minRR: 2,
      stopMethod: 'structure',
    },
    exchange: 'HL',
    ...overrides,
  }
}

/** Get coin state from snapshot. Key is `coin:strategyId` (Sprint 4.5). */
function getCoinState(agent: TradingAgent, coin: string, strategyId: string = 'layered') {
  return agent.getSnapshot().coins[`${coin}:${strategyId}`]
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('End-to-end integration', () => {
  let agent: TradingAgent
  let om: OrderManager
  let pm: PositionMonitor
  let bridge: InvalidationBridge
  let pipelineEmitter: EventEmitter
  let actions: AgentAction[]

  beforeEach(() => {
    resetAgent()
    resetOrderManager()
    resetPositionMonitor()
    resetInvalidationBridge()

    agent = getAgent()
    om = getOrderManager()
    pm = getPositionMonitor()
    bridge = getInvalidationBridge()
    pipelineEmitter = new EventEmitter()
    actions = []

    // Wire exactly like index.ts does
    agent.subscribeToPipeline(pipelineEmitter)
    bridge.connect(pipelineEmitter, agent)
    agent.onAction(action => {
      actions.push(action)
      om.handleAction(action)
    })
    om.setAgentDispatch((coin, event) => agent.dispatch(coin, event))
    pm.setAgentDispatch((coin, event) => agent.dispatch(coin, event))
  })

  it('setup event transitions agent from IDLE → ENTERING', () => {
    const setup = makeSetup()
    pipelineEmitter.emit('setup', setup)

    const btc = getCoinState(agent, 'BTC')
    expect(btc).toBeDefined()
    expect(btc.state).toBe('ENTERING')
  })

  it('setup in ENTERING stays ENTERING (already placing order)', () => {
    const setup = makeSetup()

    // First setup → ENTERING
    pipelineEmitter.emit('setup', setup)
    expect(getCoinState(agent, 'BTC').state).toBe('ENTERING')

    // Same setup again — stays ENTERING (handleEntering ignores setup_detected)
    pipelineEmitter.emit('setup', setup)
    expect(getCoinState(agent, 'BTC').state).toBe('ENTERING')
  })

  it('full lifecycle: IDLE → ENTERING → fill → IN_POSITION → exit → IDLE', () => {
    const setup = makeSetup()

    // IDLE → ENTERING (place_order emitted)
    pipelineEmitter.emit('setup', setup)
    expect(getCoinState(agent, 'BTC').state).toBe('ENTERING')

    // ENTERING → IN_POSITION (order filled)
    agent.dispatch('BTC', {
      type: 'order_filled',
      orderId: 'ord-1',
      fillPrice: 50000,
      positionId: 'pos-btc-1',
    })
    expect(getCoinState(agent, 'BTC').state).toBe('IN_POSITION')

    // IN_POSITION → EXITING (TP hit)
    agent.dispatch('BTC', {
      type: 'tp_hit',
      positionId: 'pos-btc-1',
      closePrice: 51500,
      pnl: 150,
    })
    expect(getCoinState(agent, 'BTC').state).toBe('EXITING')

    // EXITING → IDLE (position closed)
    agent.dispatch('BTC', {
      type: 'position_closed',
      positionId: 'pos-btc-1',
      closePrice: 51500,
      pnl: 150,
      reason: 'tp_hit',
    })
    expect(getCoinState(agent, 'BTC').state).toBe('IDLE')
  })

  it('invalidation event transitions ENTERING → IDLE', () => {
    const setup = makeSetup()
    pipelineEmitter.emit('setup', setup)
    expect(getCoinState(agent, 'BTC').state).toBe('ENTERING')

    // Emit invalidation with matching setupId — cancels pending order
    pipelineEmitter.emit('invalidation', setup.id, 'zone_broken')
    expect(getCoinState(agent, 'BTC').state).toBe('IDLE')
  })

  it('pause/resume works through agent', () => {
    const setup = makeSetup()
    pipelineEmitter.emit('setup', setup)

    agent.pauseAll('test pause')
    expect(getCoinState(agent, 'BTC').state).toBe('PAUSED')

    agent.resumeAll()
    // After resume, goes back to IDLE (setup expired)
    expect(getCoinState(agent, 'BTC').state).toBe('IDLE')
  })

  it('OrderManager dispatches back to agent on fill', async () => {
    const setup = makeSetup()

    // Direct order placement via OrderManager
    const order = await om.placeOrder(setup)
    expect(order).toBeDefined()
    // Paper trade fills synchronously → status is already 'filled'
    expect(['submitted', 'filled']).toContain(order.status)

    // Simulate fill callback
    om.onOrderFilled(order.id, 50000)
    await new Promise(r => setTimeout(r, 50))

    // Agent should have received order_filled event via dispatch callback
    const btc = getCoinState(agent, 'BTC')
    expect(btc).toBeDefined()
  })

  it('PositionMonitor tracks opened positions', () => {
    pm.openPosition({
      positionId: 'pos-1',
      coin: 'BTC',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
      slPrice: 49500,
      tpPrice: 51500,
      entryOrderId: 'ord-1',
      leverage: 10,
    })

    const positions = pm.getPositions()
    expect(positions.size).toBe(1)
    expect(positions.get('pos-1')?.coin).toBe('BTC')
  })

  it('InvalidationBridge records history', () => {
    const setup = makeSetup()
    pipelineEmitter.emit('setup', setup)

    // Invalidate
    pipelineEmitter.emit('invalidation', setup.id, 'zone_broken')

    const history = bridge.getHistory()
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history[0].setupId).toBe(setup.id)

    const stats = bridge.getStats()
    expect(stats.total).toBeGreaterThanOrEqual(1)
  })

  it('multiple coins run independently', () => {
    const btcSetup = makeSetup({ coin: 'BTC', id: 'BTC|15m|order-block|long' })
    const ethSetup = makeSetup({ coin: 'ETH', id: 'ETH|15m|fvg|short', side: 'short', type: 'fvg' })

    pipelineEmitter.emit('setup', btcSetup)
    pipelineEmitter.emit('setup', ethSetup)

    expect(getCoinState(agent, 'BTC').state).toBe('ENTERING')
    expect(getCoinState(agent, 'ETH').state).toBe('ENTERING')

    // Invalidate only BTC
    pipelineEmitter.emit('invalidation', btcSetup.id, 'zone_broken')

    expect(getCoinState(agent, 'BTC').state).toBe('IDLE')
    expect(getCoinState(agent, 'ETH').state).toBe('ENTERING')
  })

  it('circuit breaker tracks daily PnL', () => {
    agent.recordPnl(-500, 10000)
    agent.recordPnl(-500, 9500)
    agent.recordPnl(-500, 9000)

    agent.checkCircuitBreakers(8500)

    const snapshot = agent.getSnapshot()
    expect(snapshot.global.dailyPnl).toBeLessThan(0)
  })
})
