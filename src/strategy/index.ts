/**
 * Strategy module — public API barrel export.
 *
 * External consumers import from 'strategy/index.js' only.
 * Internal files import directly from their source modules.
 */

// ── Diagnostics (pipeline stats) ────────────────────────────────────────────
export {
  formatPipelineStats,
  getPipelineStats,
  getPipelineStatsMap,
  type PipelineStats,
  resetPipelineStats,
} from "./diagnostics.js";

// ── Concrete setup generator ────────────────────────────────────────────────
export {
  clearSetupGeneratorState,
  getSetupGenerator,
  getSetupGeneratorWindowRequirements,
  resetSetupGenerator,
  runSetupGenerator,
  type SetupGenerator,
  setSetupGeneratorForTests,
  type WindowRequirements,
} from "./engine.js";
// ── Orchestrator (runtime state + WS dispatch) ──────────────────────────────
export {
  bootstrapReplayFromStore,
  clearCoinState,
  clearPipelineState,
  getActiveSetupCoins,
  getActiveSetups,
  getDecisionTraceByPositionId,
  getDecisionTraceBySetupId,
  getDecisionTraces,
  getDecisionTracesForCoin,
  getPipelineEmitter,
  getStatus,
  isInReplayMode,
  materializeCurrentSetupsFromStore,
  onCandleTick,
  recordDecisionTraceAgentAction,
  type StatusSnapshot,
  setReplayMode,
} from "./orchestrator.js";
