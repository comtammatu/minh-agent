/**
 * Pipeline diagnostic stats for the single active strategy scanner.
 */

export interface PipelineStats {
  /** Total closed candles processed (entered runPipeline). */
  totalTicks: number
  /** Passed Layer 1 — bias is non-neutral. */
  passL1Bias: number
  /** Passed Layer 2 — structure not deny. */
  passL2Structure: number
  /** Passed Layer 3 — zones non-empty. */
  passL3Zones: number
  /** Passed Layer 4+5 — trigger found (confirm→trigger chain). */
  passL5Trigger: number
  /** Passed confluence gate (grade B+). */
  passConfluence: number
  /** Passed risk filter. */
  passRisk: number
  /** Passed regime modifier (final confidence ≥ MIN_CONFIDENCE). */
  passRegime: number
  /** Setups tracked (signal fully qualified). */
  setupsTracked: number
  /** Setups invalidated. */
  setupsInvalidated: number
  /** Layer 3 detail: total zones before freshness filter. */
  l3ZonesTotal: number
  /** Layer 3 detail: zones after freshness filter. */
  l3ZonesFresh: number
  /** Layer 4 detail: zones at zone (isAtZone true). */
  l4ZonesAtZone: number
  /** Layer 4 detail: zones confirmed (boost threshold met). */
  l4ZonesConfirmed: number
  /** L5 detail: ticks with confirmed zones but no PA pattern at all. */
  l5NoPatternsDetected: number
  /** L5 detail: ticks with PA patterns but wrong direction (filtered by bias). */
  l5WrongDirection: number
  /** L5 rejection log: detailed info for each L4-pass L5-reject event. */
  l5Rejections: Array<{ coin: string; interval: string; idx: number; ts: number; patternsDetected: string[]; biasDir: string; confirmedCount: number }>
}

export function zeroPipelineStats(): PipelineStats {
  return {
    totalTicks: 0,
    passL1Bias: 0,
    passL2Structure: 0,
    passL3Zones: 0,
    passL5Trigger: 0,
    passConfluence: 0,
    passRisk: 0,
    passRegime: 0,
    setupsTracked: 0,
    setupsInvalidated: 0,
    l3ZonesTotal: 0,
    l3ZonesFresh: 0,
    l4ZonesAtZone: 0,
    l4ZonesConfirmed: 0,
    l5NoPatternsDetected: 0,
    l5WrongDirection: 0,
    l5Rejections: [],
  }
}

let pipelineStats = zeroPipelineStats()

/** Get the mutable stats bucket. */
export function getPipelineStatsMutable(): PipelineStats {
  return pipelineStats
}

/** Get pipeline stats snapshot. */
export function getPipelineStats(): PipelineStats {
  return { ...pipelineStats }
}

/** Backward-compatible snapshot map for UI/tests that still expect keyed access. */
export function getPipelineStatsMap(): Map<string, PipelineStats> {
  return new Map([['smc-sd', getPipelineStats()]])
}

/** Reset pipeline diagnostic stats. */
export function resetPipelineStats(): void {
  pipelineStats = zeroPipelineStats()
}

/** Format pipeline stats as a human-readable report. */
export function formatPipelineStats(stats: PipelineStats): string {
  const t = stats.totalTicks
  const pct = (n: number) => t > 0 ? `${(n / t * 100).toFixed(2)}%` : '0%'
  const lines = [
    '=== PIPELINE DIAGNOSTIC STATS ===',
    `Total ticks:         ${t}`,
    `L1 Bias pass:        ${stats.passL1Bias} (${pct(stats.passL1Bias)})`,
    `L2 Structure pass:   ${stats.passL2Structure} (${pct(stats.passL2Structure)})`,
    `L3 Zones pass:       ${stats.passL3Zones} (${pct(stats.passL3Zones)})`,
    `  L3 total zones:    ${stats.l3ZonesTotal}`,
    `  L3 fresh zones:    ${stats.l3ZonesFresh} (${stats.l3ZonesTotal > 0 ? (stats.l3ZonesFresh / stats.l3ZonesTotal * 100).toFixed(1) + '%' : '0%'} fresh)`,
    `  L4 zones at zone:  ${stats.l4ZonesAtZone}`,
    `  L4 zones confirmed:${stats.l4ZonesConfirmed}`,
    `L5 Trigger pass:     ${stats.passL5Trigger} (${pct(stats.passL5Trigger)})`,
    `  L5 no pattern:     ${stats.l5NoPatternsDetected}`,
    `  L5 wrong dir:      ${stats.l5WrongDirection}`,
    `Confluence pass:     ${stats.passConfluence} (${pct(stats.passConfluence)})`,
    `Risk pass:           ${stats.passRisk} (${pct(stats.passRisk)})`,
    `Regime pass:         ${stats.passRegime} (${pct(stats.passRegime)})`,
    `Setups tracked:      ${stats.setupsTracked}`,
    `Setups invalidated:  ${stats.setupsInvalidated}`,
    '=================================',
  ]
  return lines.join('\n')
}
