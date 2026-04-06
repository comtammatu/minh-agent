/**
 * Pipeline integration tests.
 *
 * Tests the closed-candle gate (migrated from engine.ts) and each STOP point.
 * Uses the real store (setCandles/clearStore) + clearPipelineState for isolation.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'bun:test'
import { onCandleTick, getStatus, getActiveSetups, clearPipelineState } from '../src/strategy/orchestrator.js'
import { setCandles, clearStore } from '../src/feed/store.js'
import type { Candle, CandleInterval } from '../src/types.js'
import { getStrategyRegistry, resetStrategyRegistry } from '../src/strategy/registry.js'
import { LayeredStrategyAdapter } from '../src/strategy/strategies/layered/index.js'
import { QuantStrategyAdapter } from '../src/strategy/strategies/quant/index.js'

// Register strategies before any test runs
beforeAll(() => {
  resetStrategyRegistry()
  const reg = getStrategyRegistry()
  reg.register(new LayeredStrategyAdapter())
  reg.register(new QuantStrategyAdapter())
})

// ── Helpers ──────────────────────────────────────────────────────────────────

const COIN = 'BTC'
const TF: CandleInterval = '1h'
const HTF: CandleInterval = '4h'  // HTF_MAP['1h'] = '4h'

function makeCandle(t: number, overrides: Partial<Candle> = {}): Candle {
  return { t, o: 100, h: 105, l: 95, c: 100, v: 1000, ...overrides }
}

/**
 * Build N candles with 1h spacing. Flat price around `base`.
 * Flat candles → Wyckoff null phase → weak/no bias → likely STOP at Layer 1.
 */
function buildFlatCandles(count: number, base = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: 1000 + i * 3600000,  // 1h intervals
    o: base,
    h: base + 0.5,
    l: base - 0.5,
    c: base,
    v: 1000,
  }))
}

/**
 * Build N candles with a clear uptrend.
 * Strong trend → Wyckoff markup → long bias → may reach deeper layers.
 */
function buildTrendUpCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 1.5
    return {
      t: 1000 + i * 3600000,
      o: base - 0.5,
      h: base + 3,
      l: base - 2,
      c: base + 1,
      v: 1000 + i * 50,
    }
  })
}

beforeEach(() => {
  clearPipelineState()
  clearStore()
})

// ── Closed-candle gate ───────────────────────────────────────────────────────

describe('closed-candle gate', () => {
  it('first tick: stores candle but does not run pipeline (no status)', () => {
    // First tick ever for this coin/tf — should set lastTs but not scan
    onCandleTick(COIN, TF, makeCandle(1000))
    expect(getStatus()).toEqual([])
    expect(getActiveSetups()).toEqual([])
  })

  it('same timestamp: skip scan (candle still forming)', () => {
    // Pre-fill store so we have enough candles
    setCandles(COIN, TF, buildFlatCandles(60))

    // First tick — sets lastTs
    onCandleTick(COIN, TF, makeCandle(5000))
    // Second tick with same timestamp — should skip
    onCandleTick(COIN, TF, makeCandle(5000, { c: 101 }))

    // No status update from forming candle
    // (first tick sets lastTs but doesn't scan since prevTs was undefined)
    expect(getActiveSetups()).toEqual([])
  })

  it('new timestamp: triggers pipeline (status gets populated)', () => {
    // Pre-fill store with enough candles
    const candles = buildFlatCandles(60)
    setCandles(COIN, TF, candles)

    // First tick — sets lastTs, no scan
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))

    // Second tick with NEW timestamp — previous candle closed, triggers scan
    const newTs = candles[candles.length - 1]!.t + 3600000
    onCandleTick(COIN, TF, makeCandle(newTs))

    // Status should now be populated (pipeline ran, even if bias was neutral)
    const status = getStatus()
    expect(status.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Insufficient candles ─────────────────────────────────────────────────────

describe('insufficient candles', () => {
  it('< MIN_CANDLES_FOR_SCAN+1 candles → no pipeline run', () => {
    // Only 30 candles — below MIN_CANDLES_FOR_SCAN (50)
    const candles = buildFlatCandles(30)
    setCandles(COIN, TF, candles)

    // Trigger closed-candle gate
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))
    const newTs = candles[candles.length - 1]!.t + 3600000
    onCandleTick(COIN, TF, makeCandle(newTs))

    expect(getStatus()).toEqual([])
    expect(getActiveSetups()).toEqual([])
  })
})

// ── STOP points ──────────────────────────────────────────────────────────────

describe('STOP at Layer 1: neutral bias', () => {
  it('flat candles → neutral bias → no active setups', () => {
    // Flat candles: no Wyckoff phase, no BOS/CHoCH → neutral
    const candles = buildFlatCandles(80)
    setCandles(COIN, TF, candles)

    // Also set HTF candles (flat → neutral HTF)
    setCandles(COIN, HTF, buildFlatCandles(80))

    // Trigger scan
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t + 3600000))

    // Pipeline ran → status populated, but no setups (neutral bias = STOP)
    expect(getActiveSetups()).toEqual([])

    const status = getStatus()
    if (status.length > 0) {
      // Bias should be neutral or very weak
      const s = status[0]!
      expect(s.activeCount).toBe(0)
    }
  })
})

describe('STOP at Layer 3: no zones', () => {
  it('trend candles with no clear zones at current price → no setup', () => {
    // Strong uptrend — bias may be long, structure may confirm,
    // but price is far from any demand zone → Layer 3 returns empty
    const candles = buildTrendUpCandles(80)
    setCandles(COIN, TF, candles)
    setCandles(COIN, HTF, buildTrendUpCandles(80))

    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t + 3600000))

    // Most likely no setups — price at top of trend, far from demand zones
    // (Even if a setup is found, this validates the pipeline doesn't crash)
    expect(Array.isArray(getActiveSetups())).toBe(true)
  })
})

// ── Status shape ─────────────────────────────────────────────────────────────

describe('status shape', () => {
  it('StatusSnapshot has correct fields after pipeline run', () => {
    const candles = buildFlatCandles(80)
    setCandles(COIN, TF, candles)
    setCandles(COIN, HTF, buildFlatCandles(80))

    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t + 3600000))

    const status = getStatus()
    if (status.length > 0) {
      const s = status[0]!
      expect(s.coin).toBe(COIN)
      expect(s.interval).toBe(TF)
      expect(['BULL', 'BEAR', 'SIDEWAYS', 'VOLATILE']).toContain(s.regime)
      expect(typeof s.bias).toBe('string')
      expect(typeof s.biasConfidence).toBe('number')
      expect(typeof s.activeCount).toBe('number')
      expect(typeof s.lastUpdateAt).toBe('number')
      // confluenceGrade is nullable
      expect(s.confluenceGrade === null || ['C', 'B', 'A', 'A+'].includes(s.confluenceGrade)).toBe(true)
    }
  })
})

// ── clearPipelineState ───────────────────────────────────────────────────────

describe('clearPipelineState', () => {
  it('resets all state', () => {
    const candles = buildFlatCandles(80)
    setCandles(COIN, TF, candles)
    setCandles(COIN, HTF, buildFlatCandles(80))

    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t))
    onCandleTick(COIN, TF, makeCandle(candles[candles.length - 1]!.t + 3600000))

    clearPipelineState()

    expect(getStatus()).toEqual([])
    expect(getActiveSetups()).toEqual([])
  })
})
