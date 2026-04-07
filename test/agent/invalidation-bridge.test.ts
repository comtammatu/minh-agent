import { describe, it, expect, beforeEach } from 'bun:test'
import {
  InvalidationBridge,
  parseCoinFromSetupId,
  parseStrategyFromSetupId,
  resetInvalidationBridge,
} from '../../src/agent/invalidation-bridge.js'
import { TradingAgent, resetAgent } from '../../src/agent/trading-agent.js'
import type { ActiveSetup } from '../../src/types.js'

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: 'layered:BTC|1h|order-block',
    coin: 'BTC',
    interval: '1h',
    type: 'order-block',
    side: 'long',
    confidence: 0.75,
    entryPrice: 50000,
    slPrice: 49000,
    tpPrice: 52000,
    patternData: {},
    detectedAt: Date.now(),
    detectedAtBar: 100,
    expiresAtBar: 120,
    confluenceGrade: 'B',
    confluenceCount: 4,
    strategyId: 'layered',
    ...overrides,
  }
}

describe('parseCoinFromSetupId', () => {
  it('parses coin from modern setupId format strategyId:COIN|interval|type', () => {
    expect(parseCoinFromSetupId('layered:BTC|1h|order-block')).toBe('BTC')
    expect(parseCoinFromSetupId('quant:ETH|15m|ema-rsi')).toBe('ETH')
    expect(parseCoinFromSetupId('smc-sd:1000PEPE|1h|smc-sd')).toBe('1000PEPE')
  })

  it('parses coin from legacy setupId format COIN|interval|type|side', () => {
    expect(parseCoinFromSetupId('BTC|1h|order-block|long')).toBe('BTC')
  })

  it('returns null for malformed setupId', () => {
    expect(parseCoinFromSetupId('')).toBeNull()
    expect(parseCoinFromSetupId('BTC|1h')).toBeNull()
    expect(parseCoinFromSetupId('layered:|1h|order-block')).toBeNull()
  })
})

describe('parseStrategyFromSetupId', () => {
  it('returns strategy id for modern format', () => {
    expect(parseStrategyFromSetupId('quant:BTC|1h|ema-rsi')).toBe('quant')
    expect(parseStrategyFromSetupId('smc-sd:1000PEPE|1h|smc-sd')).toBe('smc-sd')
  })

  it('returns legacy bucket when no prefix', () => {
    expect(parseStrategyFromSetupId('BTC|1h|order-block|long')).toBe('legacy')
  })
})

describe('InvalidationBridge.onInvalidation', () => {
  let agent: TradingAgent
  let bridge: InvalidationBridge

  beforeEach(() => {
    resetAgent()
    resetInvalidationBridge()
    agent = new TradingAgent()
    bridge = new InvalidationBridge()
  })

  it('dispatches setup_invalidated to the correct strategy when setupId matches', () => {
    // Put both strategies into ENTERING with distinct setup ids
    const layeredSetup = makeSetup({ id: 'layered:BTC|1h|order-block', strategyId: 'layered' })
    const quantSetup = makeSetup({ id: 'quant:BTC|1h|ema-rsi', type: 'ema-rsi', strategyId: 'quant' })

    agent.dispatch('BTC', { type: 'setup_detected', setup: layeredSetup }, 'layered')
    agent.dispatch('BTC', { type: 'setup_detected', setup: quantSetup }, 'quant')

    // Invalidate quant only
    bridge.onInvalidation('quant:BTC|1h|ema-rsi', 'expired', agent)

    expect(agent.getCoinState('BTC', 'quant')).toBe('IDLE')
    expect(agent.getCoinState('BTC', 'layered')).toBe('ENTERING')
  })
})

