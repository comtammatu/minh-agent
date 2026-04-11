/**
 * Strategy Registry tests — Sprint 4.5 S1.
 *
 * Tests cover:
 *   1. IStrategy interface contract
 *   2. StrategyRegistry: register, getAll, get, enable/disable
 *   3. StrategyRegistry: runAll fan-out, error isolation
 *   4. StrategyRegistry: activateOnly (backtest isolation)
 *   5. StrategyRegistry: disable guard
 *   6. SmcSdStrategy adapter
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import type { Candle, CandleInterval, Signal, PatternType } from '../src/types.js'
import { StrategyRegistry, resetStrategyRegistry, getStrategyRegistry } from '../src/strategy/registry.js'
import type { IStrategy } from '../src/strategy/registry.js'
import { SmcSdStrategy } from '../src/strategy/strategies/smc-sd/index.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeCandle(close: number, t: number = 0): Candle {
  return { t, o: close, h: close + 1, l: close - 1, c: close, v: 100 }
}

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => makeCandle(100 + i, i * 60000))
}

/** Minimal IStrategy implementation for testing. */
function mockStrategy(overrides: Partial<IStrategy> = {}): IStrategy {
  return {
    id: overrides.id ?? 'mock',
    name: overrides.name ?? 'Mock Strategy',
    patternTypes: overrides.patternTypes ?? ['smc-sd' as PatternType],
    scan: overrides.scan ?? (() => null),
    minCandles: overrides.minCandles ?? (() => 10),
    clearState: overrides.clearState ?? (() => {}),
  }
}

/** Strategy that returns a Signal. */
function signalStrategy(id: string, signal: Signal): IStrategy {
  return mockStrategy({
    id,
    scan: () => signal,
  })
}

/** Strategy that throws. */
function throwingStrategy(id: string): IStrategy {
  return mockStrategy({
    id,
    scan: () => { throw new Error(`${id} exploded`) },
  })
}

const testSignal: Signal = {
  type: 'smc-sd',
  side: 'long',
  confidence: 0.6,
  entryPrice: 100,
  slPrice: 95,
  tpPrice: 110,
  patternData: {},
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StrategyRegistry', () => {
  let registry: StrategyRegistry

  beforeEach(() => {
    registry = new StrategyRegistry()
    resetStrategyRegistry()
  })

  // ── Registration ──────────────────────────────────────────────────────────

  describe('register', () => {
    test('registers a strategy', () => {
      const s = mockStrategy({ id: 'test' })
      registry.register(s)
      expect(registry.size).toBe(1)
      expect(registry.get('test')).toBe(s)
    })

    test('rejects duplicate IDs', () => {
      registry.register(mockStrategy({ id: 'dup' }))
      expect(() => registry.register(mockStrategy({ id: 'dup' }))).toThrow("Strategy 'dup' already registered")
    })

    test('registers multiple strategies', () => {
      registry.register(mockStrategy({ id: 'a' }))
      registry.register(mockStrategy({ id: 'b' }))
      registry.register(mockStrategy({ id: 'c' }))
      expect(registry.size).toBe(3)
    })
  })

  describe('getAll', () => {
    test('returns empty array when no strategies', () => {
      expect(registry.getAll()).toEqual([])
    })

    test('returns all registered strategies', () => {
      registry.register(mockStrategy({ id: 'x' }))
      registry.register(mockStrategy({ id: 'y' }))
      const all = registry.getAll()
      expect(all).toHaveLength(2)
      expect(all.map(s => s.id).sort()).toEqual(['x', 'y'])
    })
  })

  describe('get', () => {
    test('returns strategy by ID', () => {
      const s = mockStrategy({ id: 'find-me' })
      registry.register(s)
      expect(registry.get('find-me')).toBe(s)
    })

    test('returns undefined for unknown ID', () => {
      expect(registry.get('nope')).toBeUndefined()
    })
  })

  // ── Enable / Disable ──────────────────────────────────────────────────────

  describe('enable/disable', () => {
    test('strategies are enabled by default after register', () => {
      registry.register(mockStrategy({ id: 'test' }))
      expect(registry.isEnabled('test')).toBe(true)
    })

    test('disable marks strategy as not enabled', () => {
      registry.register(mockStrategy({ id: 'test' }))
      registry.disable('test')
      expect(registry.isEnabled('test')).toBe(false)
    })

    test('enable restores disabled strategy', () => {
      registry.register(mockStrategy({ id: 'test' }))
      registry.disable('test')
      registry.enable('test')
      expect(registry.isEnabled('test')).toBe(true)
    })

    test('disable throws for unregistered strategy', () => {
      expect(() => registry.disable('ghost')).toThrow("Strategy 'ghost' not registered")
    })

    test('enable throws for unregistered strategy', () => {
      expect(() => registry.enable('ghost')).toThrow("Strategy 'ghost' not registered")
    })

    test('getEnabledIds returns only enabled', () => {
      registry.register(mockStrategy({ id: 'a' }))
      registry.register(mockStrategy({ id: 'b' }))
      registry.register(mockStrategy({ id: 'c' }))
      registry.disable('b')
      expect(registry.getEnabledIds().sort()).toEqual(['a', 'c'])
    })
  })

  // ── runAll ────────────────────────────────────────────────────────────────

  describe('runAll', () => {
    const candles = makeCandles(250)
    const idx = candles.length - 2

    test('calls all enabled strategies', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        scan: () => { calls.push('a'); return null },
      }))
      registry.register(mockStrategy({
        id: 'b',
        scan: () => { calls.push('b'); return null },
      }))
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['a', 'b'])
    })

    test('skips disabled strategies', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        scan: () => { calls.push('a'); return null },
      }))
      registry.register(mockStrategy({
        id: 'b',
        scan: () => { calls.push('b'); return null },
      }))
      registry.disable('a')
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['b'])
    })

    test('returns signals from strategies that return non-null', () => {
      registry.register(signalStrategy('sig', testSignal))
      registry.register(mockStrategy({ id: 'null-ret' }))  // returns null
      const results = registry.runAll('BTC', '1h', candles, idx)
      expect(results).toHaveLength(1)
      expect(results[0]!.strategyId).toBe('sig')
      expect(results[0]!.signal.side).toBe('long')
    })

    test('error isolation: one strategy throws, others continue', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'good-before',
        scan: () => { calls.push('good-before'); return null },
      }))
      registry.register(throwingStrategy('bad'))
      registry.register(mockStrategy({
        id: 'good-after',
        scan: () => { calls.push('good-after'); return null },
      }))

      // Should not throw
      const results = registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['good-before', 'good-after'])
      expect(results).toHaveLength(0)
    })

    test('skips strategies with insufficient candles', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'needs-500',
        minCandles: () => 500,
        scan: () => { calls.push('needs-500'); return null },
      }))
      registry.register(mockStrategy({
        id: 'needs-10',
        minCandles: () => 10,
        scan: () => { calls.push('needs-10'); return null },
      }))
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['needs-10'])
    })

    test('returns empty array when no strategies registered', () => {
      const results = registry.runAll('BTC', '1h', candles, idx)
      expect(results).toEqual([])
    })
  })

  // ── activateOnly ──────────────────────────────────────────────────────────

  describe('activateOnly', () => {
    const candles = makeCandles(250)
    const idx = candles.length - 2

    test('only runs the specified strategy', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        scan: () => { calls.push('a'); return null },
      }))
      registry.register(mockStrategy({
        id: 'b',
        scan: () => { calls.push('b'); return null },
      }))
      registry.activateOnly('a')
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['a'])
    })

    test('activateOnly(null) restores fan-out', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        scan: () => { calls.push('a'); return null },
      }))
      registry.register(mockStrategy({
        id: 'b',
        scan: () => { calls.push('b'); return null },
      }))
      registry.activateOnly('a')
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['a'])

      calls.length = 0
      registry.activateOnly(null)
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls.sort()).toEqual(['a', 'b'])
    })

    test('activateOnly overrides disabled state', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'disabled-but-active',
        scan: () => { calls.push('hit'); return null },
      }))
      registry.disable('disabled-but-active')
      registry.activateOnly('disabled-but-active')
      registry.runAll('BTC', '1h', candles, idx)
      expect(calls).toEqual(['hit'])
    })

    test('throws for unregistered strategy', () => {
      expect(() => registry.activateOnly('nope')).toThrow("Strategy 'nope' not registered")
    })
  })

  // ── clearAllState ─────────────────────────────────────────────────────────

  describe('clearAllState', () => {
    test('calls clearState on all strategies', () => {
      const cleared: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        clearState: () => cleared.push('a'),
      }))
      registry.register(mockStrategy({
        id: 'b',
        clearState: () => cleared.push('b'),
      }))
      registry.clearAllState()
      expect(cleared.sort()).toEqual(['a', 'b'])
    })

    test('resets activateOnly', () => {
      const calls: string[] = []
      registry.register(mockStrategy({
        id: 'a',
        scan: () => { calls.push('a'); return null },
      }))
      registry.register(mockStrategy({
        id: 'b',
        scan: () => { calls.push('b'); return null },
      }))
      registry.activateOnly('a')
      registry.clearAllState()
      registry.runAll('BTC', '1h', makeCandles(250), 248)
      expect(calls.sort()).toEqual(['a', 'b'])
    })
  })

  // ── Singleton ─────────────────────────────────────────────────────────────

  describe('getStrategyRegistry singleton', () => {
    test('returns same instance', () => {
      const r1 = getStrategyRegistry()
      const r2 = getStrategyRegistry()
      expect(r1).toBe(r2)
    })

    test('resetStrategyRegistry creates new instance', () => {
      const r1 = getStrategyRegistry()
      r1.register(mockStrategy({ id: 'test' }))
      resetStrategyRegistry()
      const r2 = getStrategyRegistry()
      expect(r2.size).toBe(0)
    })
  })
})

// ── SmcSdStrategy adapter tests ────────────────────────────────────────────

describe('SmcSdStrategy', () => {
  test('has correct id and name', () => {
    const strategy = new SmcSdStrategy()
    expect(strategy.id).toBe('smc-sd')
    expect(strategy.name).toContain('SMC')
  })

  test('patternTypes is smc-sd only', () => {
    const strategy = new SmcSdStrategy()
    expect(strategy.patternTypes).toEqual(['smc-sd'])
  })

  test('minCandles returns >= 50', () => {
    const strategy = new SmcSdStrategy()
    expect(strategy.minCandles()).toBeGreaterThanOrEqual(50)
  })

  test('scan returns null with insufficient candles', () => {
    const strategy = new SmcSdStrategy()
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100, i * 60000))
    const result = strategy.scan('BTC', '1h', candles, 8)
    expect(result).toBeNull()
  })
})
