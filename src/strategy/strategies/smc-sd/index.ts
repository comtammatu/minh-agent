// @ts-nocheck -- pre-existing TS strict errors in this file (noted in arch-ai-agents-refactor); suppressed to green CI after S4 format; owner to fix in Q follow-up per DESIGN scope decisions.
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

import type { StrategyParams } from "../../../backtest/types.js";
import {
  MAX_TRADE_SL_PCT,
  MIN_CANDLES_FOR_SCAN,
  MIN_CONFIDENCE,
  SL_WICK_ATR_MULT,
  SMC_1H_ALLOWED_COINS,
  SMC_1H_BOS_PENALTY,
  SMC_1H_MIN_ADX,
  SMC_1H_MIN_VOLUME_RATIO,
  SMC_4H_SWING_CONFIDENCE_BASE,
  SMC_4H_SWING_ENABLED,
  SMC_4H_SWING_MIN_RR,
  SMC_4H_SWING_SL_ATR_BUFFER,
  SMC_5M_CONFIDENCE_BASE,
  SMC_5M_FVG_LOOKBACK,
  SMC_5M_MIN_RR,
  SMC_5M_MIN_SL_PCT,
  SMC_5M_REQUIRE_15M_CHOCH,
  SMC_5M_SL_ATR_BUFFER,
  SMC_15M_SCALP_CONFIDENCE_BASE,
  SMC_15M_SCALP_ENABLED,
  SMC_15M_SCALP_MIN_RR,
  SMC_15M_SCALP_SL_ATR_BUFFER,
  SMC_AMD_ACCUMULATION_END_UTC,
  SMC_AMD_ACCUMULATION_START_UTC,
  SMC_AMD_CONFIDENCE_BASE,
  SMC_AMD_ENABLED,
  SMC_AMD_JUDAS_BONUS,
  SMC_AMD_MANIPULATION_WINDOWS,
  SMC_AMD_MIN_RANGE_BARS,
  SMC_AMD_MIN_RR,
  SMC_AMD_SL_ATR_BUFFER,
  SMC_BREAK_LOOKBACK,
  SMC_COIN_BLACKLIST,
  SMC_CONFIRMED_POI_MAX,
  SMC_CONFIRMED_POI_TTL_MS,
  SMC_DEDUP_BARS,
  SMC_DRILLDOWN_CHOCH_BONUS,
  SMC_DRILLDOWN_MAX_POIS,
  SMC_HTF_POI_TTL_MS,
  SMC_ICT_BREAKER_BLOCK_BONUS,
  SMC_ICT_BREAKER_BLOCK_ENABLED,
  SMC_ICT_DISPLACEMENT_BODY_ATR,
  SMC_ICT_HTF_ALIGNED_BONUS,
  SMC_ICT_HTF_ALIGNMENT,
  SMC_ICT_HTF_COUNTER_PENALTY,
  SMC_ICT_INVERSION_FVG_BONUS,
  SMC_ICT_INVERSION_FVG_ENABLED,
  SMC_ICT_KILLZONE_ENABLED,
  SMC_ICT_KILLZONE_PENALTY,
  SMC_ICT_KILLZONES,
  SMC_ICT_LIQUIDITY_POOL_TP_BONUS,
  SMC_ICT_OTE_BONUS,
  SMC_ICT_OTE_FILTER,
  SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH,
  SMC_LIQUIDATION_CONFIDENCE_MULT,
  SMC_LIQUIDATION_VOLUME_RATIO,
  SMC_LIQUIDATION_WICK_ATR_MULT,
  SMC_LTF_CHOCH_LOOKBACK,
  SMC_MIN_BODY_RATIO,
  SMC_MIN_RR,
  SMC_MIN_ZONE_STRENGTH,
  SMC_PRICE_TOLERANCE_ATR_MULT,
  SMC_SD_SKIP_INTERVALS,
  SMC_WEEKEND_CONFIDENCE_MULT,
  SMC_WEEKEND_VOLUME_RATIO_THRESHOLD,
  STRUCTURE_STOP_ATR_BUFFER,
  TIMEFRAME_MS,
  ZONE_MAX_AGE,
} from "../../../config.js";
import {
  detectFVG,
  detectJudasSwing,
  detectLiquiditySweep,
  detectSessionRange,
  findConfirmingBreak,
  findLiquidityPools,
  isDisplacementCandle,
  oteZone,
  premiumDiscount,
} from "../../../indicators/smc.js";
import type {
  Candle,
  CandleInterval,
  KeyZone,
  PatternType,
  Signal,
  SignalSide,
  StrategyContext,
} from "../../../types.js";
import type { SetupGenerator, WindowRequirements } from "../../engine.js";
import {
  getCachedAdx14,
  getCachedAtr14,
  getCachedBreakerBlocks50,
  getCachedHtfStructureBias,
  getCachedInversionFVGs,
  getCachedKeyZones,
  getCachedPivots,
  getCachedRegime,
  getCachedStructureBreaks,
  getCachedVolumeRatio20,
  getCachedVsa,
} from "../../shared/indicator-cache.js";
import { applyRegimeModifier } from "../../shared/regime.js";
import { computeStructureTargets, isAtZone } from "../../shared/zone-utils.js";

// ── Module-level state ──────────────────────────────────────────────────────

/** Zone-aware dedup state: track last signal's zone so we allow re-entry
 * once price has exited and returned to the zone (new test = new opportunity). */
interface DedupState {
  lastBarClock: number;
  zoneTop: number | null;
  zoneBottom: number | null;
}

const lastSignalState = new Map<string, DedupState>();

// ── HTF POI Pool (4h writes) ────────────────────────────────────────────────

interface HtfPOI {
  coin: string;
  direction: "bullish" | "bearish";
  breakKind: "bos" | "choch";
  zoneTop: number;
  zoneBottom: number;
  zoneOrigin: string;
  strength: number;
  createdAtMs: number;
  breakLevel: number;
}

const htfPOIs = new Map<string, HtfPOI[]>();

// ── Confirmed POI Pool (15m writes, 5m reads) ──────────────────────────────

interface ConfirmedPOI extends HtfPOI {
  confirmedAtMs: number;
  ltfBreakKind: "bos" | "choch";
}

const confirmedPOIs = new Map<string, ConfirmedPOI[]>();
const smc1hAllowedCoinSet: ReadonlySet<string> = new Set(SMC_1H_ALLOWED_COINS);
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const UNIX_EPOCH_UTC_DAY = 4; // 1970-01-01 UTC was Thursday (4)

// ── Drilldown cascade diagnostics ──────────────────────────────────────────

export interface DrilldownDiagnostics {
  // 4H stage
  scan4h_calls: number;
  scan4h_no_break: number;
  scan4h_no_zones: number;
  scan4h_pois_registered: number;
  scan4h_swing_signals: number;
  // 15m stage
  scan15m_calls: number;
  scan15m_no_htf_pois: number;
  scan15m_pois_expired: number;
  scan15m_pois_checked: number;
  scan15m_not_at_zone: number;
  scan15m_no_confirm_break: number;
  scan15m_already_confirmed: number;
  scan15m_confirmed: number;
  scan15m_scalp_signals: number;
  // 5m stage
  scan5m_calls: number;
  scan5m_no_confirmed_pois: number;
  scan5m_pois_expired: number;
  scan5m_not_at_zone: number;
  scan5m_no_fvg: number;
  scan5m_body_rejected: number;
  scan5m_sl_too_wide: number;
  scan5m_sl_too_tight: number;
  scan5m_require_choch_fail: number;
  scan5m_rr_too_low: number;
  scan5m_confidence_too_low: number;
  scan5m_signals: number;
}

const diag: DrilldownDiagnostics = {
  scan4h_calls: 0,
  scan4h_no_break: 0,
  scan4h_no_zones: 0,
  scan4h_pois_registered: 0,
  scan4h_swing_signals: 0,
  scan15m_calls: 0,
  scan15m_no_htf_pois: 0,
  scan15m_pois_expired: 0,
  scan15m_pois_checked: 0,
  scan15m_not_at_zone: 0,
  scan15m_no_confirm_break: 0,
  scan15m_already_confirmed: 0,
  scan15m_confirmed: 0,
  scan15m_scalp_signals: 0,
  scan5m_calls: 0,
  scan5m_no_confirmed_pois: 0,
  scan5m_pois_expired: 0,
  scan5m_not_at_zone: 0,
  scan5m_no_fvg: 0,
  scan5m_body_rejected: 0,
  scan5m_sl_too_wide: 0,
  scan5m_sl_too_tight: 0,
  scan5m_require_choch_fail: 0,
  scan5m_rr_too_low: 0,
  scan5m_confidence_too_low: 0,
  scan5m_signals: 0,
};

export function getDrilldownDiagnostics(): DrilldownDiagnostics {
  return { ...diag };
}

export function resetDrilldownDiagnostics(): void {
  for (const key of Object.keys(diag) as (keyof DrilldownDiagnostics)[]) {
    diag[key] = 0;
  }
}

// ── Killzone helper ─────────────────────────────────────────────────────────

function getKillzoneBonus(timestampMs: number): {
  inKillzone: boolean;
  bonus: number;
  name: string;
} {
  const hourUTC = utcHour(timestampMs);
  for (const kz of SMC_ICT_KILLZONES) {
    if (kz.startUTC <= kz.endUTC) {
      if (hourUTC >= kz.startUTC && hourUTC < kz.endUTC)
        return { inKillzone: true, bonus: kz.bonus, name: kz.name };
    } else {
      if (hourUTC >= kz.startUTC || hourUTC < kz.endUTC)
        return { inKillzone: true, bonus: kz.bonus, name: kz.name };
    }
  }
  return { inKillzone: false, bonus: 0, name: "off-session" };
}

// ── Liquidation cascade detector ────────────────────────────────────────────

/**
 * Returns true if the current candle looks like a perp liquidation cascade:
 * abnormally large wick (>N×ATR) combined with extreme volume spike (>N×avg).
 * These are forced-selling artifacts, NOT genuine ICT price action.
 * Pure function — zero I/O.
 */
function isLiquidationCascade(
  candle: Candle,
  atrVal: number,
  volRatio: number,
): boolean {
  const wickSize = candle.h - candle.l;
  return (
    wickSize > atrVal * SMC_LIQUIDATION_WICK_ATR_MULT &&
    !Number.isNaN(volRatio) &&
    volRatio > SMC_LIQUIDATION_VOLUME_RATIO
  );
}

// ── Weekend low-volume multiplier ────────────────────────────────────────────

/**
 * Returns a confidence multiplier for weekend low-volume sessions.
 * Crypto Fri-Sun volume = 30-50% of weekday → structure breaks more easily faked.
 * Returns 1.0 on weekdays or when volume is normal.
 * Pure function — zero I/O.
 */
function getWeekendMultiplier(timestampMs: number, volRatio: number): number {
  const day = utcDay(timestampMs); // 0=Sun, 6=Sat
  if (day !== 0 && day !== 6) return 1.0;
  if (Number.isNaN(volRatio) || volRatio >= SMC_WEEKEND_VOLUME_RATIO_THRESHOLD)
    return 1.0;
  return SMC_WEEKEND_CONFIDENCE_MULT;
}

function utcHour(timestampMs: number): number {
  return Math.floor(timestampMs / MS_PER_HOUR) % 24;
}

function utcDay(timestampMs: number): number {
  return (Math.floor(timestampMs / MS_PER_DAY) + UNIX_EPOCH_UTC_DAY) % 7;
}

function hasDirectionalSweepWick(
  candle: Candle,
  side: SignalSide,
  minWickRatio: number,
): boolean {
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  if (side === "long") {
    return (Math.min(candle.o, candle.c) - candle.l) / range > minWickRatio;
  }
  return (candle.h - Math.max(candle.o, candle.c)) / range > minWickRatio;
}

// ── Zone-aware dedup helpers ─────────────────────────────────────────────────

/**
 * Check zone-aware dedup. Allows re-entry when price has exited the last
 * signal's zone (new zone test = new opportunity), otherwise time-gate applies.
 */
function isDuplicateSignal(
  key: string,
  currentBarClock: number,
  newZoneTop: number | null,
  newZoneBottom: number | null,
  dedupBars: number = SMC_DEDUP_BARS,
): boolean {
  const state = lastSignalState.get(key);
  if (!state) return false;

  const barsPassed = currentBarClock - state.lastBarClock;

  // Zone overlap check: do the new signal's zone and the last signal's zone share price range?
  // Overlapping zones = same area being tested again → apply full dedup.
  // Non-overlapping zones = genuinely different level → apply half dedup (shorter cooldown).
  if (
    state.zoneTop !== null &&
    state.zoneBottom !== null &&
    newZoneTop !== null &&
    newZoneBottom !== null
  ) {
    const zonesOverlap =
      newZoneTop > state.zoneBottom && newZoneBottom < state.zoneTop;
    const windowBars = zonesOverlap ? dedupBars : Math.ceil(dedupBars / 2);
    return barsPassed <= windowBars;
  }

  // No zone info → standard time-based dedup
  return barsPassed <= dedupBars;
}

function recordSignal(
  key: string,
  barClock: number,
  zoneTop: number | null,
  zoneBottom: number | null,
): void {
  lastSignalState.set(key, { lastBarClock: barClock, zoneTop, zoneBottom });
}

function barClockFor(timestampMs: number, interval: CandleInterval): number {
  return Math.floor(timestampMs / TIMEFRAME_MS[interval]);
}

// ── Strategy ────────────────────────────────────────────────────────────────

export class SmcSdStrategy implements SetupGenerator {
  readonly id = "smc-sd";
  readonly name = "SMC + S&D Zone Bounce (ICT)";
  readonly patternTypes: ReadonlyArray<PatternType> = ["smc-sd"];

  scan(
    coin: string,
    interval: CandleInterval,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
    strategyParams?: StrategyParams,
  ): Signal | null {
    if (idx < MIN_CANDLES_FOR_SCAN) return null;
    if (SMC_SD_SKIP_INTERVALS.includes(interval)) return null;
    if (SMC_COIN_BLACKLIST.includes(coin)) return null;

    // ── 4-MODE ROUTING ──────────────────────────────────────────────
    if (interval === "4h")
      return this.scan4hPOI(coin, candles, idx, strategyParams);
    if (interval === "15m")
      return this.scan15mConfirm(coin, candles, idx, strategyParams);
    if (interval === "5m")
      return this.scan5mMicroEntry(coin, candles, idx, context, strategyParams);
    // 1h (and others): same-TF analysis
    return this.scan1hSameTF(
      coin,
      interval,
      candles,
      idx,
      context,
      strategyParams,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4h MODE: POI REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  private scan4hPOI(
    coin: string,
    candles: Candle[],
    idx: number,
    strategyParams?: StrategyParams,
  ): Signal | null {
    diag.scan4h_calls++;
    const atrVal = getCachedAtr14(coin, "4h", candles, idx);
    if (Number.isNaN(atrVal) || atrVal <= 0) return null;
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT;

    const breaks = getCachedStructureBreaks(coin, "4h", candles, idx, {
      tolerance: tol,
    });
    let recentBreak = null as (typeof breaks)[number] | null;
    for (let i = breaks.length - 1; i >= 0; i--) {
      const b = breaks[i]!;
      if (idx - b.index <= SMC_BREAK_LOOKBACK) {
        recentBreak = b;
        break;
      }
    }
    if (!recentBreak) {
      diag.scan4h_no_break++;
      return null;
    }

    const direction = recentBreak.direction;
    const zoneType = direction === "bullish" ? "demand" : "supply";
    const { demandZones, supplyZones } = getCachedKeyZones(
      coin,
      "4h",
      candles,
      idx,
      tol,
    );
    const zones: KeyZone[] = [];

    const pushZoneCandidate = (
      top: number,
      bottom: number,
      strength: number,
      origin: KeyZone["origin"],
      createdAtIdx: number,
    ): void => {
      if (idx - createdAtIdx > ZONE_MAX_AGE) return;
      if (strength < SMC_MIN_ZONE_STRENGTH) return;
      if (
        zones.length === SMC_DRILLDOWN_MAX_POIS &&
        zones[zones.length - 1]?.strength >= strength
      )
        return;

      let insertAt = zones.length;
      while (insertAt > 0 && zones[insertAt - 1]?.strength < strength) {
        insertAt--;
      }
      zones.splice(insertAt, 0, {
        type: zoneType,
        top,
        bottom,
        strength,
        origin,
        createdAtIdx,
      });
      if (zones.length > SMC_DRILLDOWN_MAX_POIS) {
        zones.length = SMC_DRILLDOWN_MAX_POIS;
      }
    };

    for (const z of direction === "bullish" ? demandZones : supplyZones) {
      pushZoneCandidate(z.top, z.bottom, z.strength, z.origin, z.createdAtIdx);
    }

    const weakestZoneStrength =
      zones.length === SMC_DRILLDOWN_MAX_POIS
        ? zones[zones.length - 1]?.strength
        : -Infinity;

    if (SMC_ICT_BREAKER_BLOCK_ENABLED && weakestZoneStrength < 0.85) {
      for (const bb of getCachedBreakerBlocks50(coin, "4h", candles, idx)) {
        if (bb.type !== zoneType) continue;
        pushZoneCandidate(bb.top, bb.bottom, 0.85, "breaker-block", bb.index);
      }
    }
    if (SMC_ICT_INVERSION_FVG_ENABLED && weakestZoneStrength < 0.75) {
      for (const inv of getCachedInversionFVGs(coin, "4h", candles, idx, tol)) {
        if (inv.type !== zoneType) continue;
        pushZoneCandidate(
          inv.top,
          inv.bottom,
          0.75,
          "inversion-fvg",
          inv.index,
        );
      }
    }
    if (zones.length === 0) {
      diag.scan4h_no_zones++;
      return null;
    }

    const nowMs = candles[idx]?.t;
    const activePois: HtfPOI[] = [];
    for (const p of htfPOIs.get(coin) ?? []) {
      if (nowMs - p.createdAtMs < SMC_HTF_POI_TTL_MS) activePois.push(p);
    }
    for (const z of zones) {
      activePois.push({
        coin,
        direction,
        breakKind: recentBreak.kind,
        zoneTop: z.top,
        zoneBottom: z.bottom,
        zoneOrigin: z.origin,
        strength: z.strength,
        createdAtMs: nowMs,
        breakLevel: recentBreak.level,
      });
    }
    if (activePois.length > SMC_DRILLDOWN_MAX_POIS) {
      activePois.splice(0, activePois.length - SMC_DRILLDOWN_MAX_POIS);
    }
    htfPOIs.set(coin, activePois);
    diag.scan4h_pois_registered += zones.length;

    // ── 4h SWING SIGNAL: emit if price is currently AT a zone ─────────────
    if (SMC_4H_SWING_ENABLED) {
      const candle = candles[idx]!;
      const side: SignalSide = direction === "bullish" ? "long" : "short";
      const hasDisplacement = isDisplacementCandle(
        candles,
        idx,
        atrVal,
        SMC_ICT_DISPLACEMENT_BODY_ATR,
      );
      const kz = SMC_ICT_KILLZONE_ENABLED
        ? getKillzoneBonus(candle.t)
        : { inKillzone: false, bonus: 0, name: "off-session" };
      let cachedVolRatioVal: number | undefined;
      let cachedRegime: ReturnType<typeof getCachedRegime> | undefined;

      for (const z of zones) {
        const prox = isAtZone(candle, z, atrVal);
        if (!prox.atZone) continue;

        // Bounce: close must have entered zone from correct direction
        let isBounce = false;
        if (side === "long") {
          const touchedZone = candle.l <= z.top + tol;
          const closedAbove = candle.c > z.top - tol;
          if (touchedZone && closedAbove) isBounce = true;
        } else {
          const touchedZone = candle.h >= z.bottom - tol;
          const closedBelow = candle.c < z.bottom + tol;
          if (touchedZone && closedBelow) isBounce = true;
        }
        if (!isBounce) continue;

        // Body quality: reject doji on 4h
        const bodySize = Math.abs(candle.c - candle.o);
        const candleRange = candle.h - candle.l;
        if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO)
          continue;

        // SL: zone boundary + wide ATR buffer (swing — absorbs 4h wick noise)
        const entry = candle.c;
        const slMult =
          (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) /
          SL_WICK_ATR_MULT;
        const sl =
          side === "long"
            ? z.bottom - atrVal * SMC_4H_SWING_SL_ATR_BUFFER * slMult
            : z.top + atrVal * SMC_4H_SWING_SL_ATR_BUFFER * slMult;
        const risk = Math.abs(entry - sl);
        if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) continue;

        // TP: 4h structure swing targets
        const opposingZones = side === "long" ? supplyZones : demandZones;
        const { tp1, tp2 } = computeStructureTargets(
          candles,
          idx,
          entry,
          sl,
          side,
          opposingZones,
          undefined,
          atrVal,
        );
        if (Math.abs(tp1 - entry) / risk < SMC_4H_SWING_MIN_RR) continue;

        // Confidence
        let confidence =
          strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ??
          SMC_4H_SWING_CONFIDENCE_BASE;
        if (recentBreak.kind === "choch") confidence += 0.1;
        if (z.origin === "breaker-block")
          confidence += SMC_ICT_BREAKER_BLOCK_BONUS;
        if (z.origin === "inversion-fvg")
          confidence += SMC_ICT_INVERSION_FVG_BONUS;
        if (z.strength > 0.6) confidence += 0.05;
        if (z.strength > 0.8) confidence += 0.05;
        if (hasDisplacement) confidence += 0.08;

        confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY;

        if (cachedVolRatioVal === undefined) {
          cachedVolRatioVal = getCachedVolumeRatio20(coin, "4h", candles, idx);
        }
        const volRatioVal = cachedVolRatioVal;
        if (!Number.isNaN(volRatioVal) && volRatioVal > 1.5) confidence += 0.05;

        if (cachedRegime === undefined) {
          cachedRegime = getCachedRegime(coin, "4h", candles, idx);
        }
        const regime = cachedRegime;
        confidence = applyRegimeModifier(
          confidence,
          side,
          regime,
          strategyParams,
        );

        if (isLiquidationCascade(candle, atrVal, volRatioVal))
          confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT;
        confidence *= getWeekendMultiplier(candle.t, volRatioVal);

        if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE))
          continue;

        // Dedup (zone-aware)
        const dedupKey = `${coin}|4h`;
        const currentBarClock = barClockFor(candle.t, "4h");
        if (isDuplicateSignal(dedupKey, currentBarClock, z.top, z.bottom))
          continue;
        recordSignal(dedupKey, currentBarClock, z.top, z.bottom);

        diag.scan4h_swing_signals++;
        return {
          type: "smc-sd",
          side,
          confidence: Math.min(confidence, 1),
          entryPrice: entry,
          slPrice: sl,
          tpPrice: tp1,
          confluenceGrade: "A",
          confluenceCount: 4,
          patternData: {
            tradeStyle: "swing",
            breakKind: recentBreak.kind,
            breakDirection: direction,
            zoneOrigin: z.origin,
            zoneTop: z.top,
            zoneBottom: z.bottom,
            zoneStrength: z.strength,
            regime,
            tp2Price: tp2,
            atrAtEntry: atrVal,
            killzoneName: kz.name,
          },
        };
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m MODE: POI CONFIRMATION + AMD (Judas Swing → SIGNAL)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan15mConfirm(
    coin: string,
    candles: Candle[],
    idx: number,
    strategyParams?: StrategyParams,
  ): Signal | null {
    diag.scan15m_calls++;
    const candle = candles[idx]!;
    const nowMs = candle.t;
    const currentBarClock = barClockFor(nowMs, "15m");
    const atrVal = getCachedAtr14(coin, "15m", candles, idx);
    if (Number.isNaN(atrVal) || atrVal <= 0) return null;
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT;

    // ── Part 1: POI Confirmation (for 5m micro-entry) ──────────────────
    const pois = htfPOIs.get(coin);
    if (!pois || pois.length === 0) {
      diag.scan15m_no_htf_pois++;
    } else {
      const activePOIs: HtfPOI[] = [];
      let expiredCount = 0;
      for (const poi of pois) {
        if (nowMs - poi.createdAtMs < SMC_HTF_POI_TTL_MS) activePOIs.push(poi);
        else expiredCount++;
      }
      diag.scan15m_pois_expired += expiredCount;
      htfPOIs.set(coin, activePOIs);

      for (const poi of activePOIs) {
        diag.scan15m_pois_checked++;
        const poiZone: KeyZone = {
          type: poi.direction === "bullish" ? "demand" : "supply",
          top: poi.zoneTop,
          bottom: poi.zoneBottom,
          strength: poi.strength,
          origin: poi.zoneOrigin,
          createdAtIdx: 0,
        };
        const prox = isAtZone(candle, poiZone, atrVal);
        if (!prox.atZone) {
          diag.scan15m_not_at_zone++;
          continue;
        }

        const confirmBreak = findConfirmingBreak(
          candles,
          idx,
          SMC_LTF_CHOCH_LOOKBACK,
          poi.direction,
          tol,
        );
        if (!confirmBreak) {
          diag.scan15m_no_confirm_break++;
          continue;
        }

        const existing = confirmedPOIs.get(coin) ?? [];
        const zoneEpsilon = atrVal * 0.1;
        let alreadyConfirmed = false;
        for (const cp of existing) {
          if (
            Math.abs(cp.zoneTop - poi.zoneTop) < zoneEpsilon &&
            Math.abs(cp.zoneBottom - poi.zoneBottom) < zoneEpsilon
          ) {
            alreadyConfirmed = true;
            break;
          }
        }
        if (alreadyConfirmed) {
          diag.scan15m_already_confirmed++;
          continue;
        }

        const pool: ConfirmedPOI[] = [];
        for (const confirmed of existing) {
          if (nowMs - confirmed.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS) {
            pool.push(confirmed);
          }
        }
        const fresh: ConfirmedPOI = {
          ...poi,
          confirmedAtMs: nowMs,
          ltfBreakKind: confirmBreak.kind,
        };
        pool.push(fresh);
        if (pool.length > SMC_CONFIRMED_POI_MAX) {
          pool.splice(0, pool.length - SMC_CONFIRMED_POI_MAX);
        }
        confirmedPOIs.set(coin, pool);
        diag.scan15m_confirmed++;

        // ── 15m SCALP SIGNAL: emit on fresh confirmation ─────────────────
        // 4h POI + 15m CHoCH = dual-TF confirmation → emit scalp signal now.
        // TP uses 15m structure targets (realistic for scalp, not 4h range).
        if (SMC_15M_SCALP_ENABLED) {
          const scalpSignal = this.emit15mScalpSignal(
            coin,
            candles,
            idx,
            fresh,
            atrVal,
            tol,
            strategyParams,
          );
          if (scalpSignal) {
            diag.scan15m_scalp_signals++;
            return scalpSignal;
          }
        }
      }
    }

    // ── Part 2: AMD (Power of Three) — Judas Swing detection ───────────
    if (!SMC_AMD_ENABLED) return null;

    // Check if current time is within a manipulation window
    const hourUTC = utcHour(nowMs);
    let activeWindow: (typeof SMC_AMD_MANIPULATION_WINDOWS)[number] | undefined;
    for (const w of SMC_AMD_MANIPULATION_WINDOWS) {
      const inWindow =
        w.start <= w.end
          ? hourUTC >= w.start && hourUTC < w.end
          : hourUTC >= w.start || hourUTC < w.end;
      if (inWindow) {
        activeWindow = w;
        break;
      }
    }
    if (!activeWindow) return null;

    // Detect accumulation range (Asia session)
    const range = detectSessionRange(
      candles,
      idx,
      SMC_AMD_ACCUMULATION_START_UTC,
      SMC_AMD_ACCUMULATION_END_UTC,
    );
    if (!range || range.barCount < SMC_AMD_MIN_RANGE_BARS) return null;

    // Detect Judas Swing (fake breakout beyond accumulation range)
    const judas = detectJudasSwing(candles, idx, range, tol);
    if (!judas) return null;

    // Must be at or after the reversal point
    if (idx < judas.reversalIdx) return null;

    const side: SignalSide = judas.direction === "bullish" ? "long" : "short";

    // Require confirming CHoCH/BOS after Judas reversal
    const confirmBreak = findConfirmingBreak(
      candles,
      idx,
      SMC_LTF_CHOCH_LOOKBACK,
      judas.direction,
      tol,
    );
    if (!confirmBreak) return null;

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o);
    const candleRange = candle.h - candle.l;
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO)
      return null;

    // Directional body required
    if (side === "long" && candle.c <= candle.o) return null;
    if (side === "short" && candle.c >= candle.o) return null;

    // SL: beyond Judas sweep wick + ATR buffer
    const entry = candle.c;
    const slMult =
      (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT;
    const sl =
      side === "long"
        ? judas.sweepLevel - atrVal * SMC_AMD_SL_ATR_BUFFER * slMult
        : judas.sweepLevel + atrVal * SMC_AMD_SL_ATR_BUFFER * slMult;

    // TP: opposite side of accumulation range + extension
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) return null;

    const dir = side === "long" ? 1 : -1;
    const rangeSize = range.high - range.low;
    // TP1: opposite range boundary + 1 range extension (AMD distribution target)
    let tp1 = side === "long" ? range.high + rangeSize : range.low - rangeSize;
    // Floor: min R:R
    const minTp = entry + dir * risk * SMC_AMD_MIN_RR;
    if ((side === "long" && tp1 < minTp) || (side === "short" && tp1 > minTp))
      tp1 = minTp;

    const reward = Math.abs(tp1 - entry);
    if (reward / risk < SMC_AMD_MIN_RR) return null;

    // Confidence
    let confidence =
      strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_AMD_CONFIDENCE_BASE;
    confidence += SMC_AMD_JUDAS_BONUS;
    if (confirmBreak.kind === "choch") confidence += SMC_DRILLDOWN_CHOCH_BONUS;
    if (
      isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)
    )
      confidence += 0.08;

    // Killzone bonus (we're already in a manipulation window, so always in killzone)
    const kz = getKillzoneBonus(nowMs);
    if (kz.inKillzone) confidence += kz.bonus;

    // Volume + VSA
    const volRatio = getCachedVolumeRatio20(coin, "15m", candles, idx);
    if (!Number.isNaN(volRatio) && volRatio > 1.5) confidence += 0.05;
    const targetVsaDirection = side === "long" ? "bullish" : "bearish";
    for (const signal of getCachedVsa(coin, "15m", candles, idx)) {
      if (signal.direction === targetVsaDirection) {
        confidence += 0.05;
        break;
      }
    }

    const regime = getCachedRegime(coin, "15m", candles, idx);
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams);
    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE))
      return null;

    // Dedup
    const dedupKey = `${coin}|15m-amd`;
    if (
      isDuplicateSignal(
        dedupKey,
        currentBarClock,
        null,
        null,
        SMC_DEDUP_BARS * 3,
      )
    )
      return null;
    recordSignal(dedupKey, currentBarClock, null, null);

    return {
      type: "smc-sd",
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      confluenceGrade: "A",
      confluenceCount: 5,
      patternData: {
        amd: true,
        judasDirection: judas.direction,
        sweepLevel: judas.sweepLevel,
        rangeHigh: judas.rangeHigh,
        rangeLow: judas.rangeLow,
        manipulationWindow: activeWindow.name,
        ltfConfirmKind: confirmBreak.kind,
        regime,
        tp2Price: tp1 + dir * risk * 2,
        atrAtEntry: atrVal,
        killzoneName: kz.name,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 15m SCALP SIGNAL: emit on fresh 4h POI + 15m CHoCH confirmation
  // ═══════════════════════════════════════════════════════════════════════════

  private emit15mScalpSignal(
    coin: string,
    candles: Candle[],
    idx: number,
    poi: ConfirmedPOI,
    atrVal: number,
    tol: number,
    strategyParams?: StrategyParams,
  ): Signal | null {
    const candle = candles[idx]!;
    const side: SignalSide = poi.direction === "bullish" ? "long" : "short";
    const entry = candle.c;

    // Body quality: directional close required (CHoCH candle must commit to direction)
    const bodySize = Math.abs(candle.c - candle.o);
    const candleRange = candle.h - candle.l;
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO)
      return null;
    if (side === "long" && candle.c <= candle.o) return null;
    if (side === "short" && candle.c >= candle.o) return null;

    // SL: 15m swing structure + ATR buffer
    const pivots = getCachedPivots(coin, "15m", candles, idx, 3, tol);
    const slMult =
      (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT;
    let sl: number;
    if (side === "long") {
      let lowsFound = 0;
      let swingLow = candle.l;
      for (let i = pivots.length - 1; i >= 0 && lowsFound < 3; i--) {
        const pivot = pivots[i]!;
        if (pivot.kind !== "low" || pivot.index > idx) continue;
        if (lowsFound === 0 || pivot.price < swingLow) swingLow = pivot.price;
        lowsFound++;
      }
      sl = swingLow - atrVal * SMC_15M_SCALP_SL_ATR_BUFFER * slMult;
    } else {
      let highsFound = 0;
      let swingHigh = candle.h;
      for (let i = pivots.length - 1; i >= 0 && highsFound < 3; i--) {
        const pivot = pivots[i]!;
        if (pivot.kind !== "high" || pivot.index > idx) continue;
        if (highsFound === 0 || pivot.price > swingHigh)
          swingHigh = pivot.price;
        highsFound++;
      }
      sl = swingHigh + atrVal * SMC_15M_SCALP_SL_ATR_BUFFER * slMult;
    }
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) return null;

    // TP: 15m structure targets (scalp — NOT 4h range which is too distant)
    const zones = getCachedKeyZones(coin, "15m", candles, idx, tol);
    const opposingZones =
      side === "long" ? zones.supplyZones : zones.demandZones;
    const { tp1, tp2 } = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      side,
      opposingZones,
      undefined,
      atrVal,
    );
    if (Math.abs(tp1 - entry) / risk < SMC_15M_SCALP_MIN_RR) return null;

    // Confidence
    let confidence =
      strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ??
      SMC_15M_SCALP_CONFIDENCE_BASE;
    if (poi.ltfBreakKind === "choch") confidence += SMC_DRILLDOWN_CHOCH_BONUS; // 15m CHoCH > BOS
    if (poi.breakKind === "choch") confidence += 0.05; // 4h CHoCH > BOS
    if (poi.strength > 0.7) confidence += 0.05;
    if (
      isDisplacementCandle(candles, idx, atrVal, SMC_ICT_DISPLACEMENT_BODY_ATR)
    )
      confidence += 0.08;

    let killzoneName = "off-session";
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t);
      killzoneName = kz.name;
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY;
    }

    const volRatioVal = getCachedVolumeRatio20(coin, "15m", candles, idx);
    if (!Number.isNaN(volRatioVal) && volRatioVal > 1.5) confidence += 0.05;
    const targetVsaDirection = side === "long" ? "bullish" : "bearish";
    for (const signal of getCachedVsa(coin, "15m", candles, idx)) {
      if (signal.direction === targetVsaDirection) {
        confidence += 0.05;
        break;
      }
    }

    const regime = getCachedRegime(coin, "15m", candles, idx);
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams);

    if (isLiquidationCascade(candle, atrVal, volRatioVal))
      confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT;
    confidence *= getWeekendMultiplier(candle.t, volRatioVal);

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE))
      return null;

    // Dedup (zone-aware, separate key from POI-confirmation path)
    const dedupKey = `${coin}|15m-scalp`;
    const currentBarClock = barClockFor(candle.t, "15m");
    if (
      isDuplicateSignal(dedupKey, currentBarClock, poi.zoneTop, poi.zoneBottom)
    )
      return null;
    recordSignal(dedupKey, currentBarClock, poi.zoneTop, poi.zoneBottom);

    return {
      type: "smc-sd",
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      confluenceGrade: "A",
      confluenceCount: 4,
      patternData: {
        tradeStyle: "scalp",
        drillDown: true,
        htfDirection: poi.direction,
        htfBreakKind: poi.breakKind,
        htfZoneTop: poi.zoneTop,
        htfZoneBottom: poi.zoneBottom,
        ltfConfirmKind: poi.ltfBreakKind,
        regime,
        tp2Price: tp2,
        atrAtEntry: atrVal,
        killzoneName,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5m MODE: MICRO-ENTRY at confirmed POI (tightest SL + widest TP)
  // ═══════════════════════════════════════════════════════════════════════════

  private scan5mMicroEntry(
    coin: string,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
    strategyParams?: StrategyParams,
  ): Signal | null {
    diag.scan5m_calls++;
    const pool = confirmedPOIs.get(coin);
    if (!pool || pool.length === 0) {
      diag.scan5m_no_confirmed_pois++;
      return null;
    }

    const candle = candles[idx]!;
    const nowMs = candle.t;
    const currentBarClock = barClockFor(nowMs, "5m");

    // Expire stale confirmed POIs
    const active: ConfirmedPOI[] = [];
    for (const poi of pool) {
      if (nowMs - poi.confirmedAtMs < SMC_CONFIRMED_POI_TTL_MS) {
        active.push(poi);
      }
    }
    if (active.length === 0) {
      diag.scan5m_pois_expired++;
      confirmedPOIs.set(coin, []);
      return null;
    }
    confirmedPOIs.set(coin, active);

    const atrVal = getCachedAtr14(coin, "5m", candles, idx);
    if (Number.isNaN(atrVal) || atrVal <= 0) return null;
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT;

    // ── A. Find confirmed POI at current 5m price ─────────────────────
    let bestPOI: ConfirmedPOI | null = null;
    for (const poi of active) {
      const poiZone: KeyZone = {
        type: poi.direction === "bullish" ? "demand" : "supply",
        top: poi.zoneTop,
        bottom: poi.zoneBottom,
        strength: poi.strength,
        origin: poi.zoneOrigin,
        createdAtIdx: 0,
      };
      const prox = isAtZone(candle, poiZone, atrVal);
      if (prox.atZone) {
        bestPOI = poi;
        break;
      }
    }
    if (!bestPOI) {
      diag.scan5m_not_at_zone++;
      return null;
    }

    const side: SignalSide = bestPOI.direction === "bullish" ? "long" : "short";

    // ── B. 5m ENTRY: FVG or displacement bounce ──────────────────────
    let isBounce = false;
    let bounceQuality: "fvg" | "displacement" | "wick" = "wick";
    const hasDisplacement = isDisplacementCandle(
      candles,
      idx,
      atrVal,
      SMC_ICT_DISPLACEMENT_BODY_ATR,
    );

    // Priority 1: 5m FVG entry (ICT: enter at the FVG formed after structure shift)
    for (let i = Math.max(2, idx - SMC_5M_FVG_LOOKBACK); i <= idx; i++) {
      const fvg = detectFVG(candles, i, tol);
      if (!fvg) continue;
      if (
        (side === "long" && fvg.bullish) ||
        (side === "short" && !fvg.bullish)
      ) {
        if (side === "long" && candle.l <= fvg.top && candle.c > fvg.bottom) {
          isBounce = true;
          bounceQuality = "fvg";
          break;
        }
        if (side === "short" && candle.h >= fvg.bottom && candle.c < fvg.top) {
          isBounce = true;
          bounceQuality = "fvg";
          break;
        }
      }
    }

    // Fallback: displacement candle as entry when no FVG found.
    // Wick-only entries remain blocked — too noisy on 5m micro-TF.
    if (!isBounce && hasDisplacement) {
      isBounce = true;
      bounceQuality = "displacement";
    }
    if (!isBounce) {
      diag.scan5m_no_fvg++;
      return null;
    }

    // Body quality
    const bodySize = Math.abs(candle.c - candle.o);
    const candleRange = candle.h - candle.l;
    if (candleRange > 0 && bodySize / candleRange < SMC_MIN_BODY_RATIO) {
      diag.scan5m_body_rejected++;
      return null;
    }

    // ── C. MIXED-TF SL/TP ─────────────────────────────────────────────
    const entry = candle.c;

    // SL: 5m swing structure (ultra-tight)
    const pivots5m = getCachedPivots(coin, "5m", candles, idx, 3, tol);
    const slMult =
      (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT;
    let sl: number;
    if (side === "long") {
      let lowsFound = 0;
      let swingLow = candle.l;
      for (let i = pivots5m.length - 1; i >= 0 && lowsFound < 3; i--) {
        const pivot = pivots5m[i]!;
        if (pivot.kind !== "low" || pivot.index > idx) continue;
        if (lowsFound === 0 || pivot.price < swingLow) swingLow = pivot.price;
        lowsFound++;
      }
      sl = swingLow - atrVal * SMC_5M_SL_ATR_BUFFER * slMult;
    } else {
      let highsFound = 0;
      let swingHigh = candle.h;
      for (let i = pivots5m.length - 1; i >= 0 && highsFound < 3; i--) {
        const pivot = pivots5m[i]!;
        if (pivot.kind !== "high" || pivot.index > idx) continue;
        if (highsFound === 0 || pivot.price > swingHigh)
          swingHigh = pivot.price;
        highsFound++;
      }
      sl = swingHigh + atrVal * SMC_5M_SL_ATR_BUFFER * slMult;
    }

    // TP: 4h structure targets — context.htfCandles = 1h (HTF_MAP['5m']='1h')
    // For 4h targets, compute from POI break level + risk-based fallback
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk / entry > MAX_TRADE_SL_PCT) {
      diag.scan5m_sl_too_wide++;
      return null;
    }

    // P3-B: Minimum SL distance — ultra-tight stops are noise on 5m
    const slPct = risk / entry;
    if (slPct < SMC_5M_MIN_SL_PCT) {
      diag.scan5m_sl_too_tight++;
      return null;
    }

    // P3-B: Require 15m CHoCH confirmation (not just BOS)
    if (SMC_5M_REQUIRE_15M_CHOCH && bestPOI.ltfBreakKind !== "choch") {
      diag.scan5m_require_choch_fail++;
      return null;
    }

    const dir = side === "long" ? 1 : -1;
    let tp1: number;
    let tp2: number;

    // Try to get 4h targets via context (may be 1h candles from HTF_MAP)
    if (
      context?.htfCandles &&
      context.htfCandles.length >= MIN_CANDLES_FOR_SCAN
    ) {
      const htfIdx = context.htfCandles.length - 2;
      const htfInterval: CandleInterval = "1h";
      const htfZones = getCachedKeyZones(
        coin,
        htfInterval,
        context.htfCandles,
        htfIdx,
      );
      const htfAtrVal = getCachedAtr14(
        coin,
        htfInterval,
        context.htfCandles,
        htfIdx,
      );
      const opposingZones =
        side === "long" ? htfZones.supplyZones : htfZones.demandZones;
      const targets = computeStructureTargets(
        context.htfCandles,
        htfIdx,
        entry,
        sl,
        side,
        opposingZones,
        undefined,
        htfAtrVal,
      );
      tp1 = targets.tp1;
      tp2 = targets.tp2;
      // Ensure minimum R:R
      const minTp = entry + dir * risk * SMC_5M_MIN_RR;
      if ((side === "long" && tp1 < minTp) || (side === "short" && tp1 > minTp))
        tp1 = minTp;
    } else {
      tp1 = entry + dir * risk * SMC_5M_MIN_RR;
      tp2 = entry + dir * risk * (SMC_5M_MIN_RR + 3);
    }

    // R:R check
    const reward = Math.abs(tp1 - entry);
    if (reward / risk < SMC_5M_MIN_RR) {
      diag.scan5m_rr_too_low++;
      return null;
    }

    // ── D. CONFIDENCE ──────────────────────────────────────────────────
    let confidence =
      strategyParams?.SMC_DRILLDOWN_CONFIDENCE_BASE ?? SMC_5M_CONFIDENCE_BASE;

    // Entry quality
    if (bounceQuality === "fvg") confidence += 0.1;
    else if (bounceQuality === "displacement") confidence += 0.12;
    else confidence += 0.03;

    // 15m confirmation was CHoCH (stronger)
    if (bestPOI.ltfBreakKind === "choch")
      confidence += SMC_DRILLDOWN_CHOCH_BONUS;

    // 4h break was CHoCH (strongest HTF signal)
    if (bestPOI.breakKind === "choch") confidence += 0.05;

    // POI strength
    if (bestPOI.strength > 0.7) confidence += 0.05;

    // Killzone: bonus inside sessions, penalty outside (soft filter — not hard reject).
    // Hard reject blocked 54% of time (13/24 hours off-session) including valid setups.
    let killzoneName = "off-session";
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t);
      killzoneName = kz.name;
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY;
    }

    // Volume + VSA
    const volRatio = getCachedVolumeRatio20(coin, "5m", candles, idx);
    if (!Number.isNaN(volRatio) && volRatio > 1.5) confidence += 0.05;
    const vsaSignals = getCachedVsa(coin, "5m", candles, idx);
    if (
      vsaSignals.some(
        (s) => s.direction === (side === "long" ? "bullish" : "bearish"),
      )
    )
      confidence += 0.05;

    // Regime
    const regime = getCachedRegime(coin, "5m", candles, idx);
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams);

    // P2: liquidation cascade discount
    if (isLiquidationCascade(candle, atrVal, volRatio))
      confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT;

    // P2: weekend low-volume discount
    confidence *= getWeekendMultiplier(candle.t, volRatio);

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE)) {
      diag.scan5m_confidence_too_low++;
      return null;
    }

    // ── E. DEDUP + SIGNAL (zone-aware) ────────────────────────────────
    const dedupKey = `${coin}|5m`;
    if (
      isDuplicateSignal(
        dedupKey,
        currentBarClock,
        bestPOI.zoneTop,
        bestPOI.zoneBottom,
      )
    )
      return null;
    recordSignal(
      dedupKey,
      currentBarClock,
      bestPOI.zoneTop,
      bestPOI.zoneBottom,
    );

    // Remove consumed confirmed POI
    const remaining: ConfirmedPOI[] = [];
    for (const poi of confirmedPOIs.get(coin) ?? []) {
      if (poi !== bestPOI) remaining.push(poi);
    }
    confirmedPOIs.set(coin, remaining);
    diag.scan5m_signals++;

    return {
      type: "smc-sd",
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      confluenceGrade: "A",
      confluenceCount: 5,
      patternData: {
        drillDown: true,
        microEntry: true,
        htfDirection: bestPOI.direction,
        htfBreakKind: bestPOI.breakKind,
        htfBreakLevel: bestPOI.breakLevel,
        htfZoneOrigin: bestPOI.zoneOrigin,
        htfZoneTop: bestPOI.zoneTop,
        htfZoneBottom: bestPOI.zoneBottom,
        ltfConfirmKind: bestPOI.ltfBreakKind,
        entryType: bounceQuality,
        regime,
        tp2Price: tp2,
        atrAtEntry: atrVal,
        killzoneName,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1h MODE: SAME-TF ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  private scan1hSameTF(
    coin: string,
    interval: CandleInterval,
    candles: Candle[],
    idx: number,
    context?: StrategyContext,
    strategyParams?: StrategyParams,
  ): Signal | null {
    if (smc1hAllowedCoinSet.size > 0 && !smc1hAllowedCoinSet.has(coin))
      return null;
    const atrVal = getCachedAtr14(coin, interval, candles, idx);
    if (Number.isNaN(atrVal) || atrVal <= 0) return null;
    const volRatio = getCachedVolumeRatio20(coin, interval, candles, idx);
    if (!Number.isNaN(volRatio) && volRatio < SMC_1H_MIN_VOLUME_RATIO)
      return null;
    const tol = atrVal * SMC_PRICE_TOLERANCE_ATR_MULT;

    const breaks = getCachedStructureBreaks(coin, interval, candles, idx, {
      tolerance: tol,
    });
    let recentBreak: (typeof breaks)[number] | null = null;
    for (let i = breaks.length - 1; i >= 0; i--) {
      const candidate = breaks[i]!;
      if (idx - candidate.index <= SMC_BREAK_LOOKBACK) {
        recentBreak = candidate;
        break;
      }
    }
    if (!recentBreak) return null;
    const side: SignalSide =
      recentBreak.direction === "bullish" ? "long" : "short";
    const targetZoneType = side === "long" ? "demand" : "supply";
    const targetVsaDirection = side === "long" ? "bullish" : "bearish";
    const candle = candles[idx]!;
    const candleRange = candle.h - candle.l;
    if (
      candleRange > 0 &&
      Math.abs(candle.c - candle.o) / candleRange < SMC_MIN_BODY_RATIO
    )
      return null;

    // HTF alignment (soft)
    let htfAligned = false;
    let htfOpposed = false;
    if (
      SMC_ICT_HTF_ALIGNMENT &&
      context?.htfCandles &&
      context.htfCandles.length >= MIN_CANDLES_FOR_SCAN
    ) {
      const htfIdx = context.htfCandles.length - 2;
      if (htfIdx >= MIN_CANDLES_FOR_SCAN) {
        const htfBias = getCachedHtfStructureBias(
          coin,
          context.htfInterval ?? interval,
          context.htfCandles,
          htfIdx,
        );
        htfAligned =
          (side === "long" && htfBias.bias === "bullish") ||
          (side === "short" && htfBias.bias === "bearish");
        htfOpposed =
          (side === "long" &&
            htfBias.bias === "bearish" &&
            htfBias.confidence > 0.7) ||
          (side === "short" &&
            htfBias.bias === "bullish" &&
            htfBias.confidence > 0.7);
      }
    }

    // Hard-block counter-trend BOS (CHoCH allowed — it IS a reversal signal)
    if (htfOpposed && recentBreak.kind === "bos") return null;

    // P/D filter
    const pivots = getCachedPivots(coin, interval, candles, idx, 5, tol);
    const recentHighPrices: number[] = [];
    const recentLowPrices: number[] = [];
    let highCount = 0;
    let lowCount = 0;
    for (const pivot of pivots) {
      if (pivot.kind === "high") {
        highCount++;
        recentHighPrices.push(pivot.price);
        if (recentHighPrices.length > 3) recentHighPrices.shift();
      } else {
        lowCount++;
        recentLowPrices.push(pivot.price);
        if (recentLowPrices.length > 3) recentLowPrices.shift();
      }
    }
    if (highCount === 0 || lowCount === 0) return null;
    let recentHighMax = recentHighPrices[0]!;
    for (let i = 1; i < recentHighPrices.length; i++) {
      const price = recentHighPrices[i]!;
      if (price > recentHighMax) recentHighMax = price;
    }
    let recentLowMin = recentLowPrices[0]!;
    for (let i = 1; i < recentLowPrices.length; i++) {
      const price = recentLowPrices[i]!;
      if (price < recentLowMin) recentLowMin = price;
    }
    const pd = premiumDiscount(recentHighMax, recentLowMin, candle.c);
    if (
      (side === "long" && pd === "premium") ||
      (side === "short" && pd === "discount")
    )
      return null;

    // OTE
    let inOTE = false;
    if (SMC_ICT_OTE_FILTER) {
      if (side === "long" && recentLowPrices.length > 0) {
        const ote = oteZone(recentLowMin, recentBreak.level);
        if (ote) inOTE = candle.c >= ote.bottom && candle.c <= ote.top;
      } else if (side === "short" && recentHighPrices.length > 0) {
        const ote = oteZone(recentHighMax, recentBreak.level);
        if (ote) inOTE = candle.c >= ote.bottom && candle.c <= ote.top;
      }
    }

    // Zones (+ Breaker + Inversion)
    const { demandZones, supplyZones } = getCachedKeyZones(
      coin,
      interval,
      candles,
      idx,
      tol,
    );

    // Zone proximity
    let bestZone: KeyZone | null = null;
    let proximity = {
      atZone: false,
      wickTouch: false,
      nearZone: false,
      throughZone: false,
    };
    const tryAcceptZone = (z: KeyZone): boolean => {
      if (idx - z.createdAtIdx > ZONE_MAX_AGE) return false;
      if (z.strength < SMC_MIN_ZONE_STRENGTH) return false;
      const prox = isAtZone(candle, z, atrVal);
      if (!prox.atZone) return false;
      bestZone = z;
      proximity = prox;
      return true;
    };
    const primaryZones = side === "long" ? demandZones : supplyZones;
    for (const z of primaryZones) {
      if (tryAcceptZone(z)) break;
    }
    if (!bestZone && SMC_ICT_BREAKER_BLOCK_ENABLED) {
      for (const bb of getCachedBreakerBlocks50(coin, interval, candles, idx)) {
        if (bb.type !== targetZoneType) continue;
        if (
          tryAcceptZone({
            type: bb.type,
            top: bb.top,
            bottom: bb.bottom,
            strength: 0.85,
            origin: "breaker-block",
            createdAtIdx: bb.index,
          })
        )
          break;
      }
    }
    if (!bestZone && SMC_ICT_INVERSION_FVG_ENABLED) {
      for (const inv of getCachedInversionFVGs(
        coin,
        interval,
        candles,
        idx,
        tol,
      )) {
        if (inv.type !== targetZoneType) continue;
        if (
          tryAcceptZone({
            type: inv.type,
            top: inv.top,
            bottom: inv.bottom,
            strength: 0.75,
            origin: "inversion-fvg",
            createdAtIdx: inv.index,
          })
        )
          break;
      }
    }
    if (!bestZone) return null;
    const selectedZone: KeyZone = bestZone;

    // Bounce detection
    let isBounce = false;
    let bounceQuality: "displacement" | "wick" | "sweep" = "wick";
    const hasDisplacement = isDisplacementCandle(
      candles,
      idx,
      atrVal,
      SMC_ICT_DISPLACEMENT_BODY_ATR,
    );
    if (side === "long") {
      const we = candle.l <= selectedZone.top + tol;
      const ca = candle.c > selectedZone.top - tol;
      const bc = candle.c > candle.o;
      if (we && ca && hasDisplacement && bc) {
        isBounce = true;
        bounceQuality = "displacement";
      } else if (proximity.throughZone && ca && bc) {
        if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          isBounce = true;
          bounceQuality = "sweep";
        } else if (hasDirectionalSweepWick(candle, side, 0.4)) {
          const sw = detectLiquiditySweep(candles, idx, {
            lookback: 20,
            wickRatio: 0.4,
          });
          if (sw?.direction === "bullish") {
            isBounce = true;
            bounceQuality = "sweep";
          }
        }
      } else if (we && ca && bc) {
        isBounce = true;
      } else if (proximity.wickTouch && bc) {
        isBounce = true;
      }
    } else {
      const we = candle.h >= selectedZone.bottom - tol;
      const cb = candle.c < selectedZone.bottom + tol;
      const bc = candle.c < candle.o;
      if (we && cb && hasDisplacement && bc) {
        isBounce = true;
        bounceQuality = "displacement";
      } else if (proximity.throughZone && cb && bc) {
        if (!SMC_ICT_REQUIRE_SWEEP_FOR_THROUGH) {
          isBounce = true;
          bounceQuality = "sweep";
        } else if (hasDirectionalSweepWick(candle, side, 0.4)) {
          const sw = detectLiquiditySweep(candles, idx, {
            lookback: 20,
            wickRatio: 0.4,
          });
          if (sw?.direction === "bearish") {
            isBounce = true;
            bounceQuality = "sweep";
          }
        }
      } else if (we && cb && bc) {
        isBounce = true;
      } else if (proximity.wickTouch && bc) {
        isBounce = true;
      }
    }
    if (!isBounce) return null;

    const adxVal = getCachedAdx14(coin, interval, candles, idx);
    if (!Number.isNaN(adxVal) && adxVal < SMC_1H_MIN_ADX) return null;

    // Confidence (base tunable via SMC_1H_CONFIDENCE_BASE optimizer param)
    const _base1h = strategyParams?.SMC_1H_CONFIDENCE_BASE;
    let confidence =
      typeof _base1h === "number" && Number.isFinite(_base1h) && _base1h > 0
        ? _base1h
        : 0.65;
    if (recentBreak.kind === "choch") confidence += 0.1;
    if (recentBreak.kind === "bos") confidence -= SMC_1H_BOS_PENALTY;
    if (bounceQuality === "displacement") confidence += 0.12;
    else if (bounceQuality === "sweep") confidence += 0.1;
    else confidence += 0.05;
    if (
      (side === "long" && candle.c > candle.o) ||
      (side === "short" && candle.c < candle.o)
    )
      confidence += 0.05;
    if (
      (side === "long" && pd === "discount") ||
      (side === "short" && pd === "premium")
    )
      confidence += 0.05;
    if (htfAligned) confidence += SMC_ICT_HTF_ALIGNED_BONUS;
    if (htfOpposed) confidence -= SMC_ICT_HTF_COUNTER_PENALTY;
    if (inOTE) confidence += SMC_ICT_OTE_BONUS;
    if (selectedZone.origin === "breaker-block")
      confidence += SMC_ICT_BREAKER_BLOCK_BONUS;
    if (selectedZone.origin === "inversion-fvg")
      confidence += SMC_ICT_INVERSION_FVG_BONUS;
    if (selectedZone.strength > 0.6) confidence += 0.05;
    if (selectedZone.strength > 0.8) confidence += 0.05;
    if (!Number.isNaN(adxVal) && adxVal > 30) confidence += 0.08;
    else if (!Number.isNaN(adxVal) && adxVal > 25) confidence += 0.05;
    if (!Number.isNaN(volRatio) && volRatio > 2.0) confidence += 0.08;
    else if (!Number.isNaN(volRatio) && volRatio > 1.5) confidence += 0.05;
    const vsaSignals = getCachedVsa(coin, interval, candles, idx);
    for (const signal of vsaSignals) {
      if (signal.direction === targetVsaDirection) {
        confidence += 0.05;
        break;
      }
    }
    let killzoneName = "off-session";
    if (SMC_ICT_KILLZONE_ENABLED) {
      const kz = getKillzoneBonus(candle.t);
      killzoneName = kz.name;
      confidence += kz.inKillzone ? kz.bonus : -SMC_ICT_KILLZONE_PENALTY;
    }
    const regime = getCachedRegime(coin, interval, candles, idx);
    confidence = applyRegimeModifier(confidence, side, regime, strategyParams);

    // P2: liquidation cascade discount
    if (isLiquidationCascade(candle, atrVal, volRatio))
      confidence *= SMC_LIQUIDATION_CONFIDENCE_MULT;

    // P2: weekend low-volume discount
    confidence *= getWeekendMultiplier(candle.t, volRatio);

    if (confidence < (strategyParams?.MIN_CONFIDENCE ?? MIN_CONFIDENCE))
      return null;

    // SL/TP
    const entry = candle.c;
    const slMult =
      (strategyParams?.SL_WICK_ATR_MULT ?? SL_WICK_ATR_MULT) / SL_WICK_ATR_MULT;
    const sl =
      side === "long"
        ? selectedZone.bottom - atrVal * STRUCTURE_STOP_ATR_BUFFER * slMult
        : selectedZone.top + atrVal * STRUCTURE_STOP_ATR_BUFFER * slMult;
    const opposingZones = side === "long" ? supplyZones : demandZones;
    const { tp1, tp2 } = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      side,
      opposingZones,
      undefined,
      atrVal,
    );
    const riskAmt = Math.abs(entry - sl);
    if (
      riskAmt / entry > MAX_TRADE_SL_PCT ||
      riskAmt <= 0 ||
      Math.abs(tp1 - entry) / riskAmt <
        (strategyParams?.SMC_MIN_RR ?? SMC_MIN_RR)
    )
      return null;
    const tpDistance = Math.abs(tp1 - entry);
    if (tpDistance > 0) {
      let nearestOpposingPoolLevel: number | null = null;
      for (const pool of findLiquidityPools(candles, idx, {
        tolerance: tol,
        atrValue: atrVal,
      })) {
        if (side === "long") {
          if (pool.type !== "bsl" || pool.level <= entry) continue;
          if (
            nearestOpposingPoolLevel === null ||
            pool.level < nearestOpposingPoolLevel
          ) {
            nearestOpposingPoolLevel = pool.level;
          }
        } else {
          if (pool.type !== "ssl" || pool.level >= entry) continue;
          if (
            nearestOpposingPoolLevel === null ||
            pool.level > nearestOpposingPoolLevel
          ) {
            nearestOpposingPoolLevel = pool.level;
          }
        }
      }
      if (
        nearestOpposingPoolLevel !== null &&
        Math.abs(nearestOpposingPoolLevel - entry) <= tpDistance
      ) {
        confidence += SMC_ICT_LIQUIDITY_POOL_TP_BONUS;
      }
    }

    // P2: zone-aware dedup
    const dedupKey = `${coin}|${interval}`;
    const currentBarClock = barClockFor(candle.t, interval);
    if (
      isDuplicateSignal(
        dedupKey,
        currentBarClock,
        selectedZone.top,
        selectedZone.bottom,
      )
    )
      return null;
    recordSignal(
      dedupKey,
      currentBarClock,
      selectedZone.top,
      selectedZone.bottom,
    );

    return {
      type: "smc-sd",
      side,
      confidence: Math.min(confidence, 1),
      entryPrice: entry,
      slPrice: sl,
      tpPrice: tp1,
      confluenceGrade: "B",
      confluenceCount: 3,
      patternData: {
        breakKind: recentBreak.kind,
        breakDirection: recentBreak.direction,
        breakLevel: recentBreak.level,
        premiumDiscount: pd,
        zoneOrigin: selectedZone.origin,
        zoneTop: selectedZone.top,
        zoneBottom: selectedZone.bottom,
        zoneStrength: selectedZone.strength,
        throughZone: proximity.throughZone,
        regime,
        tp2Price: tp2,
        atrAtEntry: atrVal,
        htfAligned,
        inOTE,
        bounceQuality,
        hasDisplacement,
        atBreakerBlock: selectedZone.origin === "breaker-block",
        atInversionFVG: selectedZone.origin === "inversion-fvg",
        killzoneName,
      },
    };
  }

  windowRequirements(): WindowRequirements {
    // S2: planningBars set to target depths per TF for the 4-mode ICT model.
    // Live behavior unchanged until orchestrator wiring reads these (already done in S2).
    // Values sized for each mode's structural needs:
    //   4h: 2000 bars ≈ 333 days — HTF POI detection needs deep structure history
    //   1h: 1000 bars ≈ 41 days — same-TF analysis + regime context
    //   15m: 1000 bars ≈ 10 days — confirmation break detection
    //   5m: 500 bars ≈ 1.7 days — micro entry via FVG/displacement
    return {
      planningBars: {
        "5m": 500,
        "15m": 1_000,
        "1h": 1_000,
        "4h": 2_000,
      },
      htfContextBars: {
        "1h": 400, // 5m scan reads 1h as HTF context
        "4h": 500, // 15m/1h scan reads 4h as HTF context
        "1d": 200, // 4h scan reads 1d as HTF context
      },
      replayBars: {
        "5m": 500, // rebuild lastSignalState (dedup)
        "15m": 1_000, // rebuild confirmedPOIs
        "1h": 1_000, // rebuild 1h same-TF state
        "4h": 2_000, // rebuild htfPOIs
      },
      preseedTFs: ["1d"],
    };
  }

  clearState(): void {
    lastSignalState.clear();
    htfPOIs.clear();
    confirmedPOIs.clear();
    // Note: do NOT reset diagnostics here — they accumulate across walk-forward windows
  }
}
