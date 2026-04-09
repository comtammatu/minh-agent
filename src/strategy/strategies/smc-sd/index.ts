/**
 * SMC+S&D Zone Bounce Strategy — ICT-Enhanced IStrategy implementation.
 *
 * ICT Model (2024):
 *   1. HTF Structure Alignment (top-down: 4h→15m, 1h→15m, daily→4h)
 *   2. Direction from BOS/CHoCH on current TF
 *   3. Premium/Discount filter (long=discount, short=premium)
 *   4. OTE Zone filter (Fib 62-79% of impulse leg)
 *   5. Compile key zones (OB + FVG + swing pivots)
 *   6. Zone proximity check with strength filter
 *   7. Displacement bounce detection (strong body rejection, not just wick)
 *   8. Liquidity sweep integration (BSL/SSL targeting)
 *   9. Confidence scoring with regime + HTF + OTE modifiers
 *  10. SL/TP via structure targets with liquidity pool TP targeting
 *
 * Pure function — zero I/O.
 */

import type { Candle, CandleInterval, Signal, PatternType, SignalSide, StrategyContext } from '../../../types.js'
import type { IStrategy } from '../../registry.js'
import {
  detectStructureBreaks,
  findPivots,
  premiumDiscount,
  compileKeyZones,
  htfStructureBias,
  isDisplacementCandle,
  findLiquidityPools,
  detectLiquiditySweep,
  oteZone,
} from '../../../indicators/smc.js'
import { isAtZone } from '../layered/layers/confirm.js'
import { computeStructureTargets } from '../layered/layers/trigger.js'
import { applyRegimeModifier } from '../../shared/regime.js'
import { detectRegime, atr, adx, volumeRatio } from '../../../indicators/core.js'
import { detectVSA } from '../../../indicators/vsa.js'
import {
  SMC_BREAK_LOOKBACK,
  SMC_DEDUP_BARS,
  SMC_SD_SKIP_INTERVALS,
  SMC_PRICE_TOLERANCE_ATR_MULT,
  SMC_MIN_BODY_RATIO,
  SMC_MIN_ZONE_STRENGTH,
  SMC_MIN_RR,
  MAX_TRADE_SL_PCT,
  ZONE_MAX_AGE,
  MIN_CONFIDENCE,
  STRUCTURE_STOP_ATR_BUFFER,
  MIN_CANDLES_FOR_SCAN,
  SMC_ICT_HTF_ALIGNMENT,
  SMC_ICT_OTE_FILTER,
  SMC_ICT_DISPLACEMENT_BODY_ATR,
  SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH,
  SMC_ICT_HTF_ALIGNED_BONUS,
  SMC_ICT_OTE_BONUS,
  SMC_ICT_LIQUIDITY_POOL_TP_BONUS,
} from '../../../config.js'

// ── Dedup: track last signal bar per coin|interval ──────────────────────────

const lastSignalBar = new Map<string, number>()

export class SmcSdStrategy implements IStrategy {
  readonly id = 'smc-sd'
  readonly name = 'SMC + S&D Zone Bounce (ICT)'
  readonly patternTypes: ReadonlyArray<PatternType> = ['smc-sd']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null

    // Skip intervals that underperform on this strategy
    if (SMC_SD_SKIP_INTERVALS.includes(interval)) return null

    // ── 0. ATR + TOLERANCE ───────────────────────────────────────────────
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // ── 1. DIRECTION from BOS/CHoCH ────────────────────────────────────
    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks
      .filter(b => idx - b.index <= SMC_BREAK_LOOKBACK)
      .at(-1)
    if (!recentBreak) return null

    const side: SignalSide = recentBreak.direction === 'bullish' ? 'long' : 'short'

    // ── 1b. ICT HTF STRUCTURE ALIGNMENT (soft — confidence only) ────────
    // HTF alignment = confidence bonus. HTF opposition = confidence penalty.
    // No hard reject: backtest showed HTF hard block kills too many valid entries.
    let htfAligned = false
    let htfOpposed = false
    if (SMC_ICT_HTF_ALIGNMENT && context?.htfCandles && context.htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
      const htfIdx = context.htfCandles.length - 2
      if (htfIdx >= MIN_CANDLES_FOR_SCAN) {
        const htfBias = htfStructureBias(context.htfCandles, htfIdx)
        htfAligned = (side === 'long' && htfBias.bias === 'bullish') ||
                     (side === 'short' && htfBias.bias === 'bearish')
        htfOpposed = (side === 'long' && htfBias.bias === 'bearish' && htfBias.confidence > 0.7) ||
                     (side === 'short' && htfBias.bias === 'bullish' && htfBias.confidence > 0.7)
      }
    }

    // ── 2. PREMIUM/DISCOUNT filter ────────────────────────────────────
    const pivots = findPivots(candles, idx, 5, tol)
    const highs = pivots.filter(p => p.kind === 'high')
    const lows = pivots.filter(p => p.kind === 'low')
    if (highs.length === 0 || lows.length === 0) return null

    const swingHigh = Math.max(...highs.slice(-3).map(p => p.price))
    const swingLow = Math.min(...lows.slice(-3).map(p => p.price))
    const currentPrice = candles[idx]!.c
    const pd = premiumDiscount(swingHigh, swingLow, currentPrice)

    // Premium/discount: hard reject misaligned
    const pdMisaligned = (side === 'long' && pd === 'premium')
                      || (side === 'short' && pd === 'discount')
    if (pdMisaligned) return null

    // ── 2b. ICT OTE ZONE FILTER ────────────────────────────────────────
    // Optimal Trade Entry: Fib 62-79% retracement of the impulse leg
    let inOTE = false
    if (SMC_ICT_OTE_FILTER) {
      const recentLows = lows.slice(-3)
      const recentHighs = highs.slice(-3)

      if (side === 'long' && recentLows.length > 0) {
        const impulseStart = Math.min(...recentLows.map(p => p.price))
        const impulseEnd = recentBreak.level
        const ote = oteZone(impulseStart, impulseEnd)
        if (ote) {
          inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
        }
      } else if (side === 'short' && recentHighs.length > 0) {
        const impulseStart = Math.max(...recentHighs.map(p => p.price))
        const impulseEnd = recentBreak.level
        const ote = oteZone(impulseStart, impulseEnd)
        if (ote) {
          inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
        }
      }
    }

    // ── 3. ZONES ──────────────────────────────────────────────────────
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones = side === 'long' ? demandZones : supplyZones
    const zones = rawZones.filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE)
    if (zones.length === 0) return null

    // ── 4. ZONE PROXIMITY ─────────────────────────────────────────────
    const candle = candles[idx]!
    let bestZoneIdx = -1
    let proximity = { atZone: false, wickTouch: false, nearZone: false, throughZone: false }

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]!
      if (z.strength < SMC_MIN_ZONE_STRENGTH) continue
      const prox = isAtZone(candle, z, atrVal)
      if (prox.atZone) {
        bestZoneIdx = i
        proximity = prox
        break
      }
    }
    if (bestZoneIdx === -1) return null
    const bestZone = zones[bestZoneIdx]!

    // ── 5. ICT DISPLACEMENT BOUNCE DETECTION ──────────────────────────
    let isBounce = false
    let bounceQuality: 'displacement' | 'wick' | 'sweep' = 'wick'

    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)

    if (side === 'long') {
      const wickEntered = candle.l <= bestZone.top + tol
      const closedAbove = candle.c > bestZone.top - tol
      const bullishClose = candle.c > candle.o

      // Priority 1: Displacement rejection (ICT ideal — strong body + direction)
      if (wickEntered && closedAbove && hasDisplacement && bullishClose) {
        isBounce = true
        bounceQuality = 'displacement'
      }
      // Priority 2: Through-zone sweep with recovery (no directional body required)
      else if (proximity.throughZone && closedAbove) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sweep = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sweep && sweep.direction === 'bullish') {
            isBounce = true
            bounceQuality = 'sweep'
          }
        } else {
          isBounce = true
          bounceQuality = 'sweep'
        }
      }
      // Priority 3: Wick rejection — close above zone (directional body is soft bonus)
      else if (wickEntered && closedAbove) {
        isBounce = true
        bounceQuality = 'wick'
      }
      // Priority 4: wickTouch (from isAtZone) with bullish close
      else if (proximity.wickTouch && bullishClose) {
        isBounce = true
        bounceQuality = 'wick'
      }
    } else {
      const wickEntered = candle.h >= bestZone.bottom - tol
      const closedBelow = candle.c < bestZone.bottom + tol
      const bearishClose = candle.c < candle.o

      if (wickEntered && closedBelow && hasDisplacement && bearishClose) {
        isBounce = true
        bounceQuality = 'displacement'
      } else if (proximity.throughZone && closedBelow) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sweep = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sweep && sweep.direction === 'bearish') {
            isBounce = true
            bounceQuality = 'sweep'
          }
        } else {
          isBounce = true
          bounceQuality = 'sweep'
        }
      } else if (wickEntered && closedBelow) {
        isBounce = true
        bounceQuality = 'wick'
      } else if (proximity.wickTouch && bearishClose) {
        isBounce = true
        bounceQuality = 'wick'
      }
    }
    if (!isBounce) return null

    // ── 5b. BOUNCE CANDLE QUALITY — reject doji/indecision ───────────
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    // ── 5c. ADX TRENDING FILTER ─────────────────────────────────────
    const adxVal = adx(candles, idx)
    const adxThreshold = interval === '15m' ? 25 : 18
    if (!isNaN(adxVal) && adxVal < adxThreshold) return null

    // ── 6. ICT CONFIDENCE SCORING ─────────────────────────────────────
    // Base 0.60: must survive regime × 0.85 (neutral) → 0.51 > MIN_CONFIDENCE 0.50
    let confidence = 0.60

    // BOS/CHoCH type
    if (recentBreak.kind === 'choch') confidence += 0.10

    // Bounce quality (ICT tiered)
    if (bounceQuality === 'displacement') confidence += 0.12
    else if (bounceQuality === 'sweep') confidence += 0.10
    else confidence += 0.05

    // Directional body
    const isBullishCandle = candle.c > candle.o
    const directionalBody = (side === 'long' && isBullishCandle) || (side === 'short' && !isBullishCandle)
    if (directionalBody) confidence += 0.05

    // P/D zone bonus
    if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) {
      confidence += 0.05
    }

    // ICT HTF alignment: bonus if aligned, penalty if opposed
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS
    if (htfOpposed) confidence -= 0.10

    // ICT OTE zone bonus
    if (inOTE) confidence += SMC_ICT_OTE_BONUS

    // Zone quality
    if (bestZone.strength > 0.6) confidence += 0.05
    if (bestZone.strength > 0.8) confidence += 0.05

    // ADX trending bonus (tiered)
    if (!isNaN(adxVal) && adxVal > 30) confidence += 0.08
    else if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05

    // Volume spike bonus (tiered)
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 2.0) confidence += 0.08
    else if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05

    // VSA boost
    const vsaSignals = detectVSA(candles, idx)
    const wantDir = side === 'long' ? 'bullish' : 'bearish'
    if (vsaSignals.some(s => s.direction === wantDir)) confidence += 0.05

    // Regime modifier
    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime)

    if (confidence < MIN_CONFIDENCE) return null

    // ── 7. SL / TP ───────────────────────────────────────────────────
    const entry = candle.c
    const slBuffer = atrVal * STRUCTURE_STOP_ATR_BUFFER
    const sl = side === 'long'
      ? bestZone.bottom - slBuffer
      : bestZone.top + slBuffer

    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)

    // ── 7b. ICT Liquidity Pool Confluence (confidence only) ─────────
    // Pool targeting disabled for TP replacement — it was reducing avg R:R from 3.68→1.96.
    // Instead, use pool proximity as confidence boost: if opposing pool exists near TP,
    // price is more likely to reach TP (smart money targets these pools).
    const finalTp1 = tp1
    const pools = findLiquidityPools(candles, idx, { tolerance: tol })
    if (pools.length > 0) {
      const opposingPools = side === 'long'
        ? pools.filter(p => p.type === 'bsl' && p.level > entry)
        : pools.filter(p => p.type === 'ssl' && p.level < entry)

      if (opposingPools.length > 0) {
        // Boost confidence if a liquidity pool exists between entry and TP (high-probability target)
        const nearest = side === 'long'
          ? opposingPools.reduce((a, b) => a.level < b.level ? a : b)
          : opposingPools.reduce((a, b) => a.level > b.level ? a : b)
        const tpDist = Math.abs(tp1 - entry)
        const poolDist = Math.abs(nearest.level - entry)
        if (tpDist > 0 && poolDist <= tpDist) {
          confidence += SMC_ICT_LIQUIDITY_POOL_TP_BONUS
        }
      }
    }

    // ── 7c. SL% CAP ─────────────────────────────────────────────────
    const risk = Math.abs(entry - sl)
    const slPct = risk / entry
    if (slPct > MAX_TRADE_SL_PCT) return null

    // ── 7d. R:R PRE-FILTER ──────────────────────────────────────────
    const reward = Math.abs(finalTp1 - entry)
    if (risk <= 0 || reward / risk < SMC_MIN_RR) return null

    // ── 8. DEDUP ────────────────────────────────────────────────────
    const dedupKey = `${coin}|${interval}`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    // ── 9. Return Signal ────────────────────────────────────────────
    return {
      type: 'smc-sd',
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: finalTp1,
      confluenceGrade: 'B',
      confluenceCount: 3,
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
        // ICT metadata
        htfAligned,
        inOTE,
        bounceQuality,
        hasDisplacement,
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
