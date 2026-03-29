/**
 * Volume Profile — candle-based approximation.
 * Distributes each candle's volume across price bins it spans.
 * Identifies POC, VAH, VAL, HVN, LVN.
 * No tick data required. Pure functions. Zero I/O.
 */

import type { Candle, VolumeProfile } from '../types.js'
import { VP_BINS, VP_VALUE_AREA_PCT } from '../config.js'

interface Bin {
  priceLevel: number  // bin center
  volume: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pocIndex(bins: Bin[]): number {
  let idx = 0, maxVol = 0
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]!.volume > maxVol) { maxVol = bins[i]!.volume; idx = i }
  }
  return idx
}

function valueArea(bins: Bin[], poc: number, pct: number): { vahIdx: number; valIdx: number } {
  const total = bins.reduce((s, b) => s + b.volume, 0)
  if (total === 0) return { vahIdx: poc, valIdx: poc }
  const target = total * pct
  let acc = bins[poc]!.volume
  let upper = poc, lower = poc

  while (acc < target && (upper < bins.length - 1 || lower > 0)) {
    const upVol = upper < bins.length - 1 ? bins[upper + 1]!.volume : 0
    const dnVol = lower > 0 ? bins[lower - 1]!.volume : 0
    if (upVol >= dnVol && upper < bins.length - 1) { upper++; acc += bins[upper]!.volume }
    else if (lower > 0) { lower--; acc += bins[lower]!.volume }
    else { upper++; acc += bins[upper]!.volume }
  }

  return { vahIdx: upper, valIdx: lower }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build volume profile from candles[startIdx..endIdx].
 * Returns null for empty/degenerate input.
 */
export function buildVolumeProfile(
  candles: Candle[],
  startIdx: number,
  endIdx: number,
  params: { numBins?: number; valueAreaPct?: number } = {},
): VolumeProfile | null {
  const numBins = params.numBins ?? VP_BINS
  const vaPct = params.valueAreaPct ?? VP_VALUE_AREA_PCT

  if (startIdx < 0 || endIdx >= candles.length || startIdx >= endIdx) return null

  let hi = -Infinity, lo = Infinity
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i]!
    if (c.h > hi) hi = c.h
    if (c.l < lo) lo = c.l
  }
  if (hi === lo) return null

  const binSize = (hi - lo) / numBins
  const bins: Bin[] = Array.from({ length: numBins }, (_, i) => ({
    priceLevel: lo + binSize * (i + 0.5),
    volume: 0,
  }))

  // Distribute volume across bins each candle spans
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i]!
    const lowBin = Math.max(0, Math.floor((c.l - lo) / binSize))
    const highBin = Math.min(numBins - 1, Math.floor((c.h - lo) / binSize))
    const binsSpanned = highBin - lowBin + 1
    const volPerBin = c.v / binsSpanned
    for (let b = lowBin; b <= highBin; b++) bins[b]!.volume += volPerBin
  }

  const poc = pocIndex(bins)
  const pocPrice = bins[poc]!.priceLevel

  const { vahIdx, valIdx } = valueArea(bins, poc, vaPct)
  const vah = bins[vahIdx]!.priceLevel + binSize / 2
  const val = bins[valIdx]!.priceLevel - binSize / 2

  // HVN: local maxima above 1.5× average volume
  const totalVol = bins.reduce((s, b) => s + b.volume, 0)
  const avgVol = totalVol / numBins
  const hvn: number[] = []
  for (let i = 1; i < bins.length - 1; i++) {
    const v = bins[i]!.volume
    if (v > avgVol * 1.5 && v > bins[i - 1]!.volume && v > bins[i + 1]!.volume) {
      hvn.push(bins[i]!.priceLevel)
    }
  }

  // LVN: center of contiguous zones below 0.5× average
  const lvnThreshold = avgVol * 0.5
  const lvn: number[] = []
  let zoneStart = -1
  for (let i = 1; i < bins.length - 1; i++) {
    if (bins[i]!.volume < lvnThreshold) {
      if (zoneStart === -1) zoneStart = i
    } else if (zoneStart !== -1) {
      lvn.push(bins[Math.floor((zoneStart + i - 1) / 2)]!.priceLevel)
      zoneStart = -1
    }
  }
  if (zoneStart !== -1) {
    lvn.push(bins[Math.floor((zoneStart + bins.length - 2) / 2)]!.priceLevel)
  }

  return { poc: pocPrice, vah, val, hvn, lvn }
}
