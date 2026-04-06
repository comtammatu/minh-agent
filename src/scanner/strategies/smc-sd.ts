/**
 * SMC+S&D Zone Bounce Strategy — IStrategy implementation.
 *
 * Middle ground between Layered (too strict) and Quant (no zone awareness).
 *
 * Logic:
 *   1. Direction from BOS/CHoCH (skip Wyckoff, skip HTF)
 *   2. Premium/Discount filter (long only in discount, short only in premium)
 *   3. Compile key zones (OB + FVG + swing pivots)
 *   4. Zone proximity check (isAtZone)
 *   5. Bounce detection (wick rejection or directional close)
 *   6. Confidence scoring with regime modifier
 *   7. SL/TP via structure targets
 *
 * Pure function — zero I/O.
 */

import type { Candle, CandleInterval, Signal, PatternType, SignalSide } from '../../types.js'
import type { IStrategy } from '../strategy.js'
import { detectStructureBreaks, findPivots, premiumDiscount } from '../../indicators/smc.js'
import { compileKeyZones } from '../../indicators/structure.js'
import { isAtZone } from '../layers/confirm.js'
import { computeStructureTargets } from '../layers/trigger.js'
import { applyRegimeModifier } from '../regime.js'
import { detectRegime, atr } from '../../indicators/core.js'
import { detectVSA } from '../../indicators/vsa.js'
import {
  SMC_BREAK_LOOKBACK,
  SMC_DEDUP_BARS,
  ZONE_MAX_AGE,
  MIN_CONFIDENCE,
  STRUCTURE_STOP_ATR_BUFFER,
  MIN_CANDLES_FOR_SCAN,
} from '../../config.js'

// ── Dedup: track last signal bar per coin|interval ──────────────────────────

const lastSignalBar = new Map<string, number>()

export class SmcSdStrategy implements IStrategy {
  readonly id = 'smc-sd'
  readonly name = 'SMC + S&D Zone Bounce'
  readonly patternTypes: ReadonlyArray<PatternType> = ['smc-sd']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null

    // Skip 4h — underperforms on this strategy (31.8% WR in backtest)
    if (interval === '4h') return null

    // ── 1. DIRECTION from BOS/CHoCH ────────────────────────────────────────
    const breaks = detectStructureBreaks(candles, idx)
    // Find the most recent break within lookback window
    const recentBreak = breaks
      .filter(b => idx - b.index <= SMC_BREAK_LOOKBACK)
      .at(-1)  // last = most recent
    if (!recentBreak) return null

    const side: SignalSide = recentBreak.direction === 'bullish' ? 'long' : 'short'

    // ── 2. PREMIUM/DISCOUNT filter ─────────────────────────────────────────
    const pivots = findPivots(candles, idx, 5)
    const highs = pivots.filter(p => p.kind === 'high')
    const lows = pivots.filter(p => p.kind === 'low')
    if (highs.length === 0 || lows.length === 0) return null

    const swingHigh = Math.max(...highs.slice(-3).map(p => p.price))
    const swingLow = Math.min(...lows.slice(-3).map(p => p.price))
    const currentPrice = candles[idx]!.c
    const pd = premiumDiscount(swingHigh, swingLow, currentPrice)

    // Premium/discount: soft filter — penalize confidence instead of hard reject
    const pdMisaligned = (side === 'long' && pd === 'premium')
                      || (side === 'short' && pd === 'discount')

    // ── 3. ZONES ───────────────────────────────────────────────────────────
    const { demandZones, supplyZones } = compileKeyZones(candles, idx)
    const rawZones = side === 'long' ? demandZones : supplyZones
    const zones = rawZones.filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE)
    if (zones.length === 0) return null

    // ── 4. ZONE PROXIMITY ──────────────────────────────────────────────────
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null

    const candle = candles[idx]!
    let bestZoneIdx = -1
    let proximity = { atZone: false, wickTouch: false, nearZone: false, throughZone: false }

    for (let i = 0; i < zones.length; i++) {
      const prox = isAtZone(candle, zones[i]!, atrVal)
      if (prox.atZone) {
        bestZoneIdx = i
        proximity = prox
        break  // zones sorted by proximity — first match is nearest
      }
    }
    if (bestZoneIdx === -1) return null
    const bestZone = zones[bestZoneIdx]!

    // ── 5. BOUNCE detection ────────────────────────────────────────────────
    let isBounce = false
    if (side === 'long') {
      // Wick rejection: dipped into zone but closed above zone top
      // OR bullish close at/near zone
      // OR through-zone sweep + recovery
      isBounce = (candle.l <= bestZone.top && candle.c > bestZone.top)
              || (candle.c > candle.o && proximity.nearZone)
              || proximity.throughZone
    } else {
      isBounce = (candle.h >= bestZone.bottom && candle.c < bestZone.bottom)
              || (candle.c < candle.o && proximity.nearZone)
              || proximity.throughZone
    }
    if (!isBounce) return null

    // ── 6. CONFIDENCE ──────────────────────────────────────────────────────
    let confidence = 0.50
    if (recentBreak.kind === 'choch') confidence += 0.10
    if (pdMisaligned) {
      confidence -= 0.10  // penalty for trading against P/D zone
    } else if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) {
      confidence += 0.05  // bonus for aligned P/D
    }
    if (proximity.throughZone) confidence += 0.05
    if (bestZone.strength > 0.6) confidence += 0.05

    // Optional VSA boost
    const vsaSignals = detectVSA(candles, idx)
    const wantDir = side === 'long' ? 'bullish' : 'bearish'
    if (vsaSignals.some(s => s.direction === wantDir)) confidence += 0.05

    // Regime modifier
    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime)

    if (confidence < MIN_CONFIDENCE) return null

    // ── 7. SL / TP ────────────────────────────────────────────────────────
    const entry = candle.c
    const slBuffer = atrVal * STRUCTURE_STOP_ATR_BUFFER
    const sl = side === 'long'
      ? Math.min(candle.l, bestZone.bottom) - slBuffer
      : Math.max(candle.h, bestZone.top) + slBuffer

    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)

    // ── 8. DEDUP ──────────────────────────────────────────────────────────
    const dedupKey = `${coin}|${interval}`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    // ── 9. Return Signal ──────────────────────────────────────────────────
    return {
      type: 'smc-sd',
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      patternData: {
        breakKind: recentBreak.kind,
        breakDirection: recentBreak.direction,
        breakLevel: recentBreak.level,
        premiumDiscount: pd,
        zoneOrigin: bestZone.origin,
        zoneTop: bestZone.top,
        zoneBottom: bestZone.bottom,
        zoneStrength: bestZone.strength,
        throughZone: proximity.throughZone,
        regime,
        tp2Price: tp2,
        atrAtEntry: atrVal,
      },
    }
  }

  minCandles(): number {
    return MIN_CANDLES_FOR_SCAN
  }

  clearState(): void {
    lastSignalBar.clear()
  }
}
