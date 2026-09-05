/**
 * Insight generation — pure comparison of bucket stats vs global baseline.
 */
import type { AdvisorThresholds } from "./stats.js";
import { ADVISOR } from "../config.js";
import type { AdvisorSnapshot, BucketInsight } from "./types.js";

const INSIGHT_BASE_IMPORTANCE = 0.5;
const INSIGHT_MAX_IMPORTANCE = 0.85;

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
