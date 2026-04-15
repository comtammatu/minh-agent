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

// ── Registry (strategy interface + fan-out) ─────────────────────────────────
export {
  getStrategyRegistry,
  resetStrategyRegistry,
  type IStrategy,
  type StrategyRegistry,
} from './registry.js'

// ── Diagnostics (pipeline stats) ────────────────────────────────────────────
export {
  type PipelineStats,
  formatPipelineStats,
  getPipelineStats,
  getPipelineStatsMap,
  resetPipelineStats,
} from './diagnostics.js'
