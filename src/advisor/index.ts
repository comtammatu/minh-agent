/**
 * Advisor — learning loop v1 public API.
 *
 * Pure core: stats.ts (aggregation + evaluation), insights.ts (generation).
 * I/O edges: cache.ts (snapshot refresh), insights.ts runInsightJob.
 * Internals (bucket keys, verdict/insight shapes) are importable from their
 * source modules; this index exports only what runtime consumers use.
 */

export { getAdvisorCache, resetAdvisorCache } from "./cache.js";
export { runInsightJob } from "./insights.js";
export { aggregateOutcomes, evaluateSetup, isSnapshotFresh } from "./stats.js";
export type { AdvisorSnapshot, OutcomeRow, SetupDims } from "./types.js";
