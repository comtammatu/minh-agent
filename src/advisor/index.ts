/**
 * Advisor — pre-entry bucket stats from trade_journal.
 *
 * Pure core: stats.ts, insights.ts (on-demand generation).
 * I/O edge: cache.ts (snapshot refresh).
 */

export { getAdvisorCache, resetAdvisorCache } from "./cache.js";
export { generateInsights, insightImportance } from "./insights.js";
export { aggregateOutcomes, evaluateSetup, isSnapshotFresh } from "./stats.js";
export type { AdvisorSnapshot, OutcomeRow, SetupDims } from "./types.js";
