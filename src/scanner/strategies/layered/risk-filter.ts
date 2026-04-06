/**
 * Risk filter — zone distance → size/RR/skip (Section 12).
 *
 * Distance thresholds:
 *   < 2%  → full size, minRR 1.5
 *   2-5%  → standard, minRR 2.0
 *   5-8%  → partial, minRR 3.0
 *   > 10% → skip
 *
 * Skip if ANY:
 *   - R:R < minRR
 *   - |entry - sl| > atrValue × 3 (stop too wide)
 *   - position size too small (< 0.1% of account)
 *
 * Pure function. Zero I/O.
 */

import type { Signal, KeyZone, RiskAssessment } from '../../../types.js'
import { ZONE_RISK, DEFAULT_RISK_PERCENT, MIN_POSITION_SIZE_PCT } from '../../../config.js'
import { computePositionSize } from '../../../agent/exits.js'

/**
 * Assess risk for a signal at a zone.
 *
 * R11: accountValue is passed in by caller (real balance from ExchangeService).
 * Pure function — no I/O.
 *
 * @param signal       Signal from Layer 5
 * @param zone         The zone the signal was triggered at
 * @param currentPrice Current price (candle close)
 * @param atrValue     Current ATR value
 * @param accountValue Account balance in USD (R11: from ExchangeService, not hardcoded)
 * @returns RiskAssessment
 */
export function assessRisk(
  signal: Signal,
  zone: KeyZone,
  currentPrice: number,
  atrValue: number,
  accountValue: number,
): RiskAssessment {
  const zoneMid = (zone.top + zone.bottom) / 2
  const distance = Math.abs(currentPrice - zoneMid) / currentPrice

  // Determine size tier
  if (distance >= ZONE_RISK.skip.maxDistance) {
    return {
      tradeable: false,
      reason: `zone too far: ${(distance * 100).toFixed(1)}% > ${(ZONE_RISK.skip.maxDistance * 100).toFixed(0)}%`,
      suggestedSize: 'skip',
      minRR: 0,
      stopMethod: 'skip',
    }
  }

  let suggestedSize: RiskAssessment['suggestedSize']
  let minRR: number

  if (distance < ZONE_RISK.near.maxDistance) {
    suggestedSize = 'full'
    minRR = ZONE_RISK.near.minRR
  } else if (distance < ZONE_RISK.medium.maxDistance) {
    suggestedSize = 'standard'
    minRR = ZONE_RISK.medium.minRR
  } else {
    suggestedSize = 'partial'
    minRR = ZONE_RISK.far.minRR
  }

  // Compute R:R
  const stopDistance = Math.abs(signal.entryPrice - signal.slPrice)
  const reward = Math.abs(signal.tpPrice - signal.entryPrice)
  const rr = stopDistance > 0 ? reward / stopDistance : 0

  // Skip: R:R too low
  if (rr < minRR) {
    return {
      tradeable: false,
      reason: `R:R ${rr.toFixed(2)} < min ${minRR.toFixed(1)}`,
      suggestedSize: 'skip',
      minRR,
      stopMethod: 'structure',
    }
  }

  // Skip: stop too wide (> ATR × 3)
  if (stopDistance > atrValue * 3) {
    return {
      tradeable: false,
      reason: `stop too wide: ${stopDistance.toFixed(2)} > ATR×3 (${(atrValue * 3).toFixed(2)})`,
      suggestedSize: 'skip',
      minRR,
      stopMethod: 'atr',
    }
  }

  // Skip: position size too small (R12: shared computePositionSize)
  const positionSize = computePositionSize(accountValue, DEFAULT_RISK_PERCENT, signal.entryPrice, signal.slPrice)
  const positionSizeUsd = positionSize * signal.entryPrice
  const minSize = accountValue * MIN_POSITION_SIZE_PCT
  if (positionSizeUsd < minSize) {
    return {
      tradeable: false,
      reason: 'position size too small',
      suggestedSize: 'skip',
      minRR,
      stopMethod: 'structure',
    }
  }

  return {
    tradeable: true,
    suggestedSize,
    minRR,
    stopMethod: 'structure',
  }
}
