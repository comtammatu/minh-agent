/**
 * Portfolio Risk Manager — global exposure cap across all strategies (S6).
 *
 * Pure functions. No I/O, no side effects.
 * Takes position snapshot data as input, returns allow/block decision.
 *
 * Checks:
 *   1. Total notional exposure vs account equity (maxTotalExposure)
 *   2. Total concurrent positions (maxTotalConcurrent)
 *   3. Per-strategy allocation cap (strategyAllocations)
 *   4. Per-strategy concurrent positions (strategyMaxConcurrent)
 */

import { PORTFOLIO_RISK } from '../config.js'

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal position info needed for portfolio risk checks. */
export interface PortfolioPosition {
  coin: string
  strategyId: string
  /** Absolute notional value = |size| × currentPrice. */
  notionalValue: number
}

/** Result of a portfolio risk check. */
export interface PortfolioCheckResult {
  allowed: boolean
  reason: string | null
}

/** Input for checking whether a new entry is allowed. */
export interface PortfolioCheckInput {
  /** Current open positions across all strategies. */
  positions: readonly PortfolioPosition[]
  /** Total account equity (shared balance across all strategies). */
  accountEquity: number
  /** The strategy requesting entry. */
  strategyId: string
  /** Notional value of the proposed new position. */
  proposedNotional: number
}

// ─── Core Check ─────────────────────────────────────────────────────────────

/**
 * Check whether a new entry is allowed given current portfolio state.
 * Returns { allowed: true } or { allowed: false, reason: '...' }.
 *
 * Checks run in order — first failure short-circuits.
 */
export function checkPortfolioEntry(input: PortfolioCheckInput): PortfolioCheckResult {
  const { positions, accountEquity, strategyId, proposedNotional } = input

  // Guard: zero/negative equity → block (can't compute ratios)
  if (accountEquity <= 0) {
    return { allowed: false, reason: 'account equity is zero or negative' }
  }

  // 1. Total concurrent positions
  const totalPositions = positions.length
  if (totalPositions >= PORTFOLIO_RISK.maxTotalConcurrent) {
    return {
      allowed: false,
      reason: `total concurrent positions ${totalPositions} >= max ${PORTFOLIO_RISK.maxTotalConcurrent}`,
    }
  }

  // 2. Total notional exposure
  const currentTotalNotional = positions.reduce((sum, p) => sum + p.notionalValue, 0)
  const newTotalNotional = currentTotalNotional + proposedNotional
  const newExposureRatio = newTotalNotional / accountEquity
  if (newExposureRatio > PORTFOLIO_RISK.maxTotalExposure) {
    return {
      allowed: false,
      reason: `total exposure ${newExposureRatio.toFixed(2)}x would exceed max ${PORTFOLIO_RISK.maxTotalExposure}x`,
    }
  }

  // 3. Per-strategy concurrent positions
  const strategyPositions = positions.filter(p => p.strategyId === strategyId).length
  const strategyMaxConcurrent = PORTFOLIO_RISK.strategyMaxConcurrent[strategyId]
  if (strategyMaxConcurrent !== undefined && strategyPositions >= strategyMaxConcurrent) {
    return {
      allowed: false,
      reason: `strategy '${strategyId}' concurrent positions ${strategyPositions} >= max ${strategyMaxConcurrent}`,
    }
  }

  // 4. Per-strategy allocation cap
  const strategyAllocation = PORTFOLIO_RISK.strategyAllocations[strategyId]
  if (strategyAllocation !== undefined) {
    const strategyNotional = positions
      .filter(p => p.strategyId === strategyId)
      .reduce((sum, p) => sum + p.notionalValue, 0)
    const allocatedCapital = accountEquity * strategyAllocation
    const newStrategyNotional = strategyNotional + proposedNotional
    if (newStrategyNotional > allocatedCapital * PORTFOLIO_RISK.maxTotalExposure) {
      return {
        allowed: false,
        reason: `strategy '${strategyId}' notional $${newStrategyNotional.toFixed(0)} would exceed allocation cap $${(allocatedCapital * PORTFOLIO_RISK.maxTotalExposure).toFixed(0)} (${(strategyAllocation * 100).toFixed(0)}% × ${PORTFOLIO_RISK.maxTotalExposure}x)`,
      }
    }
  }

  return { allowed: true, reason: null }
}

// ─── Snapshot Helper ────────────────────────────────────────────────────────

/** Summary of current portfolio risk state (for API/logging). */
export interface PortfolioRiskSnapshot {
  totalPositions: number
  totalNotional: number
  exposureRatio: number
  perStrategy: Record<string, { positions: number; notional: number }>
}

/** Build a portfolio risk snapshot from current positions. */
export function getPortfolioRiskSnapshot(
  positions: readonly PortfolioPosition[],
  accountEquity: number,
): PortfolioRiskSnapshot {
  const perStrategy: Record<string, { positions: number; notional: number }> = {}
  let totalNotional = 0

  for (const pos of positions) {
    totalNotional += pos.notionalValue
    const entry = perStrategy[pos.strategyId] ?? { positions: 0, notional: 0 }
    entry.positions++
    entry.notional += pos.notionalValue
    perStrategy[pos.strategyId] = entry
  }

  return {
    totalPositions: positions.length,
    totalNotional,
    exposureRatio: accountEquity > 0 ? totalNotional / accountEquity : 0,
    perStrategy,
  }
}
