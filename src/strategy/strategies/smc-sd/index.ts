/**
 * SMC+S&D Zone Bounce Strategy — ICT Multi-TF Drill-Down v5.
 *
 * 4-MODE ROUTING (Full ICT Model):
 *   4h  → scan4hPOI(): detect BOS/CHoCH, register HTF POIs
 *   15m → scan15mConfirm(): detect CHoCH at POI, register confirmed POI (NO signal)
 *   5m  → scan5mMicroEntry(): enter at confirmed POI via FVG/displacement (SIGNAL)
 *   1h  → scan1hSameTF(): existing same-TF analysis (SIGNAL)
 *
 * ICT Model: 4h = WHERE, 15m = WHEN (confirmed), 5m = HOW (tightest entry).
 * Result: 5m SL (~0.1-0.5%) + 4h TP (~5-20%) → R:R 10:1 to 40:1.
 *
 * Pure function — zero I/O. Module-level state for POI pools + dedup.
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
  SMC_BREAK_LOOKBACK, SMC_DEDUP_BARS, SMC_SD_SKIP_INTERVALS,
  SMC_PRICE_TOLERANCE_ATR_MULT, SMC_MIN_BODY_RATIO, SMC_MIN_ZONE_STRENGTH,
  SMC_MIN_RR, MAX_TRADE_SL_PCT, ZONE_MAX_AGE, MIN_CONFIDENCE,
  STRUCTURE_STOP_ATR_BUFFER, MIN_CANDLES_FOR_SCAN,
  SMC_ICT_HTF_ALIGNMENT, SMC_ICT_OTE_FILTER, SMC_ICT_DISPLACEMENT_BODY_ATR,
  SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH, SMC_ICT_HTF_ALIGNED_BONUS,
  SMC_ICT_OTE_BONUS, SMC_ICT_LIQUIDITY_POOL_TP_BONUS,
  SMC_ICT_KILLZONE_ENABLED, SMC_ICT_KILLZONES, SMC_ICT_KILLZONE_PENALTY,
  SMC_ICT_BREAKER_BLOCK_ENABLED, SMC_ICT_BREAKER_BLOCK_BONUS,
  SMC_ICT_INVERSION_FVG_ENABLED, SMC_ICT_INVERSION_FVG_BONUS,
  SMC_HTF_POI_TTL_MS, SMC_LTF_CHOCH_LOOKBACK, SMC_LTF_ENTRY_FVG_LOOKBACK,
  SMC_DRILLDOWN_MIN_RR, SMC_DRILLDOWN_SL_ATR_BUFFER,
  SMC_DRILLDOWN_CONFIDENCE_BASE, SMC_DRILLDOWN_CHOCH_BONUS, SMC_DRILLDOWN_MAX_POIS,
  SMC_CONFIRMED_POI_TTL_MS, SMC_CONFIRMED_POI_MAX,
  SMC_5M_FVG_LOOKBACK, SMC_5M_SL_ATR_BUFFER, SMC_5M_MIN_RR, SMC_5M_CONFIDENCE_BASE,
} from '../../../config.js'

// ── Module-level state ──────────────────────────────────────────────────────

const lastSignalBar = new Map<string, number>()

// ── HTF POI Pool (4h writes) ────────────────────────────────────────────────

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

const htfPOIs = new Map<string, HtfPOI[]>()

// ── Confirmed POI Pool (15m writes, 5m reads) ──────────────────────────────

interface ConfirmedPOI extends HtfPOI {
  confirmedAtMs: number
  ltfBreakKind: 'bos' | 'choch'
}

const confirmedPOIs = new Map<string, ConfirmedPOI[]>()

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

    // ── 4-MODE ROUTING ──────────────────────────────────────────────
    if (interval === '4h') return this.scan4hPOI(coin, candles, idx)
    if (interval === '15m') return this.scan15mConfirm(coin, candles, idx)
    if (interval === '5m') return this.scan5mMicroEntry(coin, candles, idx, context)
    // 1h (and others): same-TF analysis
    return this.scan1hSameTF(coin, interval, candles, idx, context)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4h MODE: POI REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  private scan4hPOI(coin: string, candles: Candle[], idx: number): null {
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks.filter(b => idx - b.index <= SMC_BREAK_LOOKBACK).at(-1)
    if (!recentBreak) return null

    const direction = recentBreak.direction
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones: KeyZone[] = [...(direction === 'bullish' ? demandZones : supplyZones)]

    if (SMC_ICT_BREAKER_BLOCK_ENABLED) {
      for (const bb of detectBreakerBlocks(candles, idx)) {
        if (bb.type === (direction === 'bullish' ? 'demand' : 'supply'))
          rawZones.push({ type: bb.type, top: bb.top, bottom: bb.bottom, strength: 0.85, origin: 'breaker-block', createdAtIdx: bb.index })
      }
    }
    if (SMC_ICT_INVERSION_FVG_ENABLED) {
      for (const inv of detectInversionFVGs(candles, idx, tol)) {
        if (inv.type === (direction === 'bullish' ? 'demand' : 'supply'))
          rawZones.push({ type: inv.type, top: inv.top, bottom: inv.bottom, strength: 0.75, origin: 'inversion-fvg', createdAtIdx: inv.index })
      }
    }

    const zones = rawZones
      .filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE && z.strength >= SMC_MIN_ZONE_STRENGTH)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, SMC_DRILLDOWN_MAX_POIS)
    if (zones.length === 0) return null

    const nowMs = candles[idx]!.t
    const newPOIs: HtfPOI[] = zones.map(z => ({
      coin, direction, breakKind: recentBreak.kind,
      zoneTop: z.top, zoneBottom: z.bottom, zoneOrigin: z.origin,
      strength: z.strength, createdAtMs: nowMs, breakLevel: recentBreak.level,
    }))

    const existing = (htfPOIs.get(coin) ?? []).filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
    htfPOIs.set(coin, [...existing, ...newPOIs].slice(-SMC_DRILLDOWN_MAX_POIS))
    return null
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m MODE: CONFIRMATION ONLY (CHoCH at POI → mark confirmed, NO signal)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan15mConfirm(coin: string, candles: Candle[], idx: number): null {
    const pois = htfPOIs.get(coin)
    if (!pois || pois.length === 0) return null

    const candle = candles[idx]!
    const nowMs = candle.t
    const activePOIs = pois.filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
    if (activePOIs.length === 0) { htfPOIs.set(coin, []); return null }
    htfPOIs.set(coin, activePOIs)

    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // Check each POI for proximity + CHoCH confirmation
    for (const poi of activePOIs) {
      const poiZone: KeyZone = {
        type: poi.direction === 'bullish' ? 'demand' : 'supply',
        top: poi.zoneTop, bottom: poi.zoneBottom,
        strength: poi.strength, origin: poi.zoneOrigin, createdAtIdx: 0,
      }
      const prox = isAtZone(candle, poiZone, atrVal)
      if (!prox.atZone) continue

      // Look for 15m CHoCH/BOS confirming HTF direction
      const confirmBreak = findConfirmingBreak(candles, idx, SMC_LTF_CHOCH_LOOKBACK, poi.direction, tol)
      if (!confirmBreak) continue

      // Already confirmed? Skip duplicate
      const existing = confirmedPOIs.get(coin) ?? []
      const alreadyConfirmed = existing.some(cp =>
        Math.abs(cp.zoneTop - poi.zoneTop) < atrVal * 0.1 &&
        Math.abs(cp.zoneBottom - poi.zoneBottom) < atrVal * 0.1
      )
      if (alreadyConfirmed) continue

      // Register confirmed POI
      const confirmed: ConfirmedPOI = {
        ...poi,
        confirmedAtMs: nowMs,
        ltfBreakKind: confirmBreak.kind,
      }
      const pool = existing.filter(p => nowMs - p.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS)
      confirmedPOIs.set(coin, [...pool, confirmed].slice(-SMC_CONFIRMED_POI_MAX))
    }

    return null  // 15m never emits signals — confirmation only
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5m MODE: MICRO-ENTRY at confirmed POI (tightest SL + widest TP)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan5mMicroEntry(coin: string, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    const pool = confirmedPOIs.get(coin)
    if (!pool || pool.length === 0) return null

    const candle = candles[idx]!
    const nowMs = candle.t

    // Expire stale confirmed POIs
    const active = pool.filter(p => nowMs - p.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS)
    if (active.length === 0) { confirmedPOIs.set(coin, []); return null }
    confirmedPOIs.set(coin, active)

    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // ── A. Find confirmed POI at current 5m price ─────────────────────
    let bestPOI: ConfirmedPOI | null = null
    for (const poi of active) {
      const poiZone: KeyZone = {
        type: poi.direction === 'bullish' ? 'demand' : 'supply',
        top: poi.zoneTop, bottom: poi.zoneBottom,
        strength: poi.strength, origin: poi.zoneOrigin, createdAtIdx: 0,
      }
      const prox = isAtZone(candle, poiZone, atrVal)
      if (prox.atZone) { bestPOI = poi; break }
    }
    if (!bestPOI) return null

    const side: SignalSide = bestPOI.direction === 'bullish' ? 'long' : 'short'

    // ── B. 5m ENTRY: FVG or displacement bounce ──────────────────────
    let isBounce = false
    let bounceQuality: 'fvg' | 'displacement' | 'wick' = 'wick'
    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)

    // Priority 1: 5m FVG entry (ICT: enter at the FVG formed after structure shift)
    for (let i = Math.max(2, idx - SMC_5M_FVG_LOOKBACK); i <= idx; i++) {
      const fvg = detectFVG(candles, i, tol)
      if (!fvg) continue
      if ((side === 'long' && fvg.bullish) || (side === 'short' && !fvg.bullish)) {
        if (side === 'long' && candle.l <= fvg.top && candle.c > fvg.bottom) {
          isBounce = true; bounceQuality = 'fvg'; break
        }
        if (side === 'short' && candle.h >= fvg.bottom && candle.c < fvg.top) {
          isBounce = true; bounceQuality = 'fvg'; break
        }
      }
    }

    // 5m: FVG only. Wick/displacement entries are noise on 5m micro-TF.
    // ICT: after 15m CHoCH, the first 5m FVG IS the entry — nothing else.
    if (!isBounce) return null

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    // ── C. MIXED-TF SL/TP ─────────────────────────────────────────────
    const entry = candle.c

    // SL: 5m swing structure (ultra-tight)
    const pivots5m = findPivots(candles, idx, 3, tol)
    let sl: number
    if (side === 'long') {
      const lows = pivots5m.filter(p => p.kind === 'low' && p.index <= idx).slice(-3)
      sl = (lows.length > 0 ? Math.min(...lows.map(p => p.price)) : candle.l) - atrVal * SMC_5M_SL_ATR_BUFFER
    } else {
      const highs = pivots5m.filter(p => p.kind === 'high' && p.index <= idx).slice(-3)
      sl = (highs.length > 0 ? Math.max(...highs.map(p => p.price)) : candle.h) + atrVal * SMC_5M_SL_ATR_BUFFER
    }

    // TP: 4h structure targets — context.htfCandles = 1h (HTF_MAP['5m']='1h')
    // For 4h targets, compute from POI break level + risk-based fallback
    const risk = Math.abs(entry - sl)
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) return null

    const dir = side === 'long' ? 1 : -1
    let tp1: number
    let tp2: number

    // Try to get 4h targets via context (may be 1h candles from HTF_MAP)
    if (context?.htfCandles && context.htfCandles.length >= MIN_CANDLES_FOR_SCAN) {
      const htfIdx = context.htfCandles.length - 2
      const targets = computeStructureTargets(context.htfCandles, htfIdx, entry, sl, side)
      tp1 = targets.tp1
      tp2 = targets.tp2
      // Ensure minimum R:R
      const minTp = entry + dir * risk * SMC_5M_MIN_RR
      if ((side === 'long' && tp1 < minTp) || (side === 'short' && tp1 > minTp)) tp1 = minTp
    } else {
      tp1 = entry + dir * risk * SMC_5M_MIN_RR
      tp2 = entry + dir * risk * (SMC_5M_MIN_RR + 3)
    }

    // R:R check
    const reward = Math.abs(tp1 - entry)
    if (reward / risk < SMC_5M_MIN_RR) return null

    // ── D. CONFIDENCE ──────────────────────────────────────────────────
    let confidence = SMC_5M_CONFIDENCE_BASE

    // Entry quality
    if (bounceQuality === 'fvg') confidence += 0.10
    else if (bounceQuality === 'displacement') confidence += 0.12
    else confidence += 0.03

    // 15m confirmation was CHoCH (stronger)
    if (bestPOI.ltfBreakKind === 'choch') confidence += SMC_DRILLDOWN_CHOCH_BONUS

    // 4h break was CHoCH (strongest HTF signal)
    if (bestPOI.breakKind === 'choch') confidence += 0.05

    // POI strength
    if (bestPOI.strength > 0.7) confidence += 0.05

    // Killzone (MANDATORY for 5m — too noisy outside sessions)
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      if (!kz.inKillzone) return null  // Hard reject 5m outside killzones
      confidence += kz.bonus
    }

    // Volume + VSA
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    const vsaSignals = detectVSA(candles, idx)
    if (vsaSignals.some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    // Regime
    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime)

    if (confidence < MIN_CONFIDENCE) return null

    // ── E. DEDUP + SIGNAL ──────────────────────────────────────────────
    const dedupKey = `${coin}|5m`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    // Remove consumed confirmed POI
    const remaining = (confirmedPOIs.get(coin) ?? []).filter(p => p !== bestPOI)
    confirmedPOIs.set(coin, remaining)

    return {
      type: 'smc-sd', side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry, slPrice: sl, tpPrice: tp1,
      confluenceGrade: 'A', confluenceCount: 5,
      patternData: {
        drillDown: true, microEntry: true,
        htfDirection: bestPOI.direction, htfBreakKind: bestPOI.breakKind,
        htfBreakLevel: bestPOI.breakLevel, htfZoneOrigin: bestPOI.zoneOrigin,
        htfZoneTop: bestPOI.zoneTop, htfZoneBottom: bestPOI.zoneBottom,
        ltfConfirmKind: bestPOI.ltfBreakKind, entryType: bounceQuality,
        regime, tp2Price: tp2, atrAtEntry: atrVal, killzoneName,
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1h MODE: SAME-TF ANALYSIS (existing ICT v3, unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan1hSameTF(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext): Signal | null {
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks.filter(b => idx - b.index <= SMC_BREAK_LOOKBACK).at(-1)
    if (!recentBreak) return null
    const side: SignalSide = recentBreak.direction === 'bullish' ? 'long' : 'short'

    // HTF alignment (soft)
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

    // P/D filter
    const pivots = findPivots(candles, idx, 5, tol)
    const highs = pivots.filter(p => p.kind === 'high'), lows = pivots.filter(p => p.kind === 'low')
    if (highs.length === 0 || lows.length === 0) return null
    const pd = premiumDiscount(Math.max(...highs.slice(-3).map(p => p.price)), Math.min(...lows.slice(-3).map(p => p.price)), candles[idx]!.c)
    if ((side === 'long' && pd === 'premium') || (side === 'short' && pd === 'discount')) return null

    // OTE
    let inOTE = false
    if (SMC_ICT_OTE_FILTER) {
      if (side === 'long' && lows.length > 0) {
        const ote = oteZone(Math.min(...lows.slice(-3).map(p => p.price)), recentBreak.level)
        if (ote) inOTE = candles[idx]!.c >= ote.bottom && candles[idx]!.c <= ote.top
      } else if (side === 'short' && highs.length > 0) {
        const ote = oteZone(Math.max(...highs.slice(-3).map(p => p.price)), recentBreak.level)
        if (ote) inOTE = candles[idx]!.c >= ote.bottom && candles[idx]!.c <= ote.top
      }
    }

    // Zones (+ Breaker + Inversion)
    const { demandZones, supplyZones } = compileKeyZones(candles, idx, tol)
    const rawZones: KeyZone[] = [...(side === 'long' ? demandZones : supplyZones)]
    if (SMC_ICT_BREAKER_BLOCK_ENABLED) for (const bb of detectBreakerBlocks(candles, idx)) {
      if (bb.type === (side === 'long' ? 'demand' : 'supply')) rawZones.push({ type: bb.type, top: bb.top, bottom: bb.bottom, strength: 0.85, origin: 'breaker-block', createdAtIdx: bb.index })
    }
    if (SMC_ICT_INVERSION_FVG_ENABLED) for (const inv of detectInversionFVGs(candles, idx, tol)) {
      if (inv.type === (side === 'long' ? 'demand' : 'supply')) rawZones.push({ type: inv.type, top: inv.top, bottom: inv.bottom, strength: 0.75, origin: 'inversion-fvg', createdAtIdx: inv.index })
    }
    const zones = rawZones.filter(z => idx - z.createdAtIdx <= ZONE_MAX_AGE)
    if (zones.length === 0) return null

    // Zone proximity
    const candle = candles[idx]!
    let bestZone: KeyZone | null = null
    let proximity = { atZone: false, wickTouch: false, nearZone: false, throughZone: false }
    for (const z of zones) {
      if (z.strength < SMC_MIN_ZONE_STRENGTH) continue
      const prox = isAtZone(candle, z, atrVal)
      if (prox.atZone) { bestZone = z; proximity = prox; break }
    }
    if (!bestZone) return null

    // Bounce detection
    let isBounce = false
    let bounceQuality: 'displacement' | 'wick' | 'sweep' = 'wick'
    const hasDisplacement = isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)
    if (side === 'long') {
      const we = candle.l <= bestZone.top + tol, ca = candle.c > bestZone.top - tol, bc = candle.c > candle.o
      if (we && ca && hasDisplacement && bc) { isBounce = true; bounceQuality = 'displacement' }
      else if (proximity.throughZone && ca) { if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) { isBounce = true; bounceQuality = 'sweep' } else { const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 }); if (sw?.direction === 'bullish') { isBounce = true; bounceQuality = 'sweep' } } }
      else if (we && ca) isBounce = true
      else if (proximity.wickTouch && bc) isBounce = true
    } else {
      const we = candle.h >= bestZone.bottom - tol, cb = candle.c < bestZone.bottom + tol, bc = candle.c < candle.o
      if (we && cb && hasDisplacement && bc) { isBounce = true; bounceQuality = 'displacement' }
      else if (proximity.throughZone && cb) { if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) { isBounce = true; bounceQuality = 'sweep' } else { const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 }); if (sw?.direction === 'bearish') { isBounce = true; bounceQuality = 'sweep' } } }
      else if (we && cb) isBounce = true
      else if (proximity.wickTouch && bc) isBounce = true
    }
    if (!isBounce) return null

    if (candle.h - candle.l > 0 && Math.abs(candle.c - candle.o) / (candle.h - candle.l) < SMC_MIN_BODY_RATIO) return null
    const adxVal = adx(candles, idx)
    if (!isNaN(adxVal) && adxVal < 18) return null

    // Confidence
    let confidence = 0.65
    if (recentBreak.kind === 'choch') confidence += 0.10
    if (bounceQuality === 'displacement') confidence += 0.12
    else if (bounceQuality === 'sweep') confidence += 0.10
    else confidence += 0.05
    if ((side === 'long' && candle.c > candle.o) || (side === 'short' && candle.c < candle.o)) confidence += 0.05
    if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) confidence += 0.05
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS
    if (htfOpposed) confidence -= 0.06
    if (inOTE) confidence += SMC_ICT_OTE_BONUS
    if (bestZone.origin === 'breaker-block') confidence += SMC_ICT_BREAKER_BLOCK_BONUS
    if (bestZone.origin === 'inversion-fvg') confidence += SMC_ICT_INVERSION_FVG_BONUS
    if (bestZone.strength > 0.6) confidence += 0.05
    if (bestZone.strength > 0.8) confidence += 0.05
    if (!isNaN(adxVal) && adxVal > 30) confidence += 0.08
    else if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 2.0) confidence += 0.08
    else if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    if (detectVSA(candles, idx).some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) { const kz = getKillzoneBonus(candle.t); killzoneName = kz.name; confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY }
    confidence = applyRegimeModifier(confidence, side, detectRegime(candles, idx))
    if (confidence < MIN_CONFIDENCE) return null

    // SL/TP
    const entry = candle.c
    const sl = side === 'long' ? bestZone.bottom - atrVal * STRUCTURE_STOP_ATR_BUFFER : bestZone.top + atrVal * STRUCTURE_STOP_ATR_BUFFER
    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)
    const pools = findLiquidityPools(candles, idx, { tolerance: tol })
    if (pools.length > 0) {
      const op = side === 'long' ? pools.filter(p => p.type === 'bsl' && p.level > entry) : pools.filter(p => p.type === 'ssl' && p.level < entry)
      if (op.length > 0) { const n = side === 'long' ? op.reduce((a, b) => a.level < b.level ? a : b) : op.reduce((a, b) => a.level > b.level ? a : b); if (Math.abs(tp1 - entry) > 0 && Math.abs(n.level - entry) <= Math.abs(tp1 - entry)) confidence += SMC_ICT_LIQUIDITY_POOL_TP_BONUS }
    }
    const riskAmt = Math.abs(entry - sl)
    if (riskAmt / entry > MAX_TRADE_SL_PCT || riskAmt <= 0 || Math.abs(tp1 - entry) / riskAmt < SMC_MIN_RR) return null

    const dedupKey = `${coin}|${interval}`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS) return null
    lastSignalBar.set(dedupKey, idx)

    return {
      type: 'smc-sd', side, confidence: Math.min(confidence, 1),
      entryPrice: entry, slPrice: sl, tpPrice: tp1,
      confluenceGrade: 'B', confluenceCount: 3,
      patternData: {
        breakKind: recentBreak.kind, breakDirection: recentBreak.direction, breakLevel: recentBreak.level,
        premiumDiscount: pd, zoneOrigin: bestZone.origin, zoneTop: bestZone.top, zoneBottom: bestZone.bottom,
        zoneStrength: bestZone.strength, throughZone: proximity.throughZone,
        regime: detectRegime(candles, idx), tp2Price: tp2, atrAtEntry: atrVal,
        htfAligned, inOTE, bounceQuality, hasDisplacement,
        atBreakerBlock: bestZone.origin === 'breaker-block',
        atInversionFVG: bestZone.origin === 'inversion-fvg', killzoneName,
      },
    }
  }

  minCandles(): number { return MIN_CANDLES_FOR_SCAN }

  clearState(): void {
    lastSignalBar.clear()
    htfPOIs.clear()
    confirmedPOIs.clear()
  }
}
