/**
 * Bar-level indicator cache keyed by coin|interval.
 *
 * Purpose:
 *   - Reuse expensive indicator results across status/watchlist + strategy scan
 *   - Keep compute deterministic per closed bar
 *   - Avoid stale state via explicit clear APIs on pipeline reset
 */

import type {
  Candle,
  CandleInterval,
  KeyZone,
  MarketRegime,
  PivotPoint,
  StructureBreak,
} from '../../types.js'
import { adx, atr, detectRegime, volumeRatio } from '../../indicators/core.js'
import {
  compileKeyZones,
  detectBreakerBlocks,
  detectInversionFVGs,
  type BreakerBlock,
  type InversionFVG,
  detectStructureBreaks,
  findPivots,
  htfStructureBias,
} from '../../indicators/smc.js'
import { detectWyckoff, type WyckoffResult } from '../../indicators/wyckoff.js'
import { detectVSA, type VSASignal } from '../../indicators/vsa.js'

type HtfStructureBiasResult = ReturnType<typeof htfStructureBias>

interface IndicatorCacheEntry {
  idx: number
  candlesLen: number
  candleTs: number
  candleO: number
  candleH: number
  candleL: number
  candleC: number
  candleV: number
  regime?: MarketRegime
  atr14?: number
  adx14?: number
  volumeRatio20?: number
  vsaByLookback?: Map<string, VSASignal[]>
  wyckoffByParams?: Map<string, WyckoffResult>
  pivotsByParams?: Map<string, PivotPoint[]>
  pivots3?: PivotPoint[]
  structureBreaksByParams?: Map<string, StructureBreak[]>
  htfStructureBiasByParams?: Map<string, HtfStructureBiasResult>
  keyZonesByTolerance?: Map<string, { demandZones: KeyZone[]; supplyZones: KeyZone[] }>
  breakerBlocks50?: BreakerBlock[]
  inversionFVGsByTolerance?: Map<string, InversionFVG[]>
}

const indicatorCache = new Map<string, IndicatorCacheEntry>()

function cacheKey(coin: string, interval: CandleInterval): string {
  return `${coin}|${interval}`
}

function ensureEntry(coin: string, interval: CandleInterval, candles: Candle[], idx: number): IndicatorCacheEntry | null {
  if (idx < 0 || idx >= candles.length) return null

  const key = cacheKey(coin, interval)
  const candle = candles[idx]!
  const candleTs = candle.t
  const existing = indicatorCache.get(key)

  if (
    existing &&
    existing.idx === idx &&
    existing.candlesLen === candles.length &&
    existing.candleTs === candleTs &&
    existing.candleO === candle.o &&
    existing.candleH === candle.h &&
    existing.candleL === candle.l &&
    existing.candleC === candle.c &&
    existing.candleV === candle.v
  ) {
    return existing
  }

  const next: IndicatorCacheEntry = {
    idx,
    candlesLen: candles.length,
    candleTs,
    candleO: candle.o,
    candleH: candle.h,
    candleL: candle.l,
    candleC: candle.c,
    candleV: candle.v,
  }
  indicatorCache.set(key, next)
  return next
}

function getCachedPivotsIfAvailable(
  entry: IndicatorCacheEntry,
  lookback: number,
  tolerance: number,
): PivotPoint[] | undefined {
  if (lookback === 3 && tolerance === 0) {
    return entry.pivots3
  }
  const cacheParamsKey = `${lookback}|${tolerance}`
  return entry.pivotsByParams?.get(cacheParamsKey)
}

export function getCachedRegime(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): MarketRegime {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return 'SIDEWAYS'
  if (entry.regime === undefined) {
    entry.regime = detectRegime(candles, idx)
  }
  return entry.regime
}

export function getCachedAtr14(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): number {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return NaN
  if (entry.atr14 === undefined) {
    entry.atr14 = atr(candles, idx, 14)
  }
  return entry.atr14
}

export function getCachedAdx14(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): number {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return NaN
  if (entry.adx14 === undefined) {
    entry.adx14 = adx(candles, idx, 14)
  }
  return entry.adx14
}

export function getCachedVolumeRatio20(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): number {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return NaN
  if (entry.volumeRatio20 === undefined) {
    entry.volumeRatio20 = volumeRatio(candles, idx, 20)
  }
  return entry.volumeRatio20
}

export function getCachedVsa(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  lookback: number = 20,
): VSASignal[] {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return []
  if (entry.vsaByLookback === undefined) {
    entry.vsaByLookback = new Map<string, VSASignal[]>()
  }

  const lookbackKey = String(lookback)
  const cached = entry.vsaByLookback.get(lookbackKey)
  if (cached !== undefined) return cached

  const computed = detectVSA(candles, idx, { lookback })
  entry.vsaByLookback.set(lookbackKey, computed)
  return computed
}

export function getCachedWyckoff(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  params: { rangePeriod?: number; trendPeriod?: number } = {},
): WyckoffResult {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return { phase: null, confidence: 0, event: null }
  if (entry.wyckoffByParams === undefined) {
    entry.wyckoffByParams = new Map<string, WyckoffResult>()
  }

  const cacheParamsKey = `${params.rangePeriod ?? ''}|${params.trendPeriod ?? ''}`
  const cached = entry.wyckoffByParams.get(cacheParamsKey)
  if (cached !== undefined) return cached

  const computed = detectWyckoff(candles, idx, params)
  entry.wyckoffByParams.set(cacheParamsKey, computed)
  return computed
}

export function getCachedPivots3(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): PivotPoint[] {
  return getCachedPivots(coin, interval, candles, idx, 3)
}

export function getCachedPivots(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  lookback: number = 3,
  tolerance: number = 0,
): PivotPoint[] {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return []
  if (lookback === 3 && tolerance === 0 && entry.pivots3 !== undefined) {
    return entry.pivots3
  }
  if (entry.pivotsByParams === undefined) {
    entry.pivotsByParams = new Map<string, PivotPoint[]>()
  }

  const cacheParamsKey = `${lookback}|${tolerance}`
  const cached = entry.pivotsByParams.get(cacheParamsKey)
  if (cached !== undefined) return cached

  const computed = findPivots(candles, idx, lookback, tolerance)
  entry.pivotsByParams.set(cacheParamsKey, computed)
  if (lookback === 3 && tolerance === 0) {
    entry.pivots3 = computed
  }
  return computed
}

export function getCachedStructureBreaks(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  params: { swingLookback?: number; tolerance?: number; minPivotSpacing?: number } = {},
): StructureBreak[] {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return []
  if (entry.structureBreaksByParams === undefined) {
    entry.structureBreaksByParams = new Map<string, StructureBreak[]>()
  }

  const cacheParamsKey = [
    params.swingLookback ?? '',
    params.tolerance ?? '',
    params.minPivotSpacing ?? '',
  ].join('|')
  const cached = entry.structureBreaksByParams.get(cacheParamsKey)
  if (cached !== undefined) return cached

  const swingLookback = params.swingLookback ?? 3
  const tolerance = params.tolerance ?? 0
  const pivots = getCachedPivots(coin, interval, candles, idx, swingLookback, tolerance)
  const computed = detectStructureBreaks(candles, idx, { ...params, swingLookback, tolerance, pivots })
  entry.structureBreaksByParams.set(cacheParamsKey, computed)
  return computed
}

export function getCachedKeyZones(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  tolerance: number = 0,
): { demandZones: KeyZone[]; supplyZones: KeyZone[] } {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return { demandZones: [], supplyZones: [] }
  if (entry.keyZonesByTolerance === undefined) {
    entry.keyZonesByTolerance = new Map<string, { demandZones: KeyZone[]; supplyZones: KeyZone[] }>()
  }

  const toleranceKey = String(tolerance)
  const cached = entry.keyZonesByTolerance.get(toleranceKey)
  if (cached !== undefined) return cached

  const pivots = getCachedPivotsIfAvailable(entry, 3, tolerance)
  const computed = compileKeyZones(
    candles,
    idx,
    tolerance,
    pivots !== undefined ? { pivots } : {},
  )
  entry.keyZonesByTolerance.set(toleranceKey, computed)
  return computed
}

export function getCachedHtfStructureBias(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  params: { swingLookback?: number; tolerance?: number } = {},
): HtfStructureBiasResult {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return { bias: 'neutral', confidence: 0 }
  if (entry.htfStructureBiasByParams === undefined) {
    entry.htfStructureBiasByParams = new Map<string, HtfStructureBiasResult>()
  }

  const cacheParamsKey = `${params.swingLookback ?? ''}|${params.tolerance ?? ''}`
  const cached = entry.htfStructureBiasByParams.get(cacheParamsKey)
  if (cached !== undefined) return cached

  const computed = htfStructureBias(candles, idx, params)
  entry.htfStructureBiasByParams.set(cacheParamsKey, computed)
  return computed
}

export function getCachedBreakerBlocks50(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): BreakerBlock[] {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return []
  if (entry.breakerBlocks50 === undefined) {
    entry.breakerBlocks50 = detectBreakerBlocks(candles, idx, { lookback: 50 })
  }
  return entry.breakerBlocks50
}

export function getCachedInversionFVGs(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
  tolerance: number = 0,
): InversionFVG[] {
  const entry = ensureEntry(coin, interval, candles, idx)
  if (!entry) return []
  if (entry.inversionFVGsByTolerance === undefined) {
    entry.inversionFVGsByTolerance = new Map<string, InversionFVG[]>()
  }

  const toleranceKey = String(tolerance)
  const cached = entry.inversionFVGsByTolerance.get(toleranceKey)
  if (cached !== undefined) return cached

  const computed = detectInversionFVGs(candles, idx, tolerance)
  entry.inversionFVGsByTolerance.set(toleranceKey, computed)
  return computed
}

/** Clear all cached indicator snapshots (used by full pipeline reset). */
export function clearIndicatorCache(): void {
  indicatorCache.clear()
}

/** Clear cached snapshots for a specific coin (all TFs). */
export function clearIndicatorCacheForCoin(coin: string): void {
  const prefix = `${coin}|`
  for (const key of indicatorCache.keys()) {
    if (key.startsWith(prefix)) indicatorCache.delete(key)
  }
}
