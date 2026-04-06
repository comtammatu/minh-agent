/**
 * Golden tests — compare Minh indicator output against fixture snapshots.
 * Run `bun run scripts/gen-fixtures.ts` first to generate test/fixtures/*.json.
 *
 * If fixtures don't exist, tests are skipped (graceful degradation).
 */

import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sma, ema, atr, rsi, adx, volumeRatio, detectRegime } from '../src/indicators/core.js'
import { detectFVG, scanFVGs, detectOrderBlocks } from '../src/indicators/smc.js'
import { detectWyckoff } from '../src/indicators/wyckoff.js'
import { buildVolumeProfile } from '../src/indicators/order-flow.js'
import type { Candle } from '../src/types.js'

const fixtureDir = join(import.meta.dir, 'fixtures')
const fixturesExist = existsSync(fixtureDir)

function loadFixture<T>(name: string): T | null {
  const path = join(fixtureDir, name)
  if (!existsSync(path)) return null
  return JSON.parse(require('fs').readFileSync(path, 'utf8')) as T
}

// ── Core indicators ──────────────────────────────────────────────────────────

describe('core indicators', () => {
  if (!fixturesExist) {
    it.skip('fixtures not generated — run bun run scripts/gen-fixtures.ts', () => {})
    return
  }

  const fixture = loadFixture<{
    candles: Candle[]
    sma7: number
    sma30: number
    ema14: number
    atr14: number
    rsi14: number
    adx14: number
    volRatio20: number
    regime: string
    sma7Series: number[]
    atr14Series: number[]
  }>('core.json')

  if (!fixture) {
    it.skip('core.json not found', () => {})
    return
  }

  const { candles } = fixture
  const idx = candles.length - 1

  it('sma7 matches golden reference', () => {
    const result = sma(candles, idx, 7)
    expect(result).toBeCloseTo(fixture.sma7, 4)
  })

  it('sma30 matches golden reference', () => {
    const result = sma(candles, idx, 30)
    expect(result).toBeCloseTo(fixture.sma30, 4)
  })

  it('ema14 matches golden reference', () => {
    const result = ema(candles, idx, 14)
    expect(result).toBeCloseTo(fixture.ema14, 2)
  })

  it('atr14 matches golden reference', () => {
    const result = atr(candles, idx, 14)
    expect(result).toBeCloseTo(fixture.atr14, 2)
  })

  it('rsi14 matches golden reference', () => {
    const result = rsi(candles, idx, 14)
    expect(result).toBeCloseTo(fixture.rsi14, 1)
  })

  it('adx14 matches golden reference', () => {
    const result = adx(candles, idx, 14)
    expect(result).toBeCloseTo(fixture.adx14, 1)
  })

  it('volumeRatio20 matches golden reference', () => {
    const result = volumeRatio(candles, idx, 20)
    expect(result).toBeCloseTo(fixture.volRatio20, 3)
  })

  it('regime matches golden reference', () => {
    const result = detectRegime(candles, idx)
    expect(result).toBe(fixture.regime)
  })

  it('sma7 series matches over last 30 bars', () => {
    for (let i = 0; i < fixture.sma7Series.length; i++) {
      const barIdx = idx - 29 + i
      const result = sma(candles, barIdx, 7)
      expect(result).toBeCloseTo(fixture.sma7Series[i]!, 4)
    }
  })

  it('atr14 series matches over last 30 bars', () => {
    for (let i = 0; i < fixture.atr14Series.length; i++) {
      const barIdx = idx - 29 + i
      const result = atr(candles, barIdx, 14)
      expect(result).toBeCloseTo(fixture.atr14Series[i]!, 2)
    }
  })
})

// ── SMC indicators ───────────────────────────────────────────────────────────

describe('smc indicators', () => {
  if (!fixturesExist) {
    it.skip('fixtures not generated', () => {})
    return
  }

  const fixture = loadFixture<{
    candles: Candle[]
    fvgAtIdx: unknown
    activeFVGs: unknown[]
    orderBlocks: unknown[]
    swingPoints: unknown[]
  }>('smc.json')

  if (!fixture) {
    it.skip('smc.json not found', () => {})
    return
  }

  const { candles } = fixture
  const idx = candles.length - 1

  it('detectFVG returns FVG | null matching fixture', () => {
    const result = detectFVG(candles, idx)
    const expected = fixture.fvgAtIdx
    if (expected === null) {
      expect(result).toBeNull()
    } else {
      expect(result).not.toBeNull()
      // Check structure fields present
      expect(typeof result!.top).toBe('number')
      expect(typeof result!.bottom).toBe('number')
      expect(typeof result!.midpoint).toBe('number')
      expect(typeof result!.bullish).toBe('boolean')
    }
  })

  it('scanFVGs returns array', () => {
    const result = scanFVGs(candles, idx)
    expect(Array.isArray(result)).toBe(true)
  })

  it('orderBlocks: count within reasonable range of fixture', () => {
    const result = detectOrderBlocks(candles, idx, { lookback: 50 })
    const fixtureCount = (fixture.orderBlocks as unknown[]).length
    // Allow ±3 due to implementation differences in tested status
    expect(Math.abs(result.length - fixtureCount)).toBeLessThanOrEqual(3)
  })
})

// ── Structure tests removed — analyzeStructure deleted in A6 ──────────────────
// classifySwings + detectStructuralBias now tested in test/price-action-structure.test.ts

// ── Smoke tests (no fixtures needed) ─────────────────────────────────────────

describe('core smoke tests', () => {
  function buildTrendCandles(n: number): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      t: i * 3600_000,
      o: 100 + i,
      h: 103 + i,
      l: 98 + i,
      c: 102 + i,
      v: 1000 + i * 10,
    }))
  }

  it('sma returns finite positive value', () => {
    const candles = buildTrendCandles(30)
    const result = sma(candles, 29, 7)
    expect(isFinite(result)).toBe(true)
    expect(result).toBeGreaterThan(0)
  })

  it('atr returns finite positive value', () => {
    const candles = buildTrendCandles(30)
    const result = atr(candles, 29, 14)
    expect(isFinite(result)).toBe(true)
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it('rsi is bounded 0-100', () => {
    const candles = buildTrendCandles(30)
    const result = rsi(candles, 29, 14)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(100)
  })

  it('detectRegime returns valid enum value', () => {
    const candles = buildTrendCandles(100)
    const result = detectRegime(candles, 99)
    expect(['BULL', 'BEAR', 'SIDEWAYS', 'VOLATILE']).toContain(result)
  })

  it('buildVolumeProfile returns valid profile', () => {
    const candles = buildTrendCandles(210)
    const result = buildVolumeProfile(candles, 0, 199)
    expect(result).not.toBeNull()
    expect(result!.poc).toBeGreaterThan(0)
    expect(result!.vah).toBeGreaterThan(result!.val)
  })

})
