/**
 * Advisor stats — pure bucket aggregation + setup evaluation.
 *
 * Zero I/O. All functions return values, never mutate inputs, and degrade to
 * the pass-through verdict on missing/invalid input. Thresholds live in
 * config.ts (ADVISOR block) and are passed in so tests can pin them.
 */

import { ADVISOR } from "../config.js";
import type {
  AdvisorSnapshot,
  AdvisorVerdict,
  BucketStats,
  OutcomeRow,
  SetupDims,
} from "./types.js";

export type AdvisorThresholds = typeof ADVISOR;

const PASS_THROUGH: AdvisorVerdict = {
  action: "allow",
  sizeMultiplier: 1,
  bucketKey: null,
  sampleSize: 0,
  reason: "no bucket with sufficient samples — pass-through",
};

// ─── Bucket keys ─────────────────────────────────────────────────────────────

/**
 * Bucket key hierarchy, most specific first:
 *   L1 pattern|regime|side|interval
 *   L2 pattern|regime|side
 *   L3 pattern|side
 * Dimensions with null are skipped (a row with no regime can't feed L1/L2).
 */
export function bucketKeysFor(dims: SetupDims): string[] {
  const keys: string[] = [];
  if (dims.regime && dims.interval) {
    keys.push(`${dims.pattern}|${dims.regime}|${dims.side}|${dims.interval}`);
  }
  if (dims.regime) {
    keys.push(`${dims.pattern}|${dims.regime}|${dims.side}`);
  }
  keys.push(`${dims.pattern}|${dims.side}`);
  return keys;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface MutableBucket {
  trades: number;
  wins: number;
  losses: number;
  rSum: number;
  rCount: number;
}

function emptyBucket(): MutableBucket {
  return { trades: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 };
}

function isWin(row: OutcomeRow): boolean | null {
  if (row.pnlR !== null && Number.isFinite(row.pnlR)) return row.pnlR > 0;
  if (row.pnl !== null && Number.isFinite(row.pnl) && row.pnl !== 0) {
    return row.pnl > 0;
  }
  return null; // unusable row — no outcome signal
}

function addRow(bucket: MutableBucket, row: OutcomeRow, win: boolean): void {
  bucket.trades += 1;
  if (win) bucket.wins += 1;
  else bucket.losses += 1;
  if (row.pnlR !== null && Number.isFinite(row.pnlR)) {
    bucket.rSum += row.pnlR;
    bucket.rCount += 1;
  }
}

function finalize(
  key: string,
  bucket: MutableBucket,
  cfg: AdvisorThresholds,
): BucketStats {
  const smoothedWinRate =
    (bucket.wins + cfg.smoothingAlpha) /
    (bucket.trades + cfg.smoothingAlpha + cfg.smoothingBeta);
  return {
    key,
    trades: bucket.trades,
    wins: bucket.wins,
    losses: bucket.losses,
    smoothedWinRate,
    avgR: bucket.rCount > 0 ? bucket.rSum / bucket.rCount : null,
  };
}

/**
 * Aggregate outcome rows into bucket stats across all hierarchy levels,
 * plus a global bucket. Rows without a usable win/loss signal are skipped.
 */
export function aggregateOutcomes(
  rows: readonly OutcomeRow[],
  builtAt: number,
  cfg: AdvisorThresholds = ADVISOR,
): AdvisorSnapshot {
  const buckets = new Map<string, MutableBucket>();
  const global = emptyBucket();
  let usable = 0;

  for (const row of rows) {
    const win = isWin(row);
    if (win === null) continue;
    usable += 1;
    addRow(global, row, win);
    for (const key of bucketKeysFor({
      pattern: row.pattern,
      side: row.side,
      regime: row.regime,
      interval: row.timeframe,
    })) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = emptyBucket();
        buckets.set(key, bucket);
      }
      addRow(bucket, row, win);
    }
  }

  const finalized = new Map<string, BucketStats>();
  for (const [key, bucket] of buckets) {
    finalized.set(key, finalize(key, bucket, cfg));
  }

  return {
    buckets: finalized,
    global: usable > 0 ? finalize("*", global, cfg) : null,
    builtAt,
    sampleSize: usable,
  };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate a setup against the snapshot. Picks the most specific bucket with
 * trades ≥ minSample; no qualifying bucket (or null snapshot) → pass-through.
 *
 * Verdict policy (risk-reduction only):
 *   veto   — smoothedWinRate < vetoWinRate AND avgR ≤ 0
 *   dampen — smoothedWinRate < dampenWinRate
 *   allow  — otherwise
 */
export function evaluateSetup(
  dims: SetupDims | null,
  snapshot: AdvisorSnapshot | null,
  cfg: AdvisorThresholds = ADVISOR,
): AdvisorVerdict {
  if (!dims || !snapshot) return PASS_THROUGH;

  let chosen: BucketStats | null = null;
  for (const key of bucketKeysFor(dims)) {
    const bucket = snapshot.buckets.get(key);
    if (bucket && bucket.trades >= cfg.minSample) {
      chosen = bucket;
      break;
    }
  }
  if (!chosen) return PASS_THROUGH;

  const wr = chosen.smoothedWinRate;
  const pct = (wr * 100).toFixed(0);
  const rTxt = chosen.avgR !== null ? `, avgR ${chosen.avgR.toFixed(2)}` : "";
  const base = `bucket ${chosen.key}: ${chosen.trades} trades, winRate ${pct}%${rTxt}`;

  if (wr < cfg.vetoWinRate && chosen.avgR !== null && chosen.avgR <= 0) {
    return {
      action: "veto",
      sizeMultiplier: 1,
      bucketKey: chosen.key,
      sampleSize: chosen.trades,
      reason: `veto — ${base}`,
    };
  }

  if (wr < cfg.dampenWinRate) {
    return {
      action: "dampen",
      sizeMultiplier: cfg.dampenSizeMultiplier,
      bucketKey: chosen.key,
      sampleSize: chosen.trades,
      reason: `dampen ×${cfg.dampenSizeMultiplier} — ${base}`,
    };
  }

  return {
    action: "allow",
    sizeMultiplier: 1,
    bucketKey: chosen.key,
    sampleSize: chosen.trades,
    reason: `allow — ${base}`,
  };
}

/** Snapshot freshness gate — stale snapshots must not drive vetoes. */
export function isSnapshotFresh(
  snapshot: AdvisorSnapshot | null,
  now: number,
  cfg: AdvisorThresholds = ADVISOR,
): boolean {
  return snapshot !== null && now - snapshot.builtAt <= cfg.staleAfterMs;
}
