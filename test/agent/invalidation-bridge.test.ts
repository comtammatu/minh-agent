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
    type: 'smc-sd',
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
    strategyId: 'smc-sd',
    ...overrides,
  }
}

describe('parseCoinFromSetupId', () => {
  it('parses coin from modern setupId format strategyId:COIN|interval|type', () => {
    expect(parseCoinFromSetupId('layered:BTC|1h|order-block')).toBe('BTC')
    expect(parseCoinFromSetupId('alpha:ETH|15m|smc-sd')).toBe('ETH')
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
    expect(parseStrategyFromSetupId('alpha:BTC|1h|smc-sd')).toBe('alpha')
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
    const layeredSetup = makeSetup({ id: 'layered:BTC|1h|order-block', strategyId: 'smc-sd' })
    const quantSetup = makeSetup({ id: 'alpha:BTC|1h|smc-sd', type: 'smc-sd', strategyId: 'alpha' })

    agent.dispatch('BTC', { type: 'setup_detected', setup: layeredSetup }, 'smc-sd')
    agent.dispatch('BTC', { type: 'setup_detected', setup: quantSetup }, 'alpha')

    // Invalidate quant only
    bridge.onInvalidation('alpha:BTC|1h|smc-sd', 'expired', agent)

    expect(agent.getCoinState('BTC', 'alpha')).toBe('IDLE')
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('ENTERING')
  })
})

