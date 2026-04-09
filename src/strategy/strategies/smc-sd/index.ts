/**
 * SMC+S&D Zone Bounce Strategy — ICT Multi-TF Drill-Down v4.
 *
 * 3-MODE ROUTING:
 *   4h → scan4hPOI(): detect BOS/CHoCH, compile zones, register HTF POIs
 *   15m → scan15mDrillDown(): check POIs, confirm with LTF CHoCH, tight entry
 *   1h → scan1hSameTF(): existing same-TF analysis (unchanged)
 *
 * ICT Model: HTF identifies WHERE (4h zones), LTF identifies WHEN (15m CHoCH).
 * Result: 15m-tight SL + 4h-wide TP → R:R 5:1 to 20:1.
 *
 * Pure function — zero I/O. Module-level state for POI pool + dedup.
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
  findConfirmingBreak,
  oteZone,
  detectFVG,
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
  SMC_HTF_POI_TTL_MS,
  SMC_LTF_CHOCH_LOOKBACK,
  SMC_LTF_ENTRY_FVG_LOOKBACK,
  SMC_DRILLDOWN_MIN_RR,
  SMC_DRILLDOWN_SL_ATR_BUFFER,
  SMC_DRILLDOWN_CONFIDENCE_BASE,
  SMC_DRILLDOWN_CHOCH_BONUS,
  SMC_DRILLDOWN_MAX_POIS,
} from '../../../config.js'

// ── Module-level state ──────────────────────────────────────────────────────

const lastSignalBar = new Map<string, number>()

// ── HTF POI Pool (Multi-TF Drill-Down) ──────────────────────────────────────

interface HtfPOI {
  coin: string
  direction: 'bullish' | 'bearish'
  breakKind: 'bos' | 'choch'
  zoneTop: number
  zoneBottom: number
  zoneOrigin: string
  strength: number
  createdAtMs: number
  breakLevel: number
}

/** Module-level POI pool. Key = coin. 4h scan writes, 15m scan reads. */
const htfPOIs = new Map<string, HtfPOI[]>()

// ── Killzone helper ─────────────────────────────────────────────────────────

function getKillzoneBonus(timestampMs: number): { inKillzone: boolean; bonus: number; name: string } {
  const hourUTC = new Date(timestampMs).getUTCHours()
  for (const kz of SMC_ICT_KILLZONES) {
    if (kz.startUTC <= kz.endUTC) {
      if (hourUTC >= kz.startUTC && hourUTC < kz.endUTC) return { inKillzone: true, bonus: kz.bonus, name: kz.name }
    } else {
      if (hourUTC >= kz.startUTC || hourUTC < kz.endUTC) return { inKillzone: true, bonus: kz.bonus, name: kz.name }
    }
  }
  return { inKillzone: false, bonus: 0, name: 'off-session' }
}

// ── Strategy ────────────────────────────────────────────────────────────────

export class SmcSdStrategy implements IStrategy {
  readonly id = 'smc-sd'
  readonly name = 'SMC + S&D Zone Bounce (ICT)'
  readonly patternTypes: ReadonlyArray<PatternType> = ['smc-sd']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null
    if (SMC_SD_SKIP_INTERVALS.includes(interval)) return null

    // ── 3-MODE ROUTING ──────────────────────────────────────────────
    if (interval === '4h') return this.scan4hPOI(coin, candles, idx)
    if (interval === '15m') return this.scan15mDrillDown(coin, candles, idx, context)
    // 1h (and others): same-TF analysis
    return this.scan1hSameTF(coin, interval, candles, idx, context)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4h MODE: POI REGISTRATION (never emits signals)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan4hPOI(coin: string, candles: Candle[], idx: number): null {
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // Detect 4h BOS/CHoCH
    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks.filter(b => idx - b.index <= SMC_BREAK_LOOKBACK).at(-1)
    if (!recentBreak) return null

    const direction = recentBreak.direction

    // Compile zones: demand for bullish, supply for bearish (pullback entry zones)
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones: KeyZone[] = [...(direction === 'bullish' ? demandZones : supplyZones)]

    // Add Breaker Blocks
    if (SMC_ICT_BREAKER_BLOCK_ENABLED) {
      for (const bb of detectBreakerBlocks(candles, idx)) {
        if (bb.type === (direction === 'bullish' ? 'demand' : 'supply')) {
          rawZones.push({ type: bb.type, top: bb.top, bottom: bb.bottom, strength: 0.85, origin: 'breaker-block', createdAtIdx: bb.index })
        }
      }
    }

    // Add Inversion FVGs
    if (SMC_ICT_INVERSION_FVG_ENABLED) {
      for (const inv of detectInversionFVGs(candles, idx, tol)) {
        if (inv.type === (direction === 'bullish' ? 'demand' : 'supply')) {
          rawZones.push({ type: inv.type, top: inv.top, bottom: inv.bottom, strength: 0.75, origin: 'inversion-fvg', createdAtIdx: inv.index })
        }
      }
    }

    // Filter by age + strength, sort by strength desc
    const zones = rawZones
      .filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE && z.strength >= SMC_MIN_ZONE_STRENGTH)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, SMC_DRILLDOWN_MAX_POIS)

    if (zones.length === 0) return null

    // Build POIs
    const nowMs = candles[idx]!.t
    const newPOIs: HtfPOI[] = zones.map(z => ({
      coin,
      direction,
      breakKind: recentBreak.kind,
      zoneTop: z.top,
      zoneBottom: z.bottom,
      zoneOrigin: z.origin,
      strength: z.strength,
      createdAtMs: nowMs,
      breakLevel: recentBreak.level,
    }))

    // Expire old + merge new
    const existing = (htfPOIs.get(coin) ?? []).filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
    const merged = [...existing, ...newPOIs].slice(-SMC_DRILLDOWN_MAX_POIS)
    htfPOIs.set(coin, merged)

    return null  // 4h never emits signals
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m MODE: DRILL-DOWN ENTRY (4h POI + 15m CHoCH confirmation)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan15mDrillDown(coin: string, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    // ── A. POI CHECK ──────────────────────────────────────────────────
    const pois = htfPOIs.get(coin)
    if (!pois || pois.length === 0) return null

    const candle = candles[idx]!
    const nowMs = candle.t

    // Expire stale POIs
    const activePOIs = pois.filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
    if (activePOIs.length === 0) { htfPOIs.set(coin, []); return null }
    htfPOIs.set(coin, activePOIs)

    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // Find POI at current price
    let bestPOI: HtfPOI | null = null
    for (const poi of activePOIs) {
      const poiZone: KeyZone = {
        type: poi.direction === 'bullish' ? 'demand' : 'supply',
        top: poi.zoneTop,
        bottom: poi.zoneBottom,
        strength: poi.strength,
        origin: poi.zoneOrigin,
        createdAtIdx: 0,
      }
      const prox = isAtZone(candle, poiZone, atrVal)
      if (prox.atZone) { bestPOI = poi; break }
    }
    if (!bestPOI) return null

    const side: SignalSide = bestPOI.direction === 'bullish' ? 'long' : 'short'

    // ── B. 15m CHoCH/BOS CONFIRMATION ─────────────────────────────────
    const confirmBreak = findConfirmingBreak(candles, idx, SMC_LTF_CHOCH_LOOKBACK, bestPOI.direction, tol)
    if (!confirmBreak) return null

    // ── C. 15m ENTRY (displacement bounce / wick rejection / FVG) ─────
    let isBounce = false
    let bounceQuality: 'displacement' | 'wick' | 'sweep' | 'fvg' = 'wick'
    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)

    // Check for FVG entry in last N bars (ICT: enter at FVG formed after CHoCH)
    let fvgEntry = false
    for (let i = Math.max(2, idx - SMC_LTF_ENTRY_FVG_LOOKBACK); i <= idx; i++) {
      const fvg = detectFVG(candles, i, tol)
      if (fvg && ((side === 'long' && fvg.bullish) || (side === 'short' && !fvg.bullish))) {
        // Price must be at/near the FVG
        if (side === 'long' && candle.l <= fvg.top && candle.c > fvg.bottom) {
          fvgEntry = true; bounceQuality = 'fvg'; break
        }
        if (side === 'short' && candle.h >= fvg.bottom && candle.c < fvg.top) {
          fvgEntry = true; bounceQuality = 'fvg'; break
        }
      }
    }

    if (fvgEntry) {
      isBounce = true
    } else if (side === 'long') {
      const wickEntered = candle.l <= bestPOI.zoneTop + tol
      const closedAbove = candle.c > bestPOI.zoneTop - tol
      const bullishClose = candle.c > candle.o
      if (wickEntered && closedAbove && hasDisplacement && bullishClose) { isBounce = true; bounceQuality = 'displacement' }
      else if (wickEntered && closedAbove && bullishClose) { isBounce = true; bounceQuality = 'wick' }
    } else {
      const wickEntered = candle.h >= bestPOI.zoneBottom - tol
      const closedBelow = candle.c < bestPOI.zoneBottom + tol
      const bearishClose = candle.c < candle.o
      if (wickEntered && closedBelow && hasDisplacement && bearishClose) { isBounce = true; bounceQuality = 'displacement' }
      else if (wickEntered && closedBelow && bearishClose) { isBounce = true; bounceQuality = 'wick' }
    }
    if (!isBounce) return null

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    // ── D. MIXED-TF SL/TP ─────────────────────────────────────────────
    const entry = candle.c

    // SL: 15m swing structure (tight)
    const pivots15m = findPivots(candles, idx, 3, tol)
    let sl: number
    if (side === 'long') {
      const recentLows = pivots15m.filter(p => p.kind === 'low' && p.index <= idx).slice(-3)
      const swingLow = recentLows.length > 0 ? Math.min(...recentLows.map(p => p.price)) : candle.l
      sl = swingLow - atrVal * SMC_DRILLDOWN_SL_ATR_BUFFER
    } else {
      const recentHighs = pivots15m.filter(p => p.kind === 'high' && p.index <= idx).slice(-3)
      const swingHigh = recentHighs.length > 0 ? Math.max(...recentHighs.map(p => p.price)) : candle.h
      sl = swingHigh + atrVal * SMC_DRILLDOWN_SL_ATR_BUFFER
    }

    // TP: 4h structure targets (wide) — use context.htfCandles
    let tp1: number
    let tp2: number
    if (context?.htfCandles && context.htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
      const htfIdx = context.htfCandles.length - 2
      const targets = computeStructureTargets(context.htfCandles, htfIdx, entry, sl, side)
      tp1 = targets.tp1
      tp2 = targets.tp2
    } else {
      // Fallback: use 15m structure targets with min R:R floor
      const risk = Math.abs(entry - sl)
      const dir = side === 'long' ? 1 : -1
      tp1 = entry + dir * risk * SMC_DRILLDOWN_MIN_RR
      tp2 = entry + dir * risk * (SMC_DRILLDOWN_MIN_RR + 2)
    }

    // SL% cap
    const risk = Math.abs(entry - sl)
    const slPct = risk / entry
    if (slPct > MAX_TRADE_SL_PCT) return null

    // R:R floor
    const reward = Math.abs(tp1 - entry)
    if (risk <= 0 || reward / risk < SMC_DRILLDOWN_MIN_RR) return null

    // ── E. CONFIDENCE ──────────────────────────────────────────────────
    let confidence = SMC_DRILLDOWN_CONFIDENCE_BASE

    // CHoCH bonus (reversal confirmation > BOS)
    if (confirmBreak.kind === 'choch') confidence += SMC_DRILLDOWN_CHOCH_BONUS

    // Bounce quality
    if (bounceQuality === 'fvg') confidence += 0.10
    else if (bounceQuality === 'displacement') confidence += 0.12
    else confidence += 0.05

    // P/D zone bonus
    const pd = premiumDiscount(bestPOI.zoneTop, bestPOI.zoneBottom, entry)
    if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) confidence += 0.05

    // POI strength
    if (bestPOI.strength > 0.7) confidence += 0.05
    if (bestPOI.breakKind === 'choch') confidence += 0.05  // HTF was reversal

    // Killzone
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY
    }

    // ADX, volume, VSA
    const adxVal = adx(candles, idx)
    if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    const vsaSignals = detectVSA(candles, idx)
    if (vsaSignals.some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    // Regime modifier
    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime)

    if (confidence < MIN_CONFIDENCE) return null

    // ── F. DEDUP + SIGNAL ──────────────────────────────────────────────
    const dedupKey = `${coin}|15m`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    return {
      type: 'smc-sd',
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      confluenceGrade: 'B',
      confluenceCount: 3,
      patternData: {
        drillDown: true,
        htfDirection: bestPOI.direction,
        htfBreakKind: bestPOI.breakKind,
        htfBreakLevel: bestPOI.breakLevel,
        htfZoneOrigin: bestPOI.zoneOrigin,
        htfZoneTop: bestPOI.zoneTop,
        htfZoneBottom: bestPOI.zoneBottom,
        ltfConfirmKind: confirmBreak.kind,
        ltfEntryType: bounceQuality,
        premiumDiscount: pd,
        regime,
        tp2Price: tp2,
        atrAtEntry: atrVal,
        killzoneName,
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1h MODE: SAME-TF ANALYSIS (existing ICT v3 logic, unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan1hSameTF(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // 1. Direction from BOS/CHoCH
    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks.filter(b => idx - b.index <= SMC_BREAK_LOOKBACK).at(-1)
    if (!recentBreak) return null
    const side: SignalSide = recentBreak.direction === 'bullish' ? 'long' : 'short'

    // 1b. HTF alignment (soft)
    let htfAligned = false
    let htfOpposed = false
    if (SMC_ICT_HTF_ALIGNMENT && context?.htfCandles && context.htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
      const htfIdx = context.htfCandles.length - 2
      if (htfIdx >= MIN_CANDLES_FOR_SCAN) {
        const htfBias = htfStructureBias(context.htfCandles, htfIdx)
        htfAligned = (side === 'long' && htfBias.bias === 'bullish') || (side === 'short' && htfBias.bias === 'bearish')
        htfOpposed = (side === 'long' && htfBias.bias === 'bearish' && htfBias.confidence > 0.7) ||
                     (side === 'short' && htfBias.bias === 'bullish' && htfBias.confidence > 0.7)
      }
    }

    // 2. P/D filter
    const pivots = findPivots(candles, idx, 5, tol)
    const highs = pivots.filter(p => p.kind === 'high')
    const lows = pivots.filter(p => p.kind === 'low')
    if (highs.length === 0 || lows.length === 0) return null
    const swingHigh = Math.max(...highs.slice(-3).map(p => p.price))
    const swingLow = Math.min(...lows.slice(-3).map(p => p.price))
    const currentPrice = candles[idx]!.c
    const pd = premiumDiscount(swingHigh, swingLow, currentPrice)
    if ((side === 'long' && pd === 'premium') || (side === 'short' && pd === 'discount')) return null

    // 2b. OTE
    let inOTE = false
    if (SMC_ICT_OTE_FILTER) {
      if (side === 'long' && lows.length > 0) {
        const ote = oteZone(Math.min(...lows.slice(-3).map(p => p.price)), recentBreak.level)
        if (ote) inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
      } else if (side === 'short' && highs.length > 0) {
        const ote = oteZone(Math.max(...highs.slice(-3).map(p => p.price)), recentBreak.level)
        if (ote) inOTE = currentPrice >= ote.bottom && currentPrice <= ote.top
      }
    }

    // 3. Zones (+ Breaker + Inversion)
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones: KeyZone[] = [...(side === 'long' ? demandZones : supplyZones)]
    if (SMC_ICT_BREAKER_BLOCK_ENABLED) {
      for (const bb of detectBreakerBlocks(candles, idx)) {
        if (bb.type === (side === 'long' ? 'demand' : 'supply'))
          rawZones.push({ type: bb.type, top: bb.top, bottom: bb.bottom, strength: 0.85, origin: 'breaker-block', createdAtIdx: bb.index })
      }
    }
    if (SMC_ICT_INVERSION_FVG_ENABLED) {
      for (const inv of detectInversionFVGs(candles, idx, tol)) {
        if (inv.type === (side === 'long' ? 'demand' : 'supply'))
          rawZones.push({ type: inv.type, top: inv.top, bottom: inv.bottom, strength: 0.75, origin: 'inversion-fvg', createdAtIdx: inv.index })
      }
    }
    const zones = rawZones.filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE)
    if (zones.length === 0) return null

    // 4. Zone proximity
    const candle = candles[idx]!
    let bestZoneIdx = -1
    let proximity = { atZone: false, wickTouch: false, nearZone: false, throughZone: false }
    for (let i = 0; i < zones.length; i++) {
      if (zones[i]!.strength < SMC_MIN_ZONE_STRENGTH) continue
      const prox = isAtZone(candle, zones[i]!, atrVal)
      if (prox.atZone) { bestZoneIdx = i; proximity = prox; break }
    }
    if (bestZoneIdx === -1) return null
    const bestZone = zones[bestZoneIdx]!
    const atBreakerBlock = bestZone.origin === 'breaker-block'
    const atInversionFVG = bestZone.origin === 'inversion-fvg'

    // 5. Bounce detection
    let isBounce = false
    let bounceQuality: 'displacement' | 'wick' | 'sweep' = 'wick'
    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)

    if (side === 'long') {
      const we = candle.l <= bestZone.top + tol, ca = candle.c > bestZone.top - tol, bc = candle.c > candle.o
      if (we && ca && hasDisplacement && bc) { isBounce = true; bounceQuality = 'displacement' }
      else if (proximity.throughZone && ca) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sw?.direction === 'bullish') { isBounce = true; bounceQuality = 'sweep' }
        } else { isBounce = true; bounceQuality = 'sweep' }
      }
      else if (we && ca) { isBounce = true }
      else if (proximity.wickTouch && bc) { isBounce = true }
    } else {
      const we = candle.h >= bestZone.bottom - tol, cb = candle.c < bestZone.bottom + tol, bc = candle.c < candle.o
      if (we && cb && hasDisplacement && bc) { isBounce = true; bounceQuality = 'displacement' }
      else if (proximity.throughZone && cb) {
        if (SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 })
          if (sw?.direction === 'bearish') { isBounce = true; bounceQuality = 'sweep' }
        } else { isBounce = true; bounceQuality = 'sweep' }
      }
      else if (we && cb) { isBounce = true }
      else if (proximity.wickTouch && bc) { isBounce = true }
    }
    if (!isBounce) return null

    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    const adxVal = adx(candles, idx)
    if (!isNaN(adxVal) && adxVal < 18) return null

    // 6. Confidence
    let confidence = 0.65
    if (recentBreak.kind === 'choch') confidence += 0.10
    if (bounceQuality === 'displacement') confidence += 0.12
    else if (bounceQuality === 'sweep') confidence += 0.10
    else confidence += 0.05
    const directionalBody = (side === 'long' && candle.c > candle.o) || (side === 'short' && candle.c < candle.o)
    if (directionalBody) confidence += 0.05
    if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) confidence += 0.05
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS
    if (htfOpposed) confidence -= 0.06
    if (inOTE) confidence += SMC_ICT_OTE_BONUS
    if (atBreakerBlock) confidence += SMC_ICT_BREAKER_BLOCK_BONUS
    if (atInversionFVG) confidence += SMC_ICT_INVERSION_FVG_BONUS
    if (bestZone.strength > 0.6) confidence += 0.05
    if (bestZone.strength > 0.8) confidence += 0.05
    if (!isNaN(adxVal) && adxVal > 30) confidence += 0.08
    else if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 2.0) confidence += 0.08
    else if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    const vsaSignals = detectVSA(candles, idx)
    if (vsaSignals.some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY
    }

    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime)
    if (confidence < MIN_CONFIDENCE) return null

    // 7. SL/TP
    const entry = candle.c
    const slBuffer = atrVal * STRUCTURE_STOP_ATR_BUFFER
    const sl = side === 'long' ? bestZone.bottom - slBuffer : bestZone.top + slBuffer
    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)

    // Liquidity pool confidence
    const finalTp1 = tp1
    const pools = findLiquidityPools(candles, idx, { tolerance: tol })
    if (pools.length > 0) {
      const op = side === 'long' ? pools.filter(p => p.type === 'bsl' && p.level > entry) : pools.filter(p => p.type === 'ssl' && p.level < entry)
      if (op.length > 0) {
        const nearest = side === 'long' ? op.reduce((a, b) => a.level < b.level ? a : b) : op.reduce((a, b) => a.level > b.level ? a : b)
        if (Math.abs(tp1 - entry) > 0 && Math.abs(nearest.level - entry) <= Math.abs(tp1 - entry)) confidence += SMC_ICT_LIQUIDITY_POOL_TP_BONUS
      }
    }

    const riskAmt = Math.abs(entry - sl)
    if (riskAmt / entry > MAX_TRADE_SL_PCT) return null
    if (riskAmt <= 0 || Math.abs(finalTp1 - entry) / riskAmt < SMC_MIN_RR) return null

    // 8. Dedup
    const dedupKey = `${coin}|${interval}`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    return {
      type: 'smc-sd', side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry, slPrice: sl, tpPrice: finalTp1,
      confluenceGrade: 'B', confluenceCount: 3,
      patternData: {
        breakKind: recentBreak.kind, breakDirection: recentBreak.direction, breakLevel: recentBreak.level,
        premiumDiscount: pd, zoneOrigin: bestZone.origin,
        zoneTop: bestZone.top, zoneBottom: bestZone.bottom, zoneStrength: bestZone.strength,
        throughZone: proximity.throughZone, regime, tp2Price: tp2, atrAtEntry: atrVal,
        htfAligned, inOTE, bounceQuality, hasDisplacement, atBreakerBlock, atInversionFVG, killzoneName,
      },
    }
  }

  minCandles(): number { return MIN_CANDLES_FOR_SCAN }

  clearState(): void {
    lastSignalBar.clear()
    htfPOIs.clear()
  }
}
