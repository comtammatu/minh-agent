/**
 * Advisor types — learning loop v1.
 *
 * The advisor turns closed-trade outcomes (trade_outcome memories) into
 * per-bucket statistics and consults them pre-entry. Verdicts can only
 * reduce risk: veto or dampen size. Pass-through is always the safe default.
 */

import type { CandleInterval, MarketRegime, SignalSide } from "../types.js";

// ─── Outcome rows (input to aggregation) ─────────────────────────────────────

/** One closed-trade outcome, as read from trade_memory. */
export interface OutcomeRow {
  pattern: string;
  regime: MarketRegime | null;
  side: SignalSide;
  timeframe: CandleInterval | null;
  pnlR: number | null;
  /** Raw pnl — used only for win/loss when pnlR is unavailable. */
  pnl: number | null;
}

// ─── Bucket stats ────────────────────────────────────────────────────────────

/** Aggregated outcomes for one bucket (a specific dimension combination). */
export interface BucketStats {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  /** Laplace-smoothed win rate — stable for small samples. */
  smoothedWinRate: number;
  /** Mean R multiple over trades that have pnlR; null if none do. */
  avgR: number | null;
}

/** Immutable snapshot the entry path reads synchronously. */
export interface AdvisorSnapshot {
  /** bucket key → stats, all hierarchy levels included. */
  buckets: ReadonlyMap<string, BucketStats>;
  /** Global stats across all outcomes (insight baseline). */
  global: BucketStats | null;
  /** When this snapshot was built (ms epoch). */
  builtAt: number;
  /** Total outcome rows the snapshot was built from. */
  sampleSize: number;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

export type AdvisorAction = "allow" | "dampen" | "veto";

export interface AdvisorVerdict {
  action: AdvisorAction;
  /** Size multiplier in (0, 1]; 1 unless action === "dampen". */
  sizeMultiplier: number;
  /** Bucket that drove the decision, null when no bucket had enough samples. */
  bucketKey: string | null;
  /** Sample size of the deciding bucket (0 when none). */
  sampleSize: number;
  /** Human-readable reason for journal/report surfaces. */
  reason: string;
}

/** The fields evaluateSetup needs from a setup. Subset of ActiveSetup. */
export interface SetupDims {
  pattern: string;
  side: SignalSide;
  regime: MarketRegime | null;
  interval: CandleInterval | null;
}

// ─── Insights ────────────────────────────────────────────────────────────────

/** A bucket whose performance deviates enough from global to be worth memorizing. */
export interface BucketInsight {
  bucketKey: string;
  trades: number;
  smoothedWinRate: number;
  avgR: number | null;
  /** Positive = bucket beats global, negative = underperforms. */
  winRateDelta: number;
  content: string;
}
