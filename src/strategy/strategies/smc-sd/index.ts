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
import type { StrategyParams } from '../../../backtest/types.js'
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
  detectSessionRange,
  detectJudasSwing,
  oteZone,
  detectFVG,
} from '../../../indicators/smc.js'
import { isAtZone } from '../../shared/zone-utils.js'
import { computeStructureTargets } from '../../shared/zone-utils.js'
import { applyRegimeModifier } from '../../shared/regime.js'
import { detectRegime, atr, adx, volumeRatio } from '../../../indicators/core.js'
import { detectVSA } from '../../../indicators/vsa.js'
import {
  SMC_BREAK_LOOKBACK, SMC_DEDUP_BARS, SMC_SD_SKIP_INTERVALS, SMC_COIN_BLACKLIST,
  SMC_PRICE_TOLERANCE_ATR_MULT, SMC_MIN_BODY_RATIO, SMC_MIN_ZONE_STRENGTH,
  SMC_MIN_RR, MAX_TRADE_SL_PCT, ZONE_MAX_AGE, MIN_CONFIDENCE,
  STRUCTURE_STOP_ATR_BUFFER, MIN_CANDLES_FOR_SCAN,
  SMC_ICT_HTF_ALIGNMENT, SMC_ICT_OTE_FILTER, SMC_ICT_DISPLACEMENT_BODY_ATR,
  SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH, SMC_ICT_HTF_ALIGNED_BONUS, SMC_ICT_HTF_COUNTER_PENALTY,
  SMC_ICT_OTE_BONUS, SMC_ICT_LIQUIDITY_POOL_TP_BONUS,
  SMC_ICT_KILLZONE_ENABLED, SMC_ICT_KILLZONES, SMC_ICT_KILLZONE_PENALTY,
  SMC_ICT_BREAKER_BLOCK_ENABLED, SMC_ICT_BREAKER_BLOCK_BONUS,
  SMC_ICT_INVERSION_FVG_ENABLED, SMC_ICT_INVERSION_FVG_BONUS,
  SMC_HTF_POI_TTL_MS, SMC_LTF_CHOCH_LOOKBACK, SMC_LTF_ENTRY_FVG_LOOKBACK,
  SMC_DRILLDOWN_MIN_RR, SMC_DRILLDOWN_SL_ATR_BUFFER,
  SMC_DRILLDOWN_CONFIDENCE_BASE, SMC_DRILLDOWN_CHOCH_BONUS, SMC_DRILLDOWN_MAX_POIS,
  SMC_CONFIRMED_POI_TTL_MS, SMC_CONFIRMED_POI_MAX,
  SMC_4H_SWING_ENABLED, SMC_4H_SWING_SL_ATR_BUFFER, SMC_4H_SWING_MIN_RR, SMC_4H_SWING_CONFIDENCE_BASE,
  SMC_15M_SCALP_ENABLED, SMC_15M_SCALP_SL_ATR_BUFFER, SMC_15M_SCALP_MIN_RR, SMC_15M_SCALP_CONFIDENCE_BASE,
  SMC_5M_FVG_LOOKBACK, SMC_5M_SL_ATR_BUFFER, SMC_5M_MIN_RR, SMC_5M_CONFIDENCE_BASE, SMC_5M_MIN_SL_PCT, SMC_5M_REQUIRE_15M_CHOCH,
  SMC_AMD_ENABLED, SMC_AMD_ACCUMULATION_START_UTC, SMC_AMD_ACCUMULATION_END_UTC,
  SMC_AMD_MANIPULATION_WINDOWS, SMC_AMD_MIN_RR, SMC_AMD_CONFIDENCE_BASE,
  SMC_AMD_JUDAS_BONUS, SMC_AMD_SL_ATR_BUFFER, SMC_AMD_MIN_RANGE_BARS,
  SMC_LIQUIDATION_VOLUME_RATIO, SMC_LIQUIDATION_WICK_ATR_MULT, SMC_LIQUIDATION_CONFIDENCE_MULT,
  SMC_WEEKEND_VOLUME_RATIO_THRESHOLD, SMC_WEEKEND_CONFIDENCE_MULT,
  SL_WICK_ATR_MULT,
  SMC_1H_BOS_PENALTY, SMC_1H_MIN_VOLUME_RATIO, SMC_1H_MIN_ADX,
} from '../../../config.js'

// ── Module-level state ──────────────────────────────────────────────────────

/** Zone-aware dedup state: track last signal's zone so we allow re-entry
 * once price has exited and returned to the zone (new test = new opportunity). */
interface DedupState {
  lastBar: number
  zoneTop: number | null
  zoneBottom: number | null
}

const lastSignalState = new Map<string, DedupState>()

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

// ── Drilldown cascade diagnostics ──────────────────────────────────────────

export interface DrilldownDiagnostics {
  // 4H stage
  scan4h_calls: number
  scan4h_no_break: number
  scan4h_no_zones: number
  scan4h_pois_registered: number
  scan4h_swing_signals: number
  // 15m stage
  scan15m_calls: number
  scan15m_no_htf_pois: number
  scan15m_pois_expired: number
  scan15m_pois_checked: number
  scan15m_not_at_zone: number
  scan15m_no_confirm_break: number
  scan15m_already_confirmed: number
  scan15m_confirmed: number
  scan15m_scalp_signals: number
  // 5m stage
  scan5m_calls: number
  scan5m_no_confirmed_pois: number
  scan5m_pois_expired: number
  scan5m_not_at_zone: number
  scan5m_no_fvg: number
  scan5m_body_rejected: number
  scan5m_sl_too_wide: number
  scan5m_sl_too_tight: number
  scan5m_require_choch_fail: number
  scan5m_rr_too_low: number
  scan5m_confidence_too_low: number
  scan5m_signals: number
}

const diag: DrilldownDiagnostics = {
  scan4h_calls: 0, scan4h_no_break: 0, scan4h_no_zones: 0,
  scan4h_pois_registered: 0, scan4h_swing_signals: 0,
  scan15m_calls: 0, scan15m_no_htf_pois: 0, scan15m_pois_expired: 0,
  scan15m_pois_checked: 0, scan15m_not_at_zone: 0,
  scan15m_no_confirm_break: 0, scan15m_already_confirmed: 0,
  scan15m_confirmed: 0, scan15m_scalp_signals: 0,
  scan5m_calls: 0, scan5m_no_confirmed_pois: 0, scan5m_pois_expired: 0,
  scan5m_not_at_zone: 0, scan5m_no_fvg: 0,
  scan5m_body_rejected: 0, scan5m_sl_too_wide: 0, scan5m_sl_too_tight: 0,
  scan5m_require_choch_fail: 0, scan5m_rr_too_low: 0,
  scan5m_confidence_too_low: 0, scan5m_signals: 0,
}

export function getDrilldownDiagnostics(): DrilldownDiagnostics {
  return { ...diag }
}

export function resetDrilldownDiagnostics(): void {
  for (const key of Object.keys(diag) as (keyof DrilldownDiagnostics)[]) {
    diag[key] = 0
  }
}

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

// ── Liquidation cascade detector ────────────────────────────────────────────

/**
 * Returns true if the current candle looks like a perp liquidation cascade:
 * abnormally large wick (>N×ATR) combined with extreme volume spike (>N×avg).
 * These are forced-selling artifacts, NOT genuine ICT price action.
 * Pure function — zero I/O.
 */
function isLiquidationCascade(candles: Candle[], idx: number, atrVal: number): boolean {
  const candle = candles[idx]!
  const wickSize = candle.h - candle.l
  const volRatio = volumeRatio(candles, idx, 20)
  return (
    wickSize > atrVal * SMC_LIQUIDATION_WICK_ATR_MULT &&
    !isNaN(volRatio) &&
    volRatio > SMC_LIQUIDATION_VOLUME_RATIO
  )
}

// ── Weekend low-volume multiplier ────────────────────────────────────────────

/**
 * Returns a confidence multiplier for weekend low-volume sessions.
 * Crypto Fri-Sun volume = 30-50% of weekday → structure breaks more easily faked.
 * Returns 1.0 on weekdays or when volume is normal.
 * Pure function — zero I/O.
 */
function getWeekendMultiplier(timestampMs: number, candles: Candle[], idx: number): number {
  const day = new Date(timestampMs).getUTCDay()  // 0=Sun, 6=Sat
  if (day !== 0 && day !== 6) return 1.0
  const volRatio = volumeRatio(candles, idx, 20)
  if (isNaN(volRatio) || volRatio >= SMC_WEEKEND_VOLUME_RATIO_THRESHOLD) return 1.0
  return SMC_WEEKEND_CONFIDENCE_MULT
}

// ── Zone-aware dedup helpers ─────────────────────────────────────────────────

/**
 * Check zone-aware dedup. Allows re-entry when price has exited the last
 * signal's zone (new zone test = new opportunity), otherwise time-gate applies.
 */
function isDuplicateSignal(
  key: string,
  idx: number,
  currentPrice: number,
  newZoneTop: number | null,
  newZoneBottom: number | null,
): boolean {
  const state = lastSignalState.get(key)
  if (!state) return false

  const timePassed = idx - state.lastBar

  // Zone overlap check: do the new signal's zone and the last signal's zone share price range?
  // Overlapping zones = same area being tested again → apply full dedup.
  // Non-overlapping zones = genuinely different level → apply half dedup (shorter cooldown).
  //
  // Bug avoided: do NOT compare currentPrice against old zone top/bottom.
  // currentPrice is AT the new zone, so it will appear "outside" any zone at a different price
  // level, incorrectly bypassing dedup. Compare ZONES to ZONES instead.
  if (
    state.zoneTop !== null && state.zoneBottom !== null &&
    newZoneTop !== null && newZoneBottom !== null
  ) {
    const zonesOverlap = newZoneTop > state.zoneBottom && newZoneBottom < state.zoneTop
    const dedupBars = zonesOverlap ? SMC_DEDUP_BARS : Math.ceil(SMC_DEDUP_BARS / 2)
    return timePassed <= dedupBars
  }

  // No zone info → standard time-based dedup
  return timePassed <= SMC_DEDUP_BARS
}

function recordSignal(key: string, idx: number, zoneTop: number | null, zoneBottom: number | null): void {
  lastSignalState.set(key, { lastBar: idx, zoneTop, zoneBottom })
}

// ── Strategy ────────────────────────────────────────────────────────────────

export class SmcSdStrategy implements IStrategy {
  readonly id = 'smc-sd'
  readonly name = 'SMC + S&D Zone Bounce (ICT)'
  readonly patternTypes: ReadonlyArray<PatternType> = ['smc-sd']

  scan(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext, strategyParams?: StrategyParams): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null
    if (SMC_SD_SKIP_INTERVALS.includes(interval)) return null
    if (SMC_COIN_BLACKLIST.includes(coin)) return null

    // ── 4-MODE ROUTING ──────────────────────────────────────────────
    if (interval === '4h') return this.scan4hPOI(coin, candles, idx, strategyParams)
    if (interval === '15m') return this.scan15mConfirm(coin, candles, idx, strategyParams)
    if (interval === '5m') return this.scan5mMicroEntry(coin, candles, idx, context, strategyParams)
    // 1h (and others): same-TF analysis
    return this.scan1hSameTF(coin, interval, candles, idx, context, strategyParams)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4h MODE: POI REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  private scan4hPOI(coin: string, candles: Candle[], idx: number, strategyParams?: StrategyParams): Signal | null {
    diag.scan4h_calls++
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    const breaks = detectStructureBreaks(candles, idx, { tolerance: tol })
    const recentBreak = breaks.filter(b => idx - b.index <= SMC_BREAK_LOOKBACK).at(-1)
    if (!recentBreak) { diag.scan4h_no_break++; return null }

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
    if (zones.length === 0) { diag.scan4h_no_zones++; return null }

    const nowMs = candles[idx]!.t
    const newPOIs: HtfPOI[] = zones.map(z => ({
      coin, direction, breakKind: recentBreak.kind,
      zoneTop: z.top, zoneBottom: z.bottom, zoneOrigin: z.origin,
      strength: z.strength, createdAtMs: nowMs, breakLevel: recentBreak.level,
    }))

    const existing = (htfPOIs.get(coin) ?? []).filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
    htfPOIs.set(coin, [...existing, ...newPOIs].slice(-SMC_DRILLDOWN_MAX_POIS))
    diag.scan4h_pois_registered += newPOIs.length

    // ── 4h SWING SIGNAL: emit if price is currently AT a zone ─────────────
    if (SMC_4H_SWING_ENABLED) {
      const candle = candles[idx]!
      const side: SignalSide = direction === 'bullish' ? 'long' : 'short'
      for (const z of zones) {
        const zoneKey: KeyZone = { type: direction === 'bullish' ? 'demand' : 'supply', top: z.top, bottom: z.bottom, strength: z.strength, origin: z.origin, createdAtIdx: z.createdAtIdx }
        const prox = isAtZone(candle, zoneKey, atrVal)
        if (!prox.atZone) continue

        // Bounce: close must have entered zone from correct direction
        let isBounce = false
        if (side === 'long') {
          const touchedZone = candle.l <= z.top + tol
          const closedAbove = candle.c > z.top - tol
          if (touchedZone && closedAbove) isBounce = true
        } else {
          const touchedZone = candle.h >= z.bottom - tol
          const closedBelow = candle.c < z.bottom + tol
          if (touchedZone && closedBelow) isBounce = true
        }
        if (!isBounce) continue

        // Body quality: reject doji on 4h
        const bodySize = Math.abs(candle.c - candle.o)
        const candleRange = candle.h - candle.l
        if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) continue

        // SL: zone boundary + wide ATR buffer (swing — absorbs 4h wick noise)
        const entry = candle.c
        const slMult = (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT
        const sl = side === 'long'
          ? z.bottom - atrVal * SMC_4H_SWING_SL_ATR_BUFFER * slMult
          : z.top + atrVal * SMC_4H_SWING_SL_ATR_BUFFER * slMult
        const risk = Math.abs(entry - sl)
        if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) continue

        // TP: 4h structure swing targets
        const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)
        if (Math.abs(tp1 - entry) / risk < SMC_4H_SWING_MIN_RR) continue

        // Confidence
        let confidence = strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_4H_SWING_CONFIDENCE_BASE
        if (recentBreak.kind === 'choch') confidence += 0.10
        if (z.origin === 'breaker-block') confidence += SMC_ICT_BREAKER_BLOCK_BONUS
        if (z.origin === 'inversion-fvg') confidence += SMC_ICT_INVERSION_FVG_BONUS
        if (z.strength > 0.6) confidence += 0.05
        if (z.strength > 0.8) confidence += 0.05
        if (isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)) confidence += 0.08

        const kz = SMC_ICT_KILLZONE_ENABLED ? getKillzoneBonus(candle.t) : { inKillzone: false, bonus: 0, name: 'off-session' }
        confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY

        const volRatioVal = volumeRatio(candles, idx, 20)
        if (!isNaN(volRatioVal) && volRatioVal > 1.5) confidence += 0.05

        const regime = detectRegime(candles, idx)
        confidence = applyRegimeModifier(confidence, side, regime, strategyParams)

        if (isLiquidationCascade(candles, idx, atrVal)) confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT
        confidence *= getWeekendMultiplier(candle.t, candles, idx)

        if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) continue

        // Dedup (zone-aware)
        const dedupKey = `${coin}|4h`
        if (isDuplicateSignal(dedupKey, idx, entry, z.top, z.bottom)) continue
        recordSignal(dedupKey, idx, z.top, z.bottom)

        diag.scan4h_swing_signals++
        return {
          type: 'smc-sd', side,
          confidence: Math.min(confidence, 1),
          entryPrice: entry, slPrice: sl, tpPrice: tp1,
          confluenceGrade: 'A', confluenceCount: 4,
          patternData: {
            tradeStyle: 'swing',
            breakKind: recentBreak.kind, breakDirection: direction,
            zoneOrigin: z.origin, zoneTop: z.top, zoneBottom: z.bottom, zoneStrength: z.strength,
            regime, tp2Price: tp2, atrAtEntry: atrVal, killzoneName: kz.name,
          },
        }
      }
    }

    return null
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m MODE: POI CONFIRMATION + AMD (Judas Swing → SIGNAL)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan15mConfirm(coin: string, candles: Candle[], idx: number, strategyParams?: StrategyParams): Signal | null {
    diag.scan15m_calls++
    const candle = candles[idx]!
    const nowMs = candle.t
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT

    // ── Part 1: POI Confirmation (for 5m micro-entry) ──────────────────
    const pois = htfPOIs.get(coin)
    if (!pois || pois.length === 0) {
      diag.scan15m_no_htf_pois++
    } else {
      const activePOIs = pois.filter(p => nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS)
      diag.scan15m_pois_expired += pois.length - activePOIs.length
      htfPOIs.set(coin, activePOIs)

      for (const poi of activePOIs) {
        diag.scan15m_pois_checked++
        const poiZone: KeyZone = {
          type: poi.direction === 'bullish' ? 'demand' : 'supply',
          top: poi.zoneTop, bottom: poi.zoneBottom,
          strength: poi.strength, origin: poi.zoneOrigin, createdAtIdx: 0,
        }
        const prox = isAtZone(candle, poiZone, atrVal)
        if (!prox.atZone) { diag.scan15m_not_at_zone++; continue }

        const confirmBreak = findConfirmingBreak(candles, idx, SMC_LTF_CHOCH_LOOKBACK, poi.direction, tol)
        if (!confirmBreak) { diag.scan15m_no_confirm_break++; continue }

        const existing = confirmedPOIs.get(coin) ?? []
        const alreadyConfirmed = existing.some(cp =>
          Math.abs(cp.zoneTop - poi.zoneTop) < atrVal * 0.1 &&
          Math.abs(cp.zoneBottom - poi.zoneBottom) < atrVal * 0.1
        )
        if (alreadyConfirmed) { diag.scan15m_already_confirmed++; continue }

        const pool = existing.filter(p => nowMs - p.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS)
        const fresh: ConfirmedPOI = { ...poi, confirmedAtMs: nowMs, ltfBreakKind: confirmBreak.kind }
        confirmedPOIs.set(coin, [...pool, fresh].slice(-SMC_CONFIRMED_POI_MAX))
        diag.scan15m_confirmed++

        // ── 15m SCALP SIGNAL: emit on fresh confirmation ─────────────────
        // 4h POI + 15m CHoCH = dual-TF confirmation → emit scalp signal now.
        // TP uses 15m structure targets (realistic for scalp, not 4h range).
        if (SMC_15M_SCALP_ENABLED) {
          const scalpSignal = this.emit15mScalpSignal(coin, candles, idx, fresh, atrVal, tol, strategyParams)
          if (scalpSignal) { diag.scan15m_scalp_signals++; return scalpSignal }
        }
      }
    }

    // ── Part 2: AMD (Power of Three) — Judas Swing detection ───────────
    if (!SMC_AMD_ENABLED) return null

    // Check if current time is within a manipulation window
    const hourUTC = new Date(nowMs).getUTCHours()
    const activeWindow = SMC_AMD_MANIPULATION_WINDOWS.find(w =>
      w.start <= w.end ? (hourUTC >= w.start && hourUTC < w.end) : (hourUTC >= w.start || hourUTC < w.end)
    )
    if (!activeWindow) return null

    // Detect accumulation range (Asia session)
    const range = detectSessionRange(candles, idx, SMC_AMD_ACCUMULATION_START_UTC, SMC_AMD_ACCUMULATION_END_UTC)
    if (!range || range.barCount < SMC_AMD_MIN_RANGE_BARS) return null

    // Detect Judas Swing (fake breakout beyond accumulation range)
    const judas = detectJudasSwing(candles, idx, range, tol)
    if (!judas) return null

    // Must be at or after the reversal point
    if (idx < judas.reversalIdx) return null

    const side: SignalSide = judas.direction === 'bullish' ? 'long' : 'short'

    // Require confirming CHoCH/BOS after Judas reversal
    const confirmBreak = findConfirmingBreak(candles, idx, SMC_LTF_CHOCH_LOOKBACK, judas.direction, tol)
    if (!confirmBreak) return null

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null

    // Directional body required
    if (side === 'long' && candle.c <= candle.o) return null
    if (side === 'short' && candle.c >= candle.o) return null

    // SL: beyond Judas sweep wick + ATR buffer
    const entry = candle.c
    const slMult = (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT
    const sl = side === 'long'
      ? judas.sweepLevel - atrVal * SMC_AMD_SL_ATR_BUFFER * slMult
      : judas.sweepLevel + atrVal * SMC_AMD_SL_ATR_BUFFER * slMult

    // TP: opposite side of accumulation range + extension
    const risk = Math.abs(entry - sl)
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) return null

    const dir = side === 'long' ? 1 : -1
    const rangeSize = range.high - range.low
    // TP1: opposite range boundary + 1 range extension (AMD distribution target)
    let tp1 = side === 'long' ? range.high + rangeSize : range.low - rangeSize
    // Floor: min R:R
    const minTp = entry + dir * risk * SMC_AMD_MIN_RR
    if ((side === 'long' && tp1 < minTp) || (side === 'short' && tp1 > minTp)) tp1 = minTp

    const reward = Math.abs(tp1 - entry)
    if (reward / risk < SMC_AMD_MIN_RR) return null

    // Confidence
    let confidence = strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_AMD_CONFIDENCE_BASE
    confidence += SMC_AMD_JUDAS_BONUS
    if (confirmBreak.kind === 'choch') confidence += SMC_DRILLDOWN_CHOCH_BONUS
    if (isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)) confidence += 0.08

    // Killzone bonus (we're already in a manipulation window, so always in killzone)
    const kz = getKillzoneBonus(nowMs)
    if (kz.inKillzone) confidence += kz.bonus

    // Volume + VSA
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    if (detectVSA(candles, idx).some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams)
    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) return null

    // Dedup
    const dedupKey = `${coin}|15m-amd`
    const lastBar = lastSignalBar.get(dedupKey)
    if (lastBar !== undefined && idx - lastBar <= SMC_DEDUP_BARS * 3) return null  // wider dedup for AMD
    lastSignalBar.set(dedupKey, idx)

    return {
      type: 'smc-sd', side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry, slPrice: sl, tpPrice: tp1,
      confluenceGrade: 'A', confluenceCount: 5,
      patternData: {
        amd: true, judasDirection: judas.direction,
        sweepLevel: judas.sweepLevel, rangeHigh: judas.rangeHigh, rangeLow: judas.rangeLow,
        manipulationWindow: activeWindow.name,
        ltfConfirmKind: confirmBreak.kind,
        regime, tp2Price: tp1 + dir * risk * 2, atrAtEntry: atrVal,
        killzoneName: kz.name,
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m SCALP SIGNAL: emit on fresh 4h POI + 15m CHoCH confirmation
  // ═══════════════════════════════════════════════════════════════════════════

  private emit15mScalpSignal(
    coin: string, candles: Candle[], idx: number,
    poi: ConfirmedPOI, atrVal: number, tol: number,
    strategyParams?: StrategyParams,
  ): Signal | null {
    const candle = candles[idx]!
    const side: SignalSide = poi.direction === 'bullish' ? 'long' : 'short'
    const entry = candle.c

    // Body quality: directional close required (CHoCH candle must commit to direction)
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) return null
    if (side === 'long' && candle.c <= candle.o) return null
    if (side === 'short' && candle.c >= candle.o) return null

    // SL: 15m swing structure + ATR buffer
    const pivots = findPivots(candles, idx, 3, tol)
    const slMult = (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT
    let sl: number
    if (side === 'long') {
      const lows = pivots.filter(p => p.kind === 'low' && p.index <= idx).slice(-3)
      sl = (lows.length > 0 ? Math.min(...lows.map(p => p.price)) : candle.l) - atrVal * SMC_15M_SCALP_SL_ATR_BUFFER * slMult
    } else {
      const highs = pivots.filter(p => p.kind === 'high' && p.index <= idx).slice(-3)
      sl = (highs.length > 0 ? Math.max(...highs.map(p => p.price)) : candle.h) + atrVal * SMC_15M_SCALP_SL_ATR_BUFFER * slMult
    }
    const risk = Math.abs(entry - sl)
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) return null

    // TP: 15m structure targets (scalp — NOT 4h range which is too distant)
    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)
    if (Math.abs(tp1 - entry) / risk < SMC_15M_SCALP_MIN_RR) return null

    // Confidence
    let confidence = strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_15M_SCALP_CONFIDENCE_BASE
    if (poi.ltfBreakKind === 'choch') confidence += SMC_DRILLDOWN_CHOCH_BONUS  // 15m CHoCH > BOS
    if (poi.breakKind === 'choch') confidence += 0.05                           // 4h CHoCH > BOS
    if (poi.strength > 0.7) confidence += 0.05
    if (isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)) confidence += 0.08

    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY
    }

    const volRatioVal = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatioVal) && volRatioVal > 1.5) confidence += 0.05
    if (detectVSA(candles, idx).some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams)

    if (isLiquidationCascade(candles, idx, atrVal)) confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT
    confidence *= getWeekendMultiplier(candle.t, candles, idx)

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) return null

    // Dedup (zone-aware, separate key from POI-confirmation path)
    const dedupKey = `${coin}|15m-scalp`
    if (isDuplicateSignal(dedupKey, idx, entry, poi.zoneTop, poi.zoneBottom)) return null
    recordSignal(dedupKey, idx, poi.zoneTop, poi.zoneBottom)

    return {
      type: 'smc-sd', side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry, slPrice: sl, tpPrice: tp1,
      confluenceGrade: 'A', confluenceCount: 4,
      patternData: {
        tradeStyle: 'scalp',
        drillDown: true,
        htfDirection: poi.direction, htfBreakKind: poi.breakKind,
        htfZoneTop: poi.zoneTop, htfZoneBottom: poi.zoneBottom,
        ltfConfirmKind: poi.ltfBreakKind,
        regime, tp2Price: tp2, atrAtEntry: atrVal, killzoneName,
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5m MODE: MICRO-ENTRY at confirmed POI (tightest SL + widest TP)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan5mMicroEntry(coin: string, candles: Candle[], idx: number, context?: StrategyContext, strategyParams?: StrategyParams): Signal | null {
    diag.scan5m_calls++
    const pool = confirmedPOIs.get(coin)
    if (!pool || pool.length === 0) { diag.scan5m_no_confirmed_pois++; return null }

    const candle = candles[idx]!
    const nowMs = candle.t

    // Expire stale confirmed POIs
    const active = pool.filter(p => nowMs - p.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS)
    if (active.length === 0) { diag.scan5m_pois_expired++; confirmedPOIs.set(coin, []); return null }
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
    if (!bestPOI) { diag.scan5m_not_at_zone++; return null }

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

    // Fallback: displacement candle as entry when no FVG found.
    // Wick-only entries remain blocked — too noisy on 5m micro-TF.
    if (!isBounce && hasDisplacement) { isBounce = true; bounceQuality = 'displacement' }
    if (!isBounce) { diag.scan5m_no_fvg++; return null }

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o)
    const candleRange = candle.h - candle.l
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) { diag.scan5m_body_rejected++; return null }

    // ── C. MIXED-TF SL/TP ─────────────────────────────────────────────
    const entry = candle.c

    // SL: 5m swing structure (ultra-tight)
    const pivots5m = findPivots(candles, idx, 3, tol)
    const slMult = (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT
    let sl: number
    if (side === 'long') {
      const lows = pivots5m.filter(p => p.kind === 'low' && p.index <= idx).slice(-3)
      sl = (lows.length > 0 ? Math.min(...lows.map(p => p.price)) : candle.l) - atrVal * SMC_5M_SL_ATR_BUFFER * slMult
    } else {
      const highs = pivots5m.filter(p => p.kind === 'high' && p.index <= idx).slice(-3)
      sl = (highs.length > 0 ? Math.max(...highs.map(p => p.price)) : candle.h) + atrVal * SMC_5M_SL_ATR_BUFFER * slMult
    }

    // TP: 4h structure targets — context.htfCandles = 1h (HTF_MAP['5m']='1h')
    // For 4h targets, compute from POI break level + risk-based fallback
    const risk = Math.abs(entry - sl)
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) { diag.scan5m_sl_too_wide++; return null }

    // P3-B: Minimum SL distance — ultra-tight stops are noise on 5m
    const slPct = risk / entry
    if (slPct < SMC_5M_MIN_SL_PCT) { diag.scan5m_sl_too_tight++; return null }

    // P3-B: Require 15m CHoCH confirmation (not just BOS)
    if (SMC_5M_REQUIRE_15M_CHOCH && bestPOI.ltfBreakKind !== 'choch') { diag.scan5m_require_choch_fail++; return null }

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
    if (reward / risk < SMC_5M_MIN_RR) { diag.scan5m_rr_too_low++; return null }

    // ── D. CONFIDENCE ──────────────────────────────────────────────────
    let confidence = strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_5M_CONFIDENCE_BASE

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

    // Killzone: bonus inside sessions, penalty outside (soft filter — not hard reject).
    // Hard reject blocked 54% of time (13/24 hours off-session) including valid setups.
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t)
      killzoneName = kz.name
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY
    }

    // Volume + VSA
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    const vsaSignals = detectVSA(candles, idx)
    if (vsaSignals.some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05

    // Regime
    const regime = detectRegime(candles, idx)
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams)

    // P2: liquidation cascade discount
    if (isLiquidationCascade(candles, idx, atrVal)) confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT

    // P2: weekend low-volume discount
    confidence *= getWeekendMultiplier(candle.t, candles, idx)

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) { diag.scan5m_confidence_too_low++; return null }

    // ── E. DEDUP + SIGNAL (zone-aware) ────────────────────────────────
    const dedupKey = `${coin}|5m`
    if (isDuplicateSignal(dedupKey, idx, entry, bestPOI.zoneTop, bestPOI.zoneBottom)) return null
    recordSignal(dedupKey, idx, bestPOI.zoneTop, bestPOI.zoneBottom)

    // Remove consumed confirmed POI
    const remaining = (confirmedPOIs.get(coin) ?? []).filter(p => p !== bestPOI)
    confirmedPOIs.set(coin, remaining)
    diag.scan5m_signals++

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

  private scan1hSameTF(coin: string, interval: CandleInterval, candles: Candle[], idx: number, context?: StrategyContext, strategyParams?: StrategyParams): Signal | null {
    const atrVal = atr(candles, idx, 14)
    if (isNaN(atrVal) || atrVal <= 0) return null
    const volRatio = volumeRatio(candles, idx, 20)
    if (!isNaN(volRatio) && volRatio < SMC_1H_MIN_VOLUME_RATIO) return null
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

    // Hard-block counter-trend BOS (CHoCH allowed — it IS a reversal signal)
    if (htfOpposed && recentBreak.kind === 'bos') return null

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
      else if (proximity.throughZone && ca && bc) { if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) { isBounce = true; bounceQuality = 'sweep' } else { const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 }); if (sw?.direction === 'bullish') { isBounce = true; bounceQuality = 'sweep' } } }
      else if (we && ca && bc) isBounce = true
      else if (proximity.wickTouch && bc) isBounce = true
    } else {
      const we = candle.h >= bestZone.bottom - tol, cb = candle.c < bestZone.bottom + tol, bc = candle.c < candle.o
      if (we && cb && hasDisplacement && bc) { isBounce = true; bounceQuality = 'displacement' }
      else if (proximity.throughZone && cb && bc) { if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) { isBounce = true; bounceQuality = 'sweep' } else { const sw = detectLiquiditySweep(candles, idx, { lookback: 20, wickRatio: 0.4 }); if (sw?.direction === 'bearish') { isBounce = true; bounceQuality = 'sweep' } } }
      else if (we && cb && bc) isBounce = true
      else if (proximity.wickTouch && bc) isBounce = true
    }
    if (!isBounce) return null

    if (candle.h - candle.l > 0 && Math.abs(candle.c - candle.o) / (candle.h - candle.l) < SMC_MIN_BODY_RATIO) return null
    const adxVal = adx(candles, idx)
    if (!isNaN(adxVal) && adxVal < SMC_1H_MIN_ADX) return null

    // Confidence (base tunable via SMC_1H_CONFIDENCE_BASE optimizer param)
    const _base1h = strategyParams?.SMC_1H_CONFIDENCE_BASE
    let confidence = (typeof _base1h === 'number' && isFinite(_base1h) && _base1h > 0) ? _base1h : 0.65
    if (recentBreak.kind === 'choch') confidence += 0.10
    if (recentBreak.kind === 'bos') confidence -= SMC_1H_BOS_PENALTY
    if (bounceQuality === 'displacement') confidence += 0.12
    else if (bounceQuality === 'sweep') confidence += 0.10
    else confidence += 0.05
    if ((side === 'long' && candle.c > candle.o) || (side === 'short' && candle.c < candle.o)) confidence += 0.05
    if ((side === 'long' && pd === 'discount') || (side === 'short' && pd === 'premium')) confidence += 0.05
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS
    if (htfOpposed) confidence -= SMC_ICT_HTF_COUNTER_PENALTY
    if (inOTE) confidence += SMC_ICT_OTE_BONUS
    if (bestZone.origin === 'breaker-block') confidence += SMC_ICT_BREAKER_BLOCK_BONUS
    if (bestZone.origin === 'inversion-fvg') confidence += SMC_ICT_INVERSION_FVG_BONUS
    if (bestZone.strength > 0.6) confidence += 0.05
    if (bestZone.strength > 0.8) confidence += 0.05
    if (!isNaN(adxVal) && adxVal > 30) confidence += 0.08
    else if (!isNaN(adxVal) && adxVal > 25) confidence += 0.05
    if (!isNaN(volRatio) && volRatio > 2.0) confidence += 0.08
    else if (!isNaN(volRatio) && volRatio > 1.5) confidence += 0.05
    if (detectVSA(candles, idx).some(s => s.direction === (side === 'long' ? 'bullish' : 'bearish'))) confidence += 0.05
    let killzoneName = 'off-session'
    if (SMC_ICT_KILLZONE_ENABLED) { const kz = getKillzoneBonus(candle.t); killzoneName = kz.name; confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY }
    confidence = applyRegimeModifier(confidence, side, detectRegime(candles, idx), strategyParams)

    // P2: liquidation cascade discount
    if (isLiquidationCascade(candles, idx, atrVal)) confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT

    // P2: weekend low-volume discount
    confidence *= getWeekendMultiplier(candle.t, candles, idx)

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) return null

    // SL/TP
    const entry = candle.c
    const slMult = (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT
    const sl = side === 'long' ? bestZone.bottom - atrVal * STRUCTURE_STOP_ATR_BUFFER * slMult : bestZone.top + atrVal * STRUCTURE_STOP_ATR_BUFFER * slMult
    const { tp1, tp2 } = computeStructureTargets(candles, idx, entry, sl, side)
    const pools = findLiquidityPools(candles, idx, { tolerance: tol })
    if (pools.length > 0) {
      const op = side === 'long' ? pools.filter(p => p.type === 'bsl' && p.level > entry) : pools.filter(p => p.type === 'ssl' && p.level < entry)
      if (op.length > 0) { const n = side === 'long' ? op.reduce((a, b) => a.level < b.level ? a : b) : op.reduce((a, b) => a.level > b.level ? a : b); if (Math.abs(tp1 - entry) > 0 && Math.abs(n.level - entry) <= Math.abs(tp1 - entry)) confidence += SMC_ICT_LIQUIDITY_POOL_TP_BONUS }
    }
    const riskAmt = Math.abs(entry - sl)
    if (riskAmt / entry > MAX_TRADE_SL_PCT || riskAmt <= 0 || Math.abs(tp1 - entry) / riskAmt < (strategyParams?.SMC_MIN_RR ?? SMC_MIN_RR)) return null

    // P2: zone-aware dedup
    const dedupKey = `${coin}|${interval}`
    if (isDuplicateSignal(dedupKey, idx, entry, bestZone.top, bestZone.bottom)) return null
    recordSignal(dedupKey, idx, bestZone.top, bestZone.bottom)

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
    lastSignalState.clear()
    htfPOIs.clear()
    confirmedPOIs.clear()
    // Note: do NOT reset diagnostics here — they accumulate across walk-forward windows
  }
}
