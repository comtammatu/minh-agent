/**
 * Quant baseline strategy tests.
 *
 * Tests cover:
 *   1. Signal generation: bullish + RSI oversold → long
 *   2. Signal generation: bearish + RSI overbought → short
 *   3. No signal when RSI in neutral range
 *   4. No signal when insufficient candles (< 200)
 *   5. SL/TP placement relative to ATR
 *   6. Dedup: one signal per coin per bar
 *   7. Signal type and grade
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { runQuantPipeline, clearQuantState } from '../src/scanner/quant-pipeline.js'
import { clearPipelineState, getPipelineEmitter, getPipelineStats } from '../src/scanner/pipeline.js'
import type { Candle, CandleInterval, ActiveSetup } from '../src/types.js'
import { QUANT_ATR_SL_MULT, QUANT_ATR_TP_MULT } from '../src/config.js'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate candles with a controlled trend and final RSI condition.
 *
 * @param count Total candles (must be > 200)
 * @param trend 'up' = prices rise (EMA50 > EMA200), 'down' = prices fall
 * @param endCondition 'oversold' = sharp drop at end, 'overbought' = sharp rally at end, 'neutral' = flat
 */
function generateCandles(
  count: number,
  trend: 'up' | 'down',
  endCondition: 'oversold' | 'overbought' | 'neutral',
): Candle[] {
  const candles: Candle[] = []
  const basePrice = 40000
  const startTime = Date.UTC(2025, 0, 1)
  const hourMs = 60 * 60 * 1000

  for (let i = 0; i < count; i++) {
    let price: number

    if (i < count - 20) {
      // Main trend: gradual move
      const trendFactor = trend === 'up' ? 1 : -1
      price = basePrice + trendFactor * (i * 10)
      // Add small oscillation
      price += Math.sin(i * 0.3) * 50
    } else {
      // Last 20 bars: create RSI condition
      const trendPrice = basePrice + (trend === 'up' ? 1 : -1) * ((count - 20) * 10)
      const barsFromEnd = count - i

      if (endCondition === 'oversold') {
        // Sharp drop → RSI < 30
        price = trendPrice - (20 - barsFromEnd) * 150
      } else if (endCondition === 'overbought') {
        // Sharp rally → RSI > 70
        price = trendPrice + (20 - barsFromEnd) * 150
      } else {
        // Flat → RSI ~50
        price = trendPrice + Math.sin(i * 0.5) * 20
      }
    }

    const spread = Math.abs(price) * 0.005
    candles.push({
      t: startTime + i * hourMs,
      o: price - spread * 0.5,
      h: price + spread,
      l: price - spread,
      c: price,
      v: 1000 + Math.random() * 500,
    })
  }

  return candles
}

// ── Tests ──────────────────────────────────────────────────────────────────

let emittedSetups: ActiveSetup[] = []

beforeEach(() => {
  clearPipelineState()
  clearQuantState()
  emittedSetups = []

  const emitter = getPipelineEmitter()
  emitter.removeAllListeners('setup')
  emitter.on('setup', (setup: ActiveSetup) => {
    emittedSetups.push(setup)
  })
})

describe('runQuantPipeline — signal generation', () => {
  test('bullish trend + RSI oversold → emits long signal', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    expect(emittedSetups.length).toBe(1)
    expect(emittedSetups[0]!.side).toBe('long')
    expect(emittedSetups[0]!.type).toBe('ema-rsi')
  })

  test('bearish trend + RSI overbought → emits short signal', () => {
    const candles = generateCandles(250, 'down', 'overbought')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    expect(emittedSetups.length).toBe(1)
    expect(emittedSetups[0]!.side).toBe('short')
  })

  test('bullish trend + RSI neutral → no signal', () => {
    const candles = generateCandles(250, 'up', 'neutral')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    expect(emittedSetups.length).toBe(0)
  })

  test('bearish trend + RSI oversold → no signal (wrong combination)', () => {
    const candles = generateCandles(250, 'down', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    // Bearish + oversold = no signal (need overbought for short)
    expect(emittedSetups.length).toBe(0)
  })
})

describe('runQuantPipeline — insufficient data', () => {
  test('no signal when candles < 200 (insufficient for EMA200)', () => {
    // Only 150 candles — not enough for EMA(200)
    const candles = generateCandles(150, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    expect(emittedSetups.length).toBe(0)
  })
})

describe('runQuantPipeline — SL/TP placement', () => {
  test('long signal: SL below entry, TP above entry', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    if (emittedSetups.length > 0) {
      const setup = emittedSetups[0]!
      expect(setup.slPrice).toBeLessThan(setup.entryPrice)
      expect(setup.tpPrice).toBeGreaterThan(setup.entryPrice)

      // TP distance should be QUANT_ATR_TP_MULT / QUANT_ATR_SL_MULT × SL distance = 1.5 R:R
      const slDist = setup.entryPrice - setup.slPrice
      const tpDist = setup.tpPrice - setup.entryPrice
      const rr = tpDist / slDist
      expect(rr).toBeCloseTo(QUANT_ATR_TP_MULT / QUANT_ATR_SL_MULT, 1)
    }
  })

  test('short signal: SL above entry, TP below entry', () => {
    const candles = generateCandles(250, 'down', 'overbought')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    if (emittedSetups.length > 0) {
      const setup = emittedSetups[0]!
      expect(setup.slPrice).toBeGreaterThan(setup.entryPrice)
      expect(setup.tpPrice).toBeLessThan(setup.entryPrice)
    }
  })
})

describe('runQuantPipeline — dedup', () => {
  test('no duplicate signal for same coin on same bar', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)
    runQuantPipeline('BTC', '1h', candles, idx)

    expect(emittedSetups.length).toBe(1)
  })

  test('different coins on same bar → separate signals', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)
    runQuantPipeline('ETH', '1h', candles, idx)

    expect(emittedSetups.length).toBe(2)
  })
})

describe('runQuantPipeline — signal metadata', () => {
  test('signal has correct type, grade, and confluence', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    if (emittedSetups.length > 0) {
      const setup = emittedSetups[0]!
      expect(setup.type).toBe('ema-rsi')
      expect(setup.confluenceGrade).toBe('B')
      expect(setup.confluenceCount).toBe(3)
      expect(setup.coin).toBe('BTC')
      expect(setup.interval).toBe('1h')
    }
  })

  test('patternData contains indicator values', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    runQuantPipeline('BTC', '1h', candles, idx)

    if (emittedSetups.length > 0) {
      const data = emittedSetups[0]!.patternData
      expect(typeof data['ema50']).toBe('number')
      expect(typeof data['ema200']).toBe('number')
      expect(typeof data['rsi']).toBe('number')
      expect(typeof data['atr']).toBe('number')
    }
  })
})

describe('runQuantPipeline — pipeline stats', () => {
  test('increments totalTicks and setupsTracked', () => {
    const candles = generateCandles(250, 'up', 'oversold')
    const idx = candles.length - 2

    const statsBefore = getPipelineStats()
    runQuantPipeline('BTC', '1h', candles, idx)
    const statsAfter = getPipelineStats()

    expect(statsAfter.totalTicks).toBe(statsBefore.totalTicks + 1)
    if (emittedSetups.length > 0) {
      expect(statsAfter.setupsTracked).toBe(statsBefore.setupsTracked + 1)
    }
  })
})
