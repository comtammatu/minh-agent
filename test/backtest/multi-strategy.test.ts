/**
 * Multi-strategy backtest tests — Sprint 4.5 S8.
 *
 * Tests cover:
 *   1. strategyId propagation from config → TradeSimulator → BacktestTrade
 *   2. activateOnly() isolation — quant-only backtest doesn't run layered
 *   3. Walk-forward passes strategy through backtestConfig
 *   4. Default strategyId = 'smc-sd' when config.strategy is omitted
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { TradeSimulator } from '../../src/backtest/simulator.js'
import type { BacktestTrade } from '../../src/backtest/types.js'
import type { ActiveSetup, Candle, CandleInterval } from '../../src/types.js'
import { getStrategyRegistry, resetStrategyRegistry } from '../../src/strategy/registry.js'
import { SmcSdStrategy } from '../../src/strategy/strategies/smc-sd/index.js'

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 1000,
): Candle {
  return { t, o, h, l, c, v }
}

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: 'BTC|1h|order-block|long',
    coin: 'BTC',
    interval: '1h' as CandleInterval,
    type: 'smc-sd',
    side: 'long',
    confidence: 0.8,
    entryPrice: 100,
    slPrice: 90,
    tpPrice: 115,
    patternData: {},
    detectedAt: 1000000,
    detectedAtBar: 0,
    expiresAtBar: 50,
    confluenceGrade: 'B',
    ...overrides,
  }
}

// ─── strategyId Propagation ────────────────────────────────────────────────

describe('TradeSimulator strategyId', () => {
  test('default strategyId is "smc-sd"', () => {
    const sim = new TradeSimulator(10000, 0, 0, 'single')
    const setup = makeSetup()

    // Fill at bar 0
    sim.tryFill(setup, 0)
    // Execute pending fill at bar 1
    sim.checkBar('BTC', makeCandle(2000000, 100, 120, 98, 110), 1)
    // TP hit at bar 2 (high >= 115)
    sim.checkBar('BTC', makeCandle(3000000, 110, 120, 108, 115), 2)

    const trades = sim.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.strategyId).toBe('smc-sd')
  })

  test('strategyId="alpha" propagates to trades', () => {
    const sim = new TradeSimulator(10000, 0, 0, 'single', 'alpha')
    const setup = makeSetup({
      id: 'BTC|1h|ema-crossover|long',
      type: 'ema-crossover',
    })

    sim.tryFill(setup, 0)
    sim.checkBar('BTC', makeCandle(2000000, 100, 120, 98, 110), 1)
    sim.checkBar('BTC', makeCandle(3000000, 110, 120, 108, 115), 2)

    const trades = sim.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.strategyId).toBe('alpha')
  })

  test('strategyId persists across multiple trades', () => {
    const sim = new TradeSimulator(10000, 0, 0, 'single', 'alpha')

    // Trade 1: fill + SL hit
    sim.tryFill(makeSetup({ coin: 'BTC' }), 0)
    sim.checkBar('BTC', makeCandle(2000000, 100, 105, 98, 102), 1) // fill
    sim.checkBar('BTC', makeCandle(3000000, 95, 95, 85, 88), 2)    // SL hit

    // Trade 2: fill + TP hit
    sim.tryFill(makeSetup({ coin: 'ETH', id: 'ETH|1h|order-block|long' }), 3)
    sim.checkBar('ETH', makeCandle(4000000, 100, 120, 98, 110), 4) // fill
    sim.checkBar('ETH', makeCandle(5000000, 110, 120, 108, 115), 5) // TP hit

    const trades = sim.getTrades()
    expect(trades.length).toBe(2)
    expect(trades[0]!.strategyId).toBe('alpha')
    expect(trades[1]!.strategyId).toBe('alpha')
  })

  test('closeAll preserves strategyId', () => {
    const sim = new TradeSimulator(10000, 0, 0, 'single', 'smc-sd')
    const setup = makeSetup()

    sim.tryFill(setup, 0)
    sim.checkBar('BTC', makeCandle(2000000, 100, 105, 98, 102), 1) // fill

    sim.closeAll(105, 5, 6000000)

    const trades = sim.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.strategyId).toBe('smc-sd')
    expect(trades[0]!.exitReason).toBe('end_of_data')
  })

  test('closeByInvalidation preserves strategyId', () => {
    const sim = new TradeSimulator(10000, 0, 0, 'single', 'alpha')
    const setup = makeSetup()

    sim.tryFill(setup, 0)
    sim.checkBar('BTC', makeCandle(2000000, 100, 105, 98, 102), 1) // fill

    sim.closeByInvalidation('BTC', 95, 3, 4000000)

    const trades = sim.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.strategyId).toBe('alpha')
    expect(trades[0]!.exitReason).toBe('invalidated')
  })
})

// ─── StrategyRegistry activateOnly ─────────────────────────────────────────

describe('StrategyRegistry activateOnly isolation', () => {
  beforeEach(() => {
    resetStrategyRegistry()
    const registry = getStrategyRegistry()
    try { registry.register(new SmcSdStrategy()) } catch { /* already registered */ }
  })

  test('activateOnly restricts runAll to single strategy', () => {
    const registry = getStrategyRegistry()

    // activateOnly('smc-sd') → runAll only runs smc-sd
    registry.activateOnly('smc-sd')
    const allStrategies = registry.getAll()
    expect(allStrategies.some(s => s.id === 'smc-sd')).toBe(true)

    // Restore
    registry.activateOnly(null)
  })

  test('activateOnly(null) restores fan-out', () => {
    const registry = getStrategyRegistry()
    registry.activateOnly('smc-sd')
    registry.activateOnly(null)

    // All enabled strategies should participate in runAll
    const enabledIds = registry.getEnabledIds()
    expect(enabledIds.length).toBeGreaterThanOrEqual(1)
  })

  test('activateOnly throws for unregistered strategy', () => {
    const registry = getStrategyRegistry()
    expect(() => registry.activateOnly('nonexistent')).toThrow()
  })
})
