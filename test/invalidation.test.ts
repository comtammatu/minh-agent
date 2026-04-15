import { describe, it, expect } from 'bun:test'
import { isInvalidated, computeExpiresAtBar, setupId } from '../src/strategy/shared/invalidation.js'
import type { ActiveSetup, Candle, CandleInterval } from '../src/types.js'
import { PATTERN_TTL_BARS } from '../src/config.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

function makeSetup(
  side: ActiveSetup['side'],
  patternData: Record<string, unknown>,
  detectedAtBar = 10,
): ActiveSetup {
  const expiresAtBar = computeExpiresAtBar('smc-sd', detectedAtBar)
  return {
    id: `BTC|1h|smc-sd|${side}`,
    coin: 'BTC',
    interval: '1h' as CandleInterval,
    type: 'smc-sd',
    side,
    confidence: 0.7,
    entryPrice: 100,
    slPrice: side === 'long' ? 95 : 105,
    tpPrice: side === 'long' ? 110 : 90,
    patternData,
    detectedAt: Date.now(),
    detectedAtBar,
    expiresAtBar,
  }
}

describe('invalidation — TTL', () => {
  it('invalidates when currentBar >= expiresAtBar', () => {
    const setup = makeSetup('long', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 0)
    const ttl = PATTERN_TTL_BARS['smc-sd']!
    const candles = [makeCandle({ c: 100 })]
    const result = isInvalidated(setup, candles, ttl)
    expect(result.invalidated).toBe(true)
    expect(result.reason).toBe('ttl-expired')
  })

  it('does not invalidate before TTL', () => {
    const setup = makeSetup('long', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 0)
    const candles: Candle[] = Array(5).fill(null).map(() => makeCandle({ c: 100 }))
    const result = isInvalidated(setup, candles, 1)
    expect(result.invalidated).toBe(false)
  })
})

describe('invalidation — smc-sd zone', () => {
  it('long: invalidates when close below zoneBottom - ATR buffer', () => {
    const atr = 2
    const zoneBottom = 98
    const setup = makeSetup('long', { zoneBottom, zoneTop: 102, atrAtEntry: atr }, 0)
    const breakPrice = zoneBottom - atr * 0.5 - 0.01
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: breakPrice })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('zone-broken')
  })

  it('long: no invalidation when close inside zone', () => {
    const setup = makeSetup('long', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 99 })]
    expect(isInvalidated(setup, candles, 1).invalidated).toBe(false)
  })

  it('short: invalidates when close above zoneTop + ATR buffer', () => {
    const atr = 2
    const zoneTop = 102
    const setup = makeSetup('short', { zoneBottom: 98, zoneTop, atrAtEntry: atr }, 0)
    const breakPrice = zoneTop + atr * 0.5 + 0.01
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: breakPrice })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('zone-broken')
  })

  it('short: no invalidation when close inside zone', () => {
    const setup = makeSetup('short', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 101 })]
    expect(isInvalidated(setup, candles, 1).invalidated).toBe(false)
  })
})

describe('invalidation — 0-bar skip', () => {
  it('does NOT invalidate on the bar where setup was created', () => {
    const setup = makeSetup('long', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 5)
    const candles: Candle[] = Array(10).fill(null).map(() => makeCandle({ c: 90 }))
    expect(isInvalidated(setup, candles, 5).invalidated).toBe(false)
    expect(isInvalidated(setup, candles, 6).invalidated).toBe(true)
  })

  it('does NOT invalidate on bars before detectedAtBar', () => {
    const setup = makeSetup('long', { zoneBottom: 98, zoneTop: 102, atrAtEntry: 2 }, 5)
    const candles: Candle[] = Array(10).fill(null).map(() => makeCandle({ c: 90 }))
    expect(isInvalidated(setup, candles, 3).invalidated).toBe(false)
  })
})

describe('setupId', () => {
  it('generates canonical id without strategy prefix', () => {
    expect(setupId('BTC', '4h', 'smc-sd')).toBe('BTC|4h|smc-sd')
  })

  it('ignores extra trailing args and still returns the canonical id', () => {
    expect(setupId('BTC', '4h', 'smc-sd', 'alpha')).toBe('BTC|4h|smc-sd')
  })

  it('same coin/tf/type always resolves to the same canonical id', () => {
    const a = setupId('ETH', '1h', 'smc-sd', 'smc-sd')
    const b = setupId('ETH', '1h', 'smc-sd', 'alpha')
    expect(a).toBe(b)
  })
})

describe('computeExpiresAtBar', () => {
  it('computes correct bar using TTL', () => {
    const ttl = PATTERN_TTL_BARS['smc-sd']!
    expect(computeExpiresAtBar('smc-sd', 100)).toBe(100 + ttl)
  })
})
