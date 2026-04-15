import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

let hlSingletonFallbackCalls = 0
const hlSingletonService = {
  exchangeId: 'HL',
  getCachedAccountValue: () => 10_000,
}

mock.module('../../src/execution/exchange-service.js', () => ({
  getExchangeService: () => {
    hlSingletonFallbackCalls++
    return hlSingletonService
  },
}))

import { OrderManager } from '../../src/agent/order-manager.js'

type OrderManagerPrivateApi = {
  getExchange: () => unknown
}

function callGetExchange(orderManager: OrderManager): unknown {
  return (orderManager as unknown as OrderManagerPrivateApi).getExchange()
}

describe('OrderManager BB fallback guard', () => {
  beforeEach(() => {
    hlSingletonFallbackCalls = 0
    process.env.ACTIVE_EXCHANGE = 'HL'
  })

  afterEach(() => {
    delete process.env.ACTIVE_EXCHANGE
  })

  it('blocks HL singleton fallback in BB live mode when pool is missing', () => {
    process.env.ACTIVE_EXCHANGE = 'BB'

    const om = new OrderManager()
    expect(() => callGetExchange(om)).toThrow('ExchangePool must be initialized in BB live mode')
    expect(hlSingletonFallbackCalls).toBe(0)
  })

  it('keeps HL fallback in HL live mode', () => {
    process.env.ACTIVE_EXCHANGE = 'HL'

    const om = new OrderManager()
    const svc = callGetExchange(om)

    expect(svc).toBe(hlSingletonService)
    expect(hlSingletonFallbackCalls).toBe(1)
  })
})
