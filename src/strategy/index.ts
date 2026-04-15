/**
 * Strategy module — public API barrel export.
 *
 * External consumers import from 'strategy/index.js' only.
 * Internal files import directly from their source modules.
 */

// ── Orchestrator (runtime state + WS dispatch) ──────────────────────────────
export {
  onCandleTick,
  getStatus,
  getActiveSetups,
  getActiveSetupCoins,
  clearPipelineState,
  clearCoinState,
  getPipelineEmitter,
  type StatusSnapshot,
  getDecisionTraces,
  getDecisionTracesForCoin,
  getDecisionTraceByPositionId,
  getDecisionTraceBySetupId,
  recordDecisionTraceAgentAction,
} from './orchestrator.js'

// ── Concrete setup generator ────────────────────────────────────────────────
export {
  getSetupGenerator,
  getSetupGeneratorMinCandles,
  getSetupGeneratorWindowRequirements,
  runSetupGenerator,
  clearSetupGeneratorState,
  resetSetupGenerator,
  setSetupGeneratorForTests,
  type SetupGenerator,
  type WindowRequirements,
} from './engine.js'

// ── Diagnostics (pipeline stats) ────────────────────────────────────────────
export {
  type PipelineStats,
  formatPipelineStats,
  getPipelineStats,
  getPipelineStatsMap,
  resetPipelineStats,
} from './diagnostics.js'
