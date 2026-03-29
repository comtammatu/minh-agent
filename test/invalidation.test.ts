import { describe, it, expect } from 'bun:test'
import { isInvalidated, computeExpiresAtBar, setupId } from '../src/scanner/invalidation.js'
import type { ActiveSetup, Candle, CandleInterval } from '../src/types.js'
import { PATTERN_TTL_BARS } from '../src/config.js'

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return { t: 1000, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

function makeSetup(
  type: ActiveSetup['type'],
  side: ActiveSetup['side'],
  patternData: Record<string, unknown>,
  detectedAtBar = 10,
): ActiveSetup {
  const expiresAtBar = computeExpiresAtBar(type, detectedAtBar)
  return {
    id: `BTC:1h:${type}:${side}`,
    coin: 'BTC',
    interval: '1h' as CandleInterval,
    type,
    side,
    confidence: 0.7,
    entryPrice: 100,
    slPrice: side === 'long' ? 95 : 105,
    tpPrice: side === 'long' ? 110 : 90,
    patternData,
    detectedAt: Date.now(),
    expiresAtBar,
  }
}

describe('invalidation — TTL', () => {
  it('invalidates when currentBar >= expiresAtBar', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 }, 0)
    const ttl = PATTERN_TTL_BARS['order-block']
    const candles = [makeCandle({ c: 100 })]  // not broken price-wise
    const result = isInvalidated(setup, candles, ttl)  // exactly at expiry
    expect(result.invalidated).toBe(true)
    expect(result.reason).toBe('ttl-expired')
  })

  it('does not invalidate before TTL', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 }, 0)
    const candles: Candle[] = Array(5).fill(null).map(() => makeCandle({ c: 100 }))
    const result = isInvalidated(setup, candles, 1)
    expect(result.invalidated).toBe(false)
  })
})

describe('invalidation — order-block', () => {
  it('long: invalidates when close below obBottom', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 })
    const candles = [makeCandle({ c: 97 })]  // closed below bottom
    expect(isInvalidated(setup, candles, 0).reason).toBe('zone-broken')
  })

  it('long: no invalidation when close inside OB', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 })
    const candles = [makeCandle({ c: 100 })]
    expect(isInvalidated(setup, candles, 0).invalidated).toBe(false)
  })

  it('short: invalidates when close above obTop', () => {
    const setup = makeSetup('order-block', 'short', { obTop: 105, obBottom: 100 })
    const candles = [makeCandle({ c: 106 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('zone-broken')
  })
})

describe('invalidation — fvg', () => {
  it('long: invalidates when close below fvgBottom', () => {
    const setup = makeSetup('fvg', 'long', { fvgTop: 105, fvgBottom: 100 })
    const candles = [makeCandle({ c: 99 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('fvg-filled')
  })

  it('short: invalidates when close above fvgTop', () => {
    const setup = makeSetup('fvg', 'short', { fvgTop: 110, fvgBottom: 105 })
    const candles = [makeCandle({ c: 111 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('fvg-filled')
  })
})

describe('invalidation — spring', () => {
  it('long spring: invalidates when close below slPrice', () => {
    const setup = makeSetup('spring', 'long', { event: 'spring', phase: 'accumulation' })
    const candles = [makeCandle({ c: setup.slPrice - 1 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('spring-failed')
  })

  it('short utad: invalidates when close above slPrice', () => {
    const setup = makeSetup('spring', 'short', { event: 'utad', phase: 'distribution' })
    const candles = [makeCandle({ c: setup.slPrice + 1 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('spring-failed')
  })
})

describe('invalidation — demand-zone', () => {
  it('long: invalidates when close below zoneBottom', () => {
    const setup = makeSetup('demand-zone', 'long', { zoneTop: 105, zoneBottom: 98 })
    const candles = [makeCandle({ c: 97 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('demand-lost')
  })

  it('short: invalidates when close above zoneTop', () => {
    const setup = makeSetup('demand-zone', 'short', { zoneTop: 110, zoneBottom: 105 })
    const candles = [makeCandle({ c: 111 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('demand-lost')
  })
})

describe('invalidation — breakout', () => {
  it('long: invalidates when close back below zoneTop', () => {
    const setup = makeSetup('breakout', 'long', { zoneTop: 100, zoneBottom: 95, direction: 'bullish-breakout' })
    const candles = [makeCandle({ c: 99 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('breakout-failed')
  })

  it('short: invalidates when close back above zoneBottom', () => {
    const setup = makeSetup('breakout', 'short', { zoneTop: 100, zoneBottom: 95, direction: 'bearish-breakdown' })
    const candles = [makeCandle({ c: 96 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('breakout-failed')
  })
})

describe('invalidation — vsa-signal and price-action', () => {
  it('vsa long: invalidates when close below slPrice', () => {
    const setup = makeSetup('vsa-signal', 'long', { vsaType: 'stopping-volume' })
    const candles = [makeCandle({ c: setup.slPrice - 1 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('pattern-failed')
  })

  it('price-action short: invalidates when close above slPrice', () => {
    const setup = makeSetup('price-action', 'short', { pattern: 'pin_bar' })
    const candles = [makeCandle({ c: setup.slPrice + 1 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('pattern-failed')
  })
})

describe('invalidation — volume-profile', () => {
  it('long poc: invalidates when close decisively below poc', () => {
    const poc = 100
    const setup = makeSetup('volume-profile', 'long', { level: 'poc', poc, vah: 110, val: 90 })
    const tolerance = poc * 0.004
    const candles = [makeCandle({ c: poc - tolerance - 1 })]
    expect(isInvalidated(setup, candles, 0).reason).toBe('va-broken')
  })
})

describe('setupId', () => {
  it('generates correct id', () => {
    expect(setupId('BTC', '4h', 'fvg')).toBe('BTC:4h:fvg')
  })
})

describe('computeExpiresAtBar', () => {
  it('computes correct bar using TTL', () => {
    const ttl = PATTERN_TTL_BARS['fvg']
    expect(computeExpiresAtBar('fvg', 100)).toBe(100 + ttl)
  })
})
