/**
 * Active Thesis Monitor — re-evaluate trade thesis during open positions.
 *
 * Pure functions. Zero I/O. Zero side effects.
 *
 * Entry thesis (multi-TF regime + bias) is captured at trade open.
 * On each evaluation, current regime/bias is compared against entry state.
 * Deterioration score drives protective actions:
 *   aligned  (< 0.3): hold — thesis intact
 *   minor    (0.3–0.5): alert only
 *   moderate (0.5–0.8): move SL to breakeven
 *   severe   (>= 0.8): close position immediately
 */

import type { CandleInterval, MarketRegime } from '../types.js'
import type {
  MonitorAction,
  PositionState,
  ThesisEvaluation,
  ThesisTFSnapshot,
  TradeThesis,
} from './types.js'
import { THESIS_MONITOR } from '../config.js'

// ─── Capture ────────────────────────────────────────────────────────────────

/** Wrap per-TF snapshots into a TradeThesis struct at entry time. */
export function captureThesis(
  side: 'long' | 'short',
  entryInterval: CandleInterval,
  snapshots: ThesisTFSnapshot[],
): TradeThesis {
  return {
    entryInterval,
    side,
    snapshots: snapshots.map(s => ({ ...s })),
    capturedAt: Date.now(),
  }
}

// ─── Evaluate ───────────────────────────────────────────────────────────────

/** Is this regime opposed to the trade side? */
function regimeScore(side: 'long' | 'short', regime: MarketRegime): number {
  const opposed = side === 'long' ? 'BEAR' : 'BULL'
  if (regime === opposed) return 0.5
  if (regime === 'SIDEWAYS' || regime === 'VOLATILE') return 0.25
  return 0  // aligned
}

/** Is this bias opposed to the trade side? */
function biasScore(side: 'long' | 'short', bias: string): number {
  const opposed = side === 'long' ? 'short' : 'long'
  if (bias === opposed) return 0.5
  if (bias === 'neutral') return 0.25
  return 0  // aligned
}

/**
 * Compare entry thesis against current market state.
 *
 * Per-TF scoring (2 dimensions):
 *   regime: aligned=0, neutral=0.25, opposed=0.5
 *   bias:   aligned=0, neutral=0.25, opposed=0.5
 *
 * Weight: entry TF = 1.0, each HTF = config.htfWeight (default 2.0).
 * Total = sum(perTfScore * weight) / sum(weights), normalized [0, 1].
 */
export function evaluateThesis(
  thesis: TradeThesis,
  currentSnapshots: ThesisTFSnapshot[],
  config: typeof THESIS_MONITOR = THESIS_MONITOR,
): ThesisEvaluation {
  const details: ThesisEvaluation['details'] = []
  let totalScore = 0
  let totalWeight = 0

  for (const entrySnap of thesis.snapshots) {
    const current = currentSnapshots.find(s => s.interval === entrySnap.interval)
    if (!current) continue

    const weight = entrySnap.interval === thesis.entryInterval ? 1.0 : config.htfWeight
    const rScore = regimeScore(thesis.side, current.regime)
    const bScore = biasScore(thesis.side, current.bias)
    const contribution = (rScore + bScore) * weight

    totalScore += contribution
    totalWeight += weight

    details.push({
      interval: entrySnap.interval,
      entryRegime: entrySnap.regime,
      currentRegime: current.regime,
      entryBias: entrySnap.bias,
      currentBias: current.bias,
      contribution,
    })
  }

  // Normalize to [0, 1]
  const score = totalWeight > 0 ? Math.min(totalScore / totalWeight, 1.0) : 0

  let severity: ThesisEvaluation['severity']
  if (score >= config.severeThreshold) severity = 'severe'
  else if (score >= config.moderateThreshold) severity = 'moderate'
  else if (score >= config.minorThreshold) severity = 'minor'
  else severity = 'aligned'

  return { score, severity, details }
}

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * Convert thesis evaluation into MonitorAction[].
 * Reuses existing action types — no new action variants.
 */
export function thesisToActions(
  evaluation: ThesisEvaluation,
  position: PositionState,
  config: typeof THESIS_MONITOR = THESIS_MONITOR,
): MonitorAction[] {
  switch (evaluation.severity) {
    case 'aligned':
      return []

    case 'minor':
      return [{
        type: 'alert',
        positionId: position.positionId,
        message: `Thesis minor deterioration: score=${evaluation.score.toFixed(2)} — ${formatDetails(evaluation)}`,
      }]

    case 'moderate': {
      // Move SL to breakeven if not already there or better
      const slAlreadyProtected = position.side === 'long'
        ? position.slPrice >= position.entryPrice
        : position.slPrice <= position.entryPrice
      if (slAlreadyProtected) {
        return [{
          type: 'alert',
          positionId: position.positionId,
          message: `Thesis moderate deterioration: score=${evaluation.score.toFixed(2)} (SL already protected)`,
        }]
      }
      return [{
        type: 'trail_update',
        positionId: position.positionId,
        newSlPrice: position.entryPrice,
      }]
    }

    case 'severe':
      return [{
        type: 'close',
        positionId: position.positionId,
        reason: `thesis_deteriorated (score=${evaluation.score.toFixed(2)}) — ${formatDetails(evaluation)}`,
      }]
  }
}

/** Format evaluation details for log messages. */
function formatDetails(evaluation: ThesisEvaluation): string {
  return evaluation.details
    .map(d => `${d.interval}:${d.currentRegime}/${d.currentBias}`)
    .join(', ')
}

// ─── Cooldown ───────────────────────────────────────────────────────────────

/** Check if enough time has passed since last thesis evaluation. */
export function shouldCheckThesis(
  position: PositionState,
  now: number,
  entryTfMs: number,
  config: typeof THESIS_MONITOR = THESIS_MONITOR,
): boolean {
  if (!config.enabled) return false
  if (!position.thesis) return false
  const cooldown = entryTfMs * config.cooldownMultiplier
  return now - position.lastThesisCheckAt >= cooldown
}
