/**
 * Advisor — learning loop v1 public API.
 *
 * Pure core: stats.ts (aggregation + evaluation), insights.ts (generation).
 * I/O edges: cache.ts (snapshot refresh), insights.ts runInsightJob.
 */

export { AdvisorStatsCache, getAdvisorCache, resetAdvisorCache } from "./cache.js";
export {
  generateInsights,
  insightImportance,
  runInsightJob,
} from "./insights.js";
export {
  aggregateOutcomes,
  bucketKeysFor,
  evaluateSetup,
  isSnapshotFresh,
} from "./stats.js";
export type {
  AdvisorAction,
  AdvisorSnapshot,
  AdvisorVerdict,
  BucketInsight,
  BucketStats,
  OutcomeRow,
  SetupDims,
} from "./types.js";
