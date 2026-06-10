/**
 * Insight generation — periodic learning job.
 *
 * Pure part: compare bucket stats against the global baseline and emit
 * insights for buckets that deviate meaningfully. I/O part: write deduped
 * pattern_insight memories + prune stale memories.
 */

import { ADVISOR, MEMORY_RETENTION_DAYS } from "../config.js";
import { log } from "../lib/logger.js";
import { insertMemory, pruneMemories, queryMemories } from "../memory/index.js";
import type { AdvisorThresholds } from "./stats.js";
import type { AdvisorSnapshot, BucketInsight } from "./types.js";

/** Insight importance grows with deviation, capped below high-R trade memories. */
const INSIGHT_BASE_IMPORTANCE = 0.5;
const INSIGHT_MAX_IMPORTANCE = 0.85;

// ─── Pure ────────────────────────────────────────────────────────────────────

/**
 * Find buckets whose smoothed win rate deviates from the global baseline by
 * at least insightMinWinRateDelta, with enough samples to be meaningful.
 * All hierarchy levels are reported; per-bucket dedupe happens at write time.
 */
export function generateInsights(
  snapshot: AdvisorSnapshot | null,
  cfg: AdvisorThresholds = ADVISOR,
): BucketInsight[] {
  if (!snapshot?.global) return [];
  const globalWr = snapshot.global.smoothedWinRate;

  const qualifying: BucketInsight[] = [];
  for (const [key, stats] of snapshot.buckets) {
    if (stats.trades < cfg.minSample) continue;
    const delta = stats.smoothedWinRate - globalWr;
    if (Math.abs(delta) < cfg.insightMinWinRateDelta) continue;
    const direction = delta > 0 ? "outperforms" : "underperforms";
    const wrPct = (stats.smoothedWinRate * 100).toFixed(0);
    const globalPct = (globalWr * 100).toFixed(0);
    const rTxt = stats.avgR !== null ? `, avgR ${stats.avgR.toFixed(2)}` : "";
    qualifying.push({
      bucketKey: key,
      trades: stats.trades,
      smoothedWinRate: stats.smoothedWinRate,
      avgR: stats.avgR,
      winRateDelta: delta,
      content: `Bucket ${key} ${direction} baseline: winRate ${wrPct}% vs global ${globalPct}% over ${stats.trades} trades${rTxt}`,
    });
  }

  return qualifying.sort(
    (a, b) => Math.abs(b.winRateDelta) - Math.abs(a.winRateDelta),
  );
}

export function insightImportance(insight: BucketInsight): number {
  return Math.min(
    INSIGHT_MAX_IMPORTANCE,
    INSIGHT_BASE_IMPORTANCE + Math.abs(insight.winRateDelta),
  );
}

// ─── I/O edge ────────────────────────────────────────────────────────────────

/**
 * Write pattern_insight memories for qualifying buckets, skipping buckets
 * that already received an insight within the current job interval, then
 * prune stale memories. Never throws.
 */
export async function runInsightJob(
  snapshot: AdvisorSnapshot | null,
  cfg: AdvisorThresholds = ADVISOR,
): Promise<number> {
  try {
    const insights = generateInsights(snapshot, cfg);
    if (insights.length === 0) {
      await pruneMemories(MEMORY_RETENTION_DAYS);
      return 0;
    }

    const since = new Date(Date.now() - cfg.insightIntervalMs);
    let written = 0;
    for (const insight of insights) {
      const existing = await queryMemories({
        category: "pattern_insight",
        pattern: insight.bucketKey,
        since,
        limit: 1,
      });
      if (existing.length > 0) continue;

      await insertMemory({
        category: "pattern_insight",
        pattern: insight.bucketKey,
        content: insight.content,
        metadata: {
          bucketKey: insight.bucketKey,
          trades: insight.trades,
          smoothedWinRate: insight.smoothedWinRate,
          avgR: insight.avgR,
          winRateDelta: insight.winRateDelta,
        },
        importance: insightImportance(insight),
      });
      written += 1;
    }

    if (written > 0) {
      log.info(
        "advisor",
        `Insight job: ${written} pattern_insight memories written`,
      );
    }
    await pruneMemories(MEMORY_RETENTION_DAYS);
    return written;
  } catch (err) {
    log.error("advisor", `Insight job failed: ${(err as Error).message}`);
    return 0;
  }
}
