/**
 * Portfolio Risk Manager — portfolio-level exposure cap for the shared runtime account.
 *
 * Pure functions. No I/O, no side effects.
 * Takes position snapshot data as input, returns allow/block decision.
 */

import { PORTFOLIO_RISK } from "../config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal position info needed for portfolio risk checks. */
export interface PortfolioPosition {
  coin: string;
  /** Absolute notional value = |size| × currentPrice. */
  notionalValue: number;
}

/** Result of a portfolio risk check. */
export interface PortfolioCheckResult {
  allowed: boolean;
  reason: string | null;
}

/** Input for checking whether a new entry is allowed. */
export interface PortfolioCheckInput {
  /** Current open positions across the runtime. */
  positions: readonly PortfolioPosition[];
  /** Total account equity. */
  accountEquity: number;
  /** Notional value of the proposed new position. */
  proposedNotional: number;
}

// ─── Core Check ─────────────────────────────────────────────────────────────

/**
 * Check whether a new entry is allowed given current portfolio state.
 * Returns { allowed: true } or { allowed: false, reason: '...' }.
 *
 * Checks run in order — first failure short-circuits.
 */
export function checkPortfolioEntry(
  input: PortfolioCheckInput,
): PortfolioCheckResult {
  const { positions, accountEquity, proposedNotional } = input;

  // Guard: zero/negative equity → block (can't compute ratios)
  if (accountEquity <= 0) {
    return { allowed: false, reason: "account equity is zero or negative" };
  }

  // 1. Total concurrent positions
  const totalPositions = positions.length;
  if (totalPositions >= PORTFOLIO_RISK.maxTotalConcurrent) {
    return {
      allowed: false,
      reason: `total concurrent positions ${totalPositions} >= max ${PORTFOLIO_RISK.maxTotalConcurrent}`,
    };
  }

  // 2. Total notional exposure
  const currentTotalNotional = positions.reduce(
    (sum, p) => sum + p.notionalValue,
    0,
  );
  const newTotalNotional = currentTotalNotional + proposedNotional;
  const newExposureRatio = newTotalNotional / accountEquity;
  if (newExposureRatio > PORTFOLIO_RISK.maxTotalExposure) {
    return {
      allowed: false,
      reason: `total exposure ${newExposureRatio.toFixed(2)}x would exceed max ${PORTFOLIO_RISK.maxTotalExposure}x`,
    };
  }

  return { allowed: true, reason: null };
}

// ─── Snapshot Helper ────────────────────────────────────────────────────────

/** Summary of current portfolio risk state (for API/logging). */
export interface PortfolioRiskSnapshot {
  totalPositions: number;
  totalNotional: number;
  exposureRatio: number;
}

/** Build a portfolio risk snapshot from current positions. */
export function getPortfolioRiskSnapshot(
  positions: readonly PortfolioPosition[],
  accountEquity: number,
): PortfolioRiskSnapshot {
  let totalNotional = 0;

  for (const pos of positions) {
    totalNotional += pos.notionalValue;
  }

  return {
    totalPositions: positions.length,
    totalNotional,
    exposureRatio: accountEquity > 0 ? totalNotional / accountEquity : 0,
  };
}
