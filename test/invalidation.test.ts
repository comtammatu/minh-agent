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
    detectedAtBar,
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
  it('long: invalidates when close below obBottom (bar after entry)', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 97 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('zone-broken')
  })

  it('long: no invalidation when close inside OB', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 100 })]
    expect(isInvalidated(setup, candles, 1).invalidated).toBe(false)
  })

  it('short: invalidates when close above obTop (bar after entry)', () => {
    const setup = makeSetup('order-block', 'short', { obTop: 105, obBottom: 100 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 106 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('zone-broken')
  })
})

describe('invalidation — fvg', () => {
  it('long: invalidates when close below fvgBottom', () => {
    const setup = makeSetup('fvg', 'long', { fvgTop: 105, fvgBottom: 100 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 99 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('fvg-filled')
  })

  it('short: invalidates when close above fvgTop', () => {
    const setup = makeSetup('fvg', 'short', { fvgTop: 110, fvgBottom: 105 }, 0)
    const candles = [makeCandle({ c: 108 }), makeCandle({ c: 111 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('fvg-filled')
  })
})

describe('invalidation — spring', () => {
  it('long spring: invalidates when close below slPrice', () => {
    const setup = makeSetup('spring', 'long', { event: 'spring', phase: 'accumulation' }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: setup.slPrice - 1 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('spring-failed')
  })

  it('short utad: invalidates when close above slPrice', () => {
    const setup = makeSetup('spring', 'short', { event: 'utad', phase: 'distribution' }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: setup.slPrice + 1 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('spring-failed')
  })
})

describe('invalidation — demand-zone', () => {
  it('long: invalidates when close below zoneBottom', () => {
    const setup = makeSetup('demand-zone', 'long', { zoneTop: 105, zoneBottom: 98 }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: 97 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('demand-lost')
  })

  it('short: invalidates when close above zoneTop', () => {
    const setup = makeSetup('demand-zone', 'short', { zoneTop: 110, zoneBottom: 105 }, 0)
    const candles = [makeCandle({ c: 108 }), makeCandle({ c: 111 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('demand-lost')
  })
})

describe('invalidation — breakout', () => {
  it('long: invalidates when close back below zoneTop', () => {
    const setup = makeSetup('breakout', 'long', { zoneTop: 100, zoneBottom: 95, direction: 'bullish-breakout' }, 0)
    const candles = [makeCandle({ c: 101 }), makeCandle({ c: 99 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('breakout-failed')
  })

  it('short: invalidates when close back above zoneBottom', () => {
    const setup = makeSetup('breakout', 'short', { zoneTop: 100, zoneBottom: 95, direction: 'bearish-breakdown' }, 0)
    const candles = [makeCandle({ c: 94 }), makeCandle({ c: 96 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('breakout-failed')
  })
})

describe('invalidation — vsa-signal and price-action', () => {
  it('vsa long: invalidates when close below slPrice', () => {
    const setup = makeSetup('vsa-signal', 'long', { vsaType: 'stopping-volume' }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: setup.slPrice - 1 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('pattern-failed')
  })

  it('price-action short: invalidates when close above slPrice', () => {
    const setup = makeSetup('price-action', 'short', { pattern: 'pin_bar' }, 0)
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: setup.slPrice + 1 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('pattern-failed')
  })
})

describe('invalidation — volume-profile', () => {
  it('long poc: invalidates when close decisively below poc', () => {
    const poc = 100
    const setup = makeSetup('volume-profile', 'long', { level: 'poc', poc, vah: 110, val: 90 }, 0)
    const tolerance = poc * 0.004
    const candles = [makeCandle({ c: 100 }), makeCandle({ c: poc - tolerance - 1 })]
    expect(isInvalidated(setup, candles, 1).reason).toBe('va-broken')
  })
})

describe('invalidation — 0-bar skip', () => {
  it('does NOT invalidate on the bar where setup was created', () => {
    // Spring setup created at bar 5 — candle at bar 5 has wick below SL
    // This is the entry bar, trade hasn't had a chance to work out
    const setup = makeSetup('spring', 'long', { event: 'spring', phase: 'accumulation' }, 5)
    const candles: Candle[] = Array(10).fill(null).map(() => makeCandle({ c: setup.slPrice - 1 }))
    // Check at bar 5 (entry bar) — should NOT invalidate
    expect(isInvalidated(setup, candles, 5).invalidated).toBe(false)
    // Check at bar 6 (first bar after entry) — SHOULD invalidate
    expect(isInvalidated(setup, candles, 6).invalidated).toBe(true)
    expect(isInvalidated(setup, candles, 6).reason).toBe('spring-failed')
  })

  it('does NOT invalidate on bars before detectedAtBar', () => {
    const setup = makeSetup('order-block', 'long', { obTop: 102, obBottom: 98 }, 5)
    const candles: Candle[] = Array(10).fill(null).map(() => makeCandle({ c: 90 }))
    // Bar 3 is before detection — should not invalidate
    expect(isInvalidated(setup, candles, 3).invalidated).toBe(false)
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
