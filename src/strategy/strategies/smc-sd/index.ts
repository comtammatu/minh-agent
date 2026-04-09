/**
 * SMC+S&D Zone Bounce Strategy — ICT-Enhanced v3.
 *
 * ICT Model (Full):
 *   1. HTF Structure Alignment (soft: confidence bonus/penalty)
 *   2. Direction from BOS/CHoCH on current TF
 *   3. Premium/Discount filter
 *   4. OTE Zone filter (Fib 62-79%)
 *   5. Zone compilation: OB + FVG + swing + Breaker Block + Inversion FVG
 *   6. Zone proximity + strength filter
 *   7. Displacement bounce detection (tiered: displacement > sweep > wick)
 *   8. Liquidity pool confluence (BSL/SSL)
 *   9. Crypto Killzone time filter (London/US/Asia sessions)
 *  10. Confidence scoring with all modifiers
 *  11. SL/TP via structure targets
 *
 * Pure function — zero I/O.
 */

import type { Candle, CandleInterval, Signal, PatternType, SignalSide, StrategyContext, KeyZone } from '../../../types.js'
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
  detectBreakerBlocks,
  detectInversionFVGs,
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
  SMC_ICT_KILLZONE_ENABLED,
  SMC_ICT_KILLZONES,
  SMC_ICT_KILLZONE_PENALTY,
  SMC_ICT_BREAKER_BLOCK_ENABLED,
  SMC_ICT_BREAKER_BLOCK_BONUS,
  SMC_ICT_INVERSION_FVG_ENABLED,
  SMC_ICT_INVERSION_FVG_BONUS,
} from '../../../config.js'

// ── Dedup: track last signal bar per coin|interval ──────────────────────────

const lastSignalBar = new Map<string, number>()

// ── Killzone helper ─────────────────────────────────────────────────────────

function getKillzoneBonus(timestampMs: number): { inKillzone: boolean; bonus: number; name: string } {
  const hourUTC = new Date(timestampMs).getUTCHours()
  for (const kz of SMC_ICT_KILLZONES) {
    if (kz.startUTC <= kz.endUTC) {
      // Normal range (e.g., 7-10)
      if (hourUTC >= kz.startUTC && hourUTC < kz.endUTC) {
        return { inKillzone: true, bonus: kz.bonus, name: kz.name }
      }
    } else {
      // Wraps midnight (e.g., 22-2)
      if (hourUTC >= kz.startUTC || hourUTC < kz.endUTC) {
        return { inKillzone: true, bonus: kz.bonus, name: kz.name }
      }
    }
  }
  return { inKillzone: false, bonus: 0, name: 'off-session' }
}

export class SmcSdStrategy implements IStrategy {
  readonly id = 'smc-sd'
  readonly name = 'SMC + S&D Zone Bounce (ICT)'
  readonly patternTypes: ReadonlyArray<PatternType> = ['smc-sd']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null
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

    // ── 1b. ICT HTF STRUCTURE ALIGNMENT (soft) ─────────────────────────
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

    if ((side === 'long' && pd === 'premium') || (side === 'short' && pd === 'discount')) return null

    // ── 2b. ICT OTE ZONE FILTER ────────────────────────────────────────
    let inOTE = false
    if (SMC_ICT_OTE_FILTER) {
      if (side === 'long' && lows.length > 0) {
        const impulseStart = Math.min(...lows.slice(-3).map(p => p.price))
        const ote = oteZone(impulseStart, recentBreak.level)
        if (ote) inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
      } else if (side === 'short' && highs.length > 0) {
        const impulseStart = Math.max(...highs.slice(-3).map(p => p.price))
        const ote = oteZone(impulseStart, recentBreak.level)
        if (ote) inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
      }
    }

    // ── 3. ZONES — enhanced with Breaker Blocks + Inversion FVGs ──────
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones: KeyZone[] = [...(side === 'long' ? demandZones : supplyZones)]

    // Add Breaker Blocks as high-priority zones
    let atBreakerBlock = false
    if (SMC_ICT_BREAKER_BLOCK_ENABLED) {
      const breakers = detectBreakerBlocks(candles, idx)
      for (const bb of breakers) {
        if (bb.type === (side === 'long' ? 'demand' : 'supply')) {
          rawZones.push({
            type: bb.type,
            top: bb.top,
            bottom: bb.bottom,
            strength: 0.85,  // Breaker Blocks are high-strength by definition
            origin: 'breaker-block',
            createdAtIdx: bb.index,
          })
        }
      }
    }

    // Add Inversion FVGs as zones
    let atInversionFVG = false
    if (SMC_ICT_INVERSION_FVG_ENABLED) {
      const inversions = detectInversionFVGs(candles, idx, tol)
      for (const inv of inversions) {
        if (inv.type === (side === 'long' ? 'demand' : 'supply')) {
          rawZones.push({
            type: inv.type,
            top: inv.top,
            bottom: inv.bottom,
            strength: 0.75,  // Inversion FVGs are moderately strong
            origin: 'inversion-fvg',
            createdAtIdx: inv.index,
          })
        }
      }
    }

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

    // Track if we're at a special ICT zone
    atBreakerBlock = bestZone.origin === 'breaker-block'
    atInversionFVG = bestZone.origin === 'inversion-fvg'

    // ── 5. ICT DISPLACEMENT BOUNCE DETECTION ──────────────────────────
    let isBounce = false
    let bounceQuality: 'displacement' | 'wick' | 'sweep' = 'wick'

    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)

    if (side === 'long') {
      const wickEntered = candle.l <= bestZone.top + tol
      const closedAbove = candle.c > bestZone.top - tol
      const bullishClose = candle.c > candle.o

      if (wickEntered && closedAbove && hasDisplacement && bullishClose) {
        isBounce = true; bounceQuality = 'displacement'
      } else if (proximity.throughZone && closedAbove) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sweep = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sweep?.direction === 'bullish') { isBounce = true; bounceQuality = 'sweep' }
        } else { isBounce = true; bounceQuality = 'sweep' }
      } else if (wickEntered && closedAbove) {
        isBounce = true; bounceQuality = 'wick'
      } else if (proximity.wickTouch && bullishClose) {
        isBounce = true; bounceQuality = 'wick'
      }
    } else {
      const wickEntered = candle.h >= bestZone.bottom - tol
      const closedBelow = candle.c < bestZone.bottom + tol
      const bearishClose = candle.c < candle.o

      if (wickEntered && closedBelow && hasDisplacement && bearishClose) {
        isBounce = true; bounceQuality = 'displacement'
      } else if (proximity.throughZone && closedBelow) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sweep = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sweep?.direction === 'bearish') { isBounce = true; bounceQuality = 'sweep' }
        } else { isBounce = true; bounceQuality = 'sweep' }
      } else if (wickEntered && closedBelow) {
        isBounce = true; bounceQuality = 'wick'
      } else if (proximity.wickTouch && bearishClose) {
        isBounce = true; bounceQuality = 'wick'
      }
    }
    if (!isBounce) return null

    // ── 5b. BOUNCE CANDLE QUALITY ───────────────────────────────────
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    // ── 5c. ADX TRENDING FILTER ─────────────────────────────────────
    // 15m: lowered from 25→20 to restore 15m signals (previously killed all 15m entries)
    const adxVal = adx(candles, idx)
    const adxThreshold = interval === '15m' ? 20 : 18
    if (!isNaN(adxVal) && adxVal < adxThreshold) return null

    // ── 6. ICT CONFIDENCE SCORING ─────────────────────────────────────
    // Base 0.65: headroom for htfOpposed(-0.06) + killzone(-0.04) + regime×0.85
    // Worst case: 0.65+0.05-0.06-0.04 = 0.60 × 0.85 = 0.51 > MIN_CONFIDENCE 0.50
    let confidence = 0.65

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

    // ICT HTF alignment
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS
    // HTF opposition: reduced from -0.10 to -0.06 — was killing 15m signals
    if (htfOpposed) confidence -= 0.06

    // ICT OTE zone bonus
    if (inOTE) confidence += SMC_ICT_OTE_BONUS

    // ICT Breaker Block bonus — these are proven failed levels
    if (atBreakerBlock) confidence += SMC_ICT_BREAKER_BLOCK_BONUS

    // ICT Inversion FVG bonus — resolved inefficiency acts as support/resistance
    if (atInversionFVG) confidence += SMC_ICT_INVERSION_FVG_BONUS

    // Zone quality
    if (bestZone.strength > 0.6) confidence += 0.05
    if (bestZone.strength > 0.8) confidence += 0.05

    // ADX trending bonus
    if (!isNaN(adxVal) && adxVal > 30) confidence += 0.08
    else if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05

    // Volume spike bonus
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 2.0) confidence += 0.08
    else if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05

    // VSA boost
    const vsaSignals = detectVSA(candles, idx)
    const wantDir = side === 'long' ? 'bullish' : 'bearish'
    if (vsaSignals.some(s => s.direction === wantDir)) confidence += 0.05

    // ── 6b. ICT CRYPTO KILLZONE ───────────────────────────────────────
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      if (kz.inKillzone) {
        confidence += kz.bonus  // bonus for high-volume session
      } else {
        confidence -= SMC_ICT_KILLZONE_PENALTY  // penalty for low-volume hours
      }
    }

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
    const finalTp1 = tp1
    const pools = findLiquidityPools(candles, idx, { tolerance: tol })
    if (pools.length > 0) {
      const opposingPools = side === 'long'
        ? pools.filter(p => p.type === 'bsl' && p.level > entry)
        : pools.filter(p => p.type === 'ssl' && p.level < entry)
      if (opposingPools.length > 0) {
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
        atBreakerBlock,
        atInversionFVG,
        killzoneName,
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
