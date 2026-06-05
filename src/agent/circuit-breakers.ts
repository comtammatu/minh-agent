/**
 * Circuit Breakers — pure check functions for capital protection.
 *
 * S11: Daily loss, consecutive loss, rapid loss, max drawdown.
 * R5:  CB pauses NEW entries only. IN_POSITION keeps SL/TP on exchange.
 *
 * All functions are pure: (inputs) → result. No I/O, no side effects.
 * Thresholds come from config.ts CIRCUIT_BREAKER.
 */

import { CIRCUIT_BREAKER } from "../config.js";
import type { PnlEntry } from "./types.js";

// ─── Check Result ──────────────────────────────────────────────────────────

export interface CBCheckResult {
  tripped: boolean;
  reason: string | null;
  /** When the pause should auto-resume (ms timestamp). null = manual only (e.g., daily resets at midnight). */
  pauseUntil: number | null;
}

const OK: CBCheckResult = { tripped: false, reason: null, pauseUntil: null };

// ─── Individual Checks ─────────────────────────────────────────────────────

/**
 * Daily loss limit: pause until next UTC midnight when dailyPnl exceeds threshold.
 * @param dailyPnl - Total realized PnL for today (negative = loss)
 * @param accountValue - Current account value
 * @param now - Current timestamp (ms)
 */
export function checkDailyLoss(
  dailyPnl: number,
  accountValue: number,
  now: number,
): CBCheckResult {
  if (accountValue <= 0) return OK;
  const lossPct = -dailyPnl / accountValue;
  if (lossPct >= CIRCUIT_BREAKER.dailyLossLimit) {
    return {
      tripped: true,
      reason: `Daily loss ${(lossPct * 100).toFixed(1)}% >= ${(CIRCUIT_BREAKER.dailyLossLimit * 100).toFixed(0)}% limit`,
      pauseUntil: nextUtcMidnight(now),
    };
  }
  return OK;
}

/**
 * Consecutive losses: pause for N hours when hitting threshold.
 * @param consecutiveLosses - Number of consecutive losing trades (per-coin)
 * @param now - Current timestamp (ms)
 */
export function checkConsecutiveLosses(
  consecutiveLosses: number,
  now: number,
): CBCheckResult {
  if (consecutiveLosses >= CIRCUIT_BREAKER.consecutiveLossCount) {
    return {
      tripped: true,
      reason: `${consecutiveLosses} consecutive losses >= ${CIRCUIT_BREAKER.consecutiveLossCount} limit`,
      pauseUntil: now + CIRCUIT_BREAKER.consecutiveLossPauseMs,
    };
  }
  return OK;
}

/**
 * Rapid loss: pause when cumulative loss in sliding window exceeds threshold.
 * @param pnlHistory - Recent PnL entries with timestamps
 * @param accountValue - Current account value
 * @param now - Current timestamp (ms)
 */
export function checkRapidLoss(
  pnlHistory: readonly PnlEntry[],
  accountValue: number,
  now: number,
): CBCheckResult {
  if (accountValue <= 0 || pnlHistory.length === 0) return OK;

  const windowStart = now - CIRCUIT_BREAKER.rapidLossWindowMs;
  let windowPnl = 0;
  for (const entry of pnlHistory) {
    if (entry.ts >= windowStart) {
      windowPnl += entry.pnl;
    }
  }

  // Only trip on losses (negative PnL)
  if (windowPnl >= 0) return OK;

  const lossPct = -windowPnl / accountValue;
  if (lossPct >= CIRCUIT_BREAKER.rapidLossLimit) {
    return {
      tripped: true,
      reason: `Rapid loss ${(lossPct * 100).toFixed(1)}% in ${Math.round(CIRCUIT_BREAKER.rapidLossWindowMs / 60_000)}min >= ${(CIRCUIT_BREAKER.rapidLossLimit * 100).toFixed(0)}% limit`,
      pauseUntil: now + CIRCUIT_BREAKER.rapidLossPauseMs,
    };
  }
  return OK;
}

/**
 * Max drawdown from peak: pause + alert when drawdown exceeds threshold.
 * @param currentValue - Current account value
 * @param peakValue - Highest account value observed
 */
export function checkMaxDrawdown(
  currentValue: number,
  peakValue: number,
): CBCheckResult {
  if (peakValue <= 0 || currentValue <= 0) return OK;

  const drawdown = (peakValue - currentValue) / peakValue;
  if (drawdown >= CIRCUIT_BREAKER.maxDrawdownLimit) {
    return {
      tripped: true,
      reason: `Max drawdown ${(drawdown * 100).toFixed(1)}% from peak >= ${(CIRCUIT_BREAKER.maxDrawdownLimit * 100).toFixed(0)}% limit`,
      // No auto-resume — manual only (this is a serious condition)
      pauseUntil: null,
    };
  }
  return OK;
}

// ─── Aggregate Check ───────────────────────────────────────────────────────

/**
 * Run all circuit breaker checks. Returns the first tripped result, or OK.
 * Order: max drawdown (most severe, no auto-resume) → daily loss → rapid loss → consecutive.
 */
export function runAllChecks(params: {
  dailyPnl: number;
  accountValue: number;
  peakAccountValue: number;
  consecutiveLosses: number;
  pnlHistory: readonly PnlEntry[];
  now: number;
}): CBCheckResult {
  const {
    dailyPnl,
    accountValue,
    peakAccountValue,
    consecutiveLosses,
    pnlHistory,
    now,
  } = params;

  // Most severe first — max drawdown has no auto-resume
  const drawdown = checkMaxDrawdown(accountValue, peakAccountValue);
  if (drawdown.tripped) return drawdown;

  const daily = checkDailyLoss(dailyPnl, accountValue, now);
  if (daily.tripped) return daily;

  const rapid = checkRapidLoss(pnlHistory, accountValue, now);
  if (rapid.tripped) return rapid;

  const consecutive = checkConsecutiveLosses(consecutiveLosses, now);
  if (consecutive.tripped) return consecutive;

  return OK;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Next UTC midnight timestamp from a given time. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Prune pnlHistory entries older than the rapid loss window.
 * Call periodically to prevent unbounded growth.
 */
export function prunePnlHistory(history: PnlEntry[], now: number): PnlEntry[] {
  const cutoff = now - CIRCUIT_BREAKER.rapidLossWindowMs;
  return history.filter((e) => e.ts >= cutoff);
}
