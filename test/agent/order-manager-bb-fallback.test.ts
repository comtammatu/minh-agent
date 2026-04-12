import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setPaperTradeRuntimeOverride, resetPaperTradeRuntimeOverrideForTests } from '../../src/config.js'

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
  getExchangeForStrategy: (strategyId: string) => unknown
}

function callGetExchangeForStrategy(orderManager: OrderManager): unknown {
  return (orderManager as unknown as OrderManagerPrivateApi).getExchangeForStrategy('smc-sd')
}

describe('OrderManager BB fallback guard', () => {
  beforeEach(() => {
    hlSingletonFallbackCalls = 0
    process.env.ACTIVE_EXCHANGE = 'HL'
    setPaperTradeRuntimeOverride(false)
  })

  afterEach(() => {
    delete process.env.ACTIVE_EXCHANGE
    resetPaperTradeRuntimeOverrideForTests()
  })

  it('blocks HL singleton fallback in BB live mode when pool is missing', () => {
    process.env.ACTIVE_EXCHANGE = 'BB'
    setPaperTradeRuntimeOverride(false)

    const om = new OrderManager()
    expect(() => callGetExchangeForStrategy(om)).toThrow('ExchangePool must be initialized in BB live mode')
    expect(hlSingletonFallbackCalls).toBe(0)
  })

  it('keeps HL fallback in HL live mode', () => {
    process.env.ACTIVE_EXCHANGE = 'HL'
    setPaperTradeRuntimeOverride(false)

    const om = new OrderManager()
    const svc = callGetExchangeForStrategy(om)

    expect(svc).toBe(hlSingletonService)
    expect(hlSingletonFallbackCalls).toBe(1)
  })

  it('keeps fallback in paper mode even when ACTIVE_EXCHANGE=BB', () => {
    process.env.ACTIVE_EXCHANGE = 'BB'
    setPaperTradeRuntimeOverride(true)

    const om = new OrderManager()
    const svc = callGetExchangeForStrategy(om)

    expect(svc).toBe(hlSingletonService)
    expect(hlSingletonFallbackCalls).toBe(1)
  })
})
