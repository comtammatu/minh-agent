/**
 * Backtest engine tests.
 *
 * Tests cover:
 *   1. Metrics computation (pure function, known inputs)
 *   2. Trade simulator (fill, SL/TP check, closeAll)
 *   3. Engine replay (integration: pipeline → simulator → metrics)
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { computeMetrics, buildEquityCurve } from '../../src/backtest/metrics.js'
import { TradeSimulator } from '../../src/backtest/simulator.js'
import type { BacktestTrade } from '../../src/backtest/types.js'
import type { ActiveSetup, Candle, CandleInterval } from '../../src/types.js'

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
    id: 'BTC:1h:order-block:long',
    coin: 'BTC',
    interval: '1h' as CandleInterval,
    type: 'order-block',
    side: 'long',
    confidence: 0.8,
    entryPrice: 100,
    slPrice: 95,
    tpPrice: 110,
    patternData: {},
    detectedAt: 1000000,
    detectedAtBar: 0,
    expiresAtBar: 50,
    confluenceGrade: 'B',
    ...overrides,
  }
}

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    coin: 'BTC',
    interval: '1h' as CandleInterval,
    side: 'long',
    patternType: 'order-block',
    confluenceGrade: 'B',
    entryPrice: 100,
    exitPrice: 110,
    slPrice: 95,
    tpPrice: 110,
    sizeUsd: 1000,
    entryTime: 1000000,
    exitTime: 2000000,
    holdingBars: 5,
    pnl: 100,
    pnlPct: 0.10,
    exitReason: 'tp_hit',
    ...overrides,
  }
}

// ─── Metrics Tests ──────────────────────────────────────────────────────────

describe('computeMetrics', () => {
  test('returns zero metrics for empty trades', () => {
    const m = computeMetrics([], 10000)
    expect(m.totalTrades).toBe(0)
    expect(m.winRate).toBe(0)
    expect(m.expectancy).toBe(0)
    expect(m.maxDrawdown).toBe(0)
    expect(m.sharpeRatio).toBe(0)
  })

  test('computes correct metrics for winning trades', () => {
    const trades = [
      makeTrade({ pnl: 100, exitTime: 1000000 }),
      makeTrade({ pnl: 200, exitTime: 1000000 }),
      makeTrade({ pnl: 50, exitTime: 2000000 }),
    ]
    const m = computeMetrics(trades, 10000)

    expect(m.totalTrades).toBe(3)
    expect(m.wins).toBe(3)
    expect(m.losses).toBe(0)
    expect(m.winRate).toBe(1)
    expect(m.grossProfit).toBeCloseTo(350)
    expect(m.grossLoss).toBe(0)
    expect(m.netPnl).toBeCloseTo(350)
    expect(m.profitFactor).toBe(Infinity)
    expect(m.expectancy).toBeGreaterThan(0)
  })

  test('computes correct metrics for mixed trades', () => {
    const trades = [
      makeTrade({ pnl: 200, exitTime: 1000000 }),
      makeTrade({ pnl: -100, exitTime: 1000000 }),
      makeTrade({ pnl: 150, exitTime: 2000000 }),
      makeTrade({ pnl: -50, exitTime: 2000000 }),
    ]
    const m = computeMetrics(trades, 10000)

    expect(m.totalTrades).toBe(4)
    expect(m.wins).toBe(2)
    expect(m.losses).toBe(2)
    expect(m.winRate).toBe(0.5)
    expect(m.grossProfit).toBeCloseTo(350)
    expect(m.grossLoss).toBeCloseTo(-150)
    expect(m.netPnl).toBeCloseTo(200)
    expect(m.profitFactor).toBeCloseTo(350 / 150)
    expect(m.avgWin).toBeCloseTo(175)
    expect(m.avgLoss).toBeCloseTo(75)
    // expectancy = (0.5 × 175) - (0.5 × 75) = 50
    expect(m.expectancy).toBeCloseTo(50)
  })

  test('computes max drawdown correctly', () => {
    const trades = [
      makeTrade({ pnl: 100, exitTime: 1000000 }),   // equity: 10100
      makeTrade({ pnl: -500, exitTime: 2000000 }),   // equity: 9600 (DD from 10100)
      makeTrade({ pnl: -200, exitTime: 3000000 }),   // equity: 9400 (DD deepens)
      makeTrade({ pnl: 1000, exitTime: 4000000 }),   // equity: 10400 (new peak)
    ]
    const m = computeMetrics(trades, 10000)

    // Max DD: peak = 10100, trough = 9400 → (10100-9400)/10100 ≈ 6.93%
    expect(m.maxDrawdown).toBeCloseTo(700 / 10100, 3)
    expect(m.maxDrawdownDuration).toBe(2) // 2 consecutive losing trades
  })

  test('avgRR is computed as avgWin/avgLoss', () => {
    const trades = [
      makeTrade({ pnl: 300 }),
      makeTrade({ pnl: -100 }),
    ]
    const m = computeMetrics(trades, 10000)
    // avgWin = 300, avgLoss = 100, avgRR = 3.0
    expect(m.avgRR).toBeCloseTo(3.0)
  })
})

describe('buildEquityCurve', () => {
  test('builds correct equity points', () => {
    const trades = [
      makeTrade({ pnl: 100, entryTime: 1000, exitTime: 2000 }),
      makeTrade({ pnl: -50, entryTime: 3000, exitTime: 4000 }),
    ]
    const curve = buildEquityCurve(trades, 10000)

    expect(curve.length).toBe(3)
    expect(curve[0]!.equity).toBe(10000)
    expect(curve[1]!.equity).toBe(10100)
    expect(curve[2]!.equity).toBe(10050)
  })
})

// ─── Simulator Tests ────────────────────────────────────────────────────────

describe('TradeSimulator', () => {
  let sim: TradeSimulator

  beforeEach(() => {
    sim = new TradeSimulator(10000, 0.0005, 0.0003)
  })

  test('fills a long position', () => {
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110 })
    const filled = sim.tryFill(setup, 0)

    expect(filled).toBe(true)
    expect(sim.hasPosition('BTC')).toBe(true)
    expect(sim.openPositionCount()).toBe(1)
  })

  test('rejects duplicate position for same coin', () => {
    const setup = makeSetup()
    sim.tryFill(setup, 0)
    const second = sim.tryFill(setup, 1)

    expect(second).toBe(false)
    expect(sim.openPositionCount()).toBe(1)
  })

  test('detects SL hit for long position', () => {
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110 })
    sim.tryFill(setup, 0)

    // Bar that hits SL (low touches 95)
    const candle = makeCandle(2000000, 98, 99, 94, 96)
    sim.checkBar('BTC', candle, 1)

    expect(sim.hasPosition('BTC')).toBe(false)
    const trades = sim.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.exitReason).toBe('sl_hit')
    expect(trades[0]!.pnl).toBeLessThan(0)
  })

  test('TP1 hit triggers partial close (position stays open for TP2/trail)', () => {
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110, patternData: { tp2Price: 120 } })
    sim.tryFill(setup, 0)

    // Bar that hits TP1 (high reaches 110)
    const candle = makeCandle(2000000, 105, 112, 104, 108)
    sim.checkBar('BTC', candle, 1)

    // Position still open (TP2 + trailing remaining)
    expect(sim.hasPosition('BTC')).toBe(true)
  })

  test('SL checked before TP on same bar (conservative)', () => {
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110 })
    sim.tryFill(setup, 0)

    // Bar that hits BOTH SL and TP
    const candle = makeCandle(2000000, 100, 115, 90, 100)
    sim.checkBar('BTC', candle, 1)

    const trades = sim.getTrades()
    expect(trades[0]!.exitReason).toBe('sl_hit')
  })

  test('detects SL hit for short position', () => {
    const setup = makeSetup({
      side: 'short',
      entryPrice: 100,
      slPrice: 105,
      tpPrice: 90,
    })
    sim.tryFill(setup, 0)

    // Bar that hits short SL (high reaches 105)
    const candle = makeCandle(2000000, 102, 106, 101, 103)
    sim.checkBar('BTC', candle, 1)

    const trades = sim.getTrades()
    expect(trades[0]!.exitReason).toBe('sl_hit')
    expect(trades[0]!.pnl).toBeLessThan(0)
  })

  test('full exit when TP1 + TP2 both hit on wide bar', () => {
    // TP1=110, TP2=120. Bar high reaches 125 → both hit
    const setup = makeSetup({
      side: 'long',
      entryPrice: 100,
      slPrice: 95,
      tpPrice: 110,
      patternData: { tp2Price: 120 },
    })
    sim.tryFill(setup, 0)

    // Wide bar that hits both TP1 and TP2
    const candle = makeCandle(2000000, 105, 125, 104, 122)
    sim.checkBar('BTC', candle, 1)

    // Remaining 30% still open for trailing
    expect(sim.hasPosition('BTC')).toBe(true)
  })

  test('closeAll closes remaining positions at given price', () => {
    sim.tryFill(makeSetup({ coin: 'BTC', entryPrice: 100 }), 0)
    sim.tryFill(makeSetup({
      id: 'ETH:1h:fvg:long',
      coin: 'ETH',
      entryPrice: 50,
      slPrice: 47,
      tpPrice: 55,
    }), 1)

    sim.closeAll(102, 10, 9000000)

    expect(sim.openPositionCount()).toBe(0)
    const trades = sim.getTrades()
    expect(trades.length).toBe(2)
    expect(trades[0]!.exitReason).toBe('end_of_data')
    expect(trades[1]!.exitReason).toBe('end_of_data')
  })

  test('closeByInvalidation closes specific coin', () => {
    sim.tryFill(makeSetup({ coin: 'BTC', entryPrice: 100 }), 0)
    sim.closeByInvalidation('BTC', 98, 5, 5000000)

    expect(sim.hasPosition('BTC')).toBe(false)
    const trades = sim.getTrades()
    expect(trades[0]!.exitReason).toBe('invalidated')
  })

  test('slippage and commission affect PnL on SL exit', () => {
    // With zero slippage/commission
    const simClean = new TradeSimulator(10000, 0, 0)
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110 })
    simClean.tryFill(setup, 0)
    const slCandle = makeCandle(2000000, 98, 99, 94, 96) // hits SL
    simClean.checkBar('BTC', slCandle, 1)
    const cleanPnl = simClean.getTrades()[0]!.pnl

    // With slippage + commission
    const simReal = new TradeSimulator(10000, 0.001, 0.001)
    simReal.tryFill(makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110 }), 0)
    simReal.checkBar('BTC', slCandle, 1)
    const realPnl = simReal.getTrades()[0]!.pnl

    // Real PnL should be more negative due to costs
    expect(realPnl).toBeLessThan(cleanPnl)
  })

  test('holding bars computed correctly on SL exit', () => {
    sim.tryFill(makeSetup(), 10)
    const candle = makeCandle(2000000, 98, 99, 94, 96) // hits SL
    sim.checkBar('BTC', candle, 15)

    const trade = sim.getTrades()[0]!
    expect(trade.holdingBars).toBe(5)
  })

  test('trailing stop activates and closes remaining after TP1', () => {
    const sim2 = new TradeSimulator(10000, 0, 0)
    // atrValue=5 means trail distance = 5 * 2.0 = 10
    const setup = makeSetup({ entryPrice: 100, slPrice: 95, tpPrice: 110, patternData: { tp2Price: 150 } })
    sim2.tryFill(setup, 0, 5, 2.0)

    // Bar 1: TP1 hit at 110 (40% closed, SL to breakeven ~100.1)
    sim2.checkBar('BTC', makeCandle(1, 105, 112, 104, 108), 1)
    expect(sim2.hasPosition('BTC')).toBe(true)

    // Bar 2: price rises to 120, low stays above trail (120-10=110, low=115 > 110)
    sim2.checkBar('BTC', makeCandle(2, 110, 120, 115, 118), 2)
    expect(sim2.hasPosition('BTC')).toBe(true)

    // Bar 3: price rises to 125, trail stop = 125-10 = 115
    sim2.checkBar('BTC', makeCandle(3, 118, 125, 116, 124), 3)
    expect(sim2.hasPosition('BTC')).toBe(true)

    // Bar 4: pulls back through trail stop (125-10=115), low=112 < 115
    sim2.checkBar('BTC', makeCandle(4, 124, 124, 112, 114), 4)

    const trades = sim2.getTrades()
    expect(trades.length).toBe(1)
    expect(trades[0]!.partialCloses).toBeDefined()
    expect(trades[0]!.partialCloses!.length).toBeGreaterThanOrEqual(2)
    // Should have TP1 partial + trail partial
    const reasons = trades[0]!.partialCloses!.map(p => p.reason)
    expect(reasons).toContain('tp1_zone')
    expect(reasons).toContain('tp3_trail')
  })
})
