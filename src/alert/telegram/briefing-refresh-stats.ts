/**
 * Briefing Refresh Stats — in-memory tracking for scheduled briefing edits.
 *
 * Tracks outcomes (edited / skipped / coalesced / failed), derives health state,
 * and records incidents for operator visibility. Module-level state, same pattern
 * as feed/store.ts.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BriefingRefreshContext {
  coin: string | null
  positionId: string | null
  target: string | null
  attention: string | null
}

export type BriefingHealthState = 'healthy' | 'degraded' | 'critical'

export interface BriefingRefreshHealthSnapshot {
  state: BriefingHealthState
  editRatio: number
  samples: number
  failed: number
  failureStreak: number
  coalesced: number
  skippedIdentical: number
  coalescedStreak: number
  recoveredFrom: string | null
  recoveredCoin: string | null
  recoveredPositionId: string | null
  recoveredTarget: string | null
  recoveredAttention: string | null
  lastKind: string | null
  lastOutcome: string | null
  lastTarget: string | null
  lastAttention: string | null
  lastCoin: string | null
  lastPositionId: string | null
}

export interface BriefingRefreshHealthTransition {
  from: BriefingHealthState
  to: BriefingHealthState
  snapshot: BriefingRefreshHealthSnapshot
  target?: string | null
}

export interface BriefingRefreshIncident {
  status: 'active' | 'recovered'
  peakState: BriefingHealthState
  target: string | null
  transitions: Array<{ outcome: string }>
}

interface HistoryEntry {
  from: string
  to: string
  target: string | null
}

// ─── Module-level state ───────────────────────────────────────────────────────

let requested = 0
let edited = 0
let skippedIdentical = 0
let coalesced = 0
let failed = 0
let lastOutcome: string | null = null
let lastAtMs: number | null = null
let failureStreak = 0
let coalescedStreak = 0
let currentState: BriefingHealthState = 'healthy'

// Last context
let lastKind: string | null = null
let lastTarget: string | null = null
let lastAttention: string | null = null
let lastCoin: string | null = null
let lastPositionId: string | null = null

// Recovery tracking
let recoveredFrom: string | null = null
let recoveredCoin: string | null = null
let recoveredPositionId: string | null = null
let recoveredTarget: string | null = null
let recoveredAttention: string | null = null

const history: HistoryEntry[] = []
const incidents: BriefingRefreshIncident[] = []

// ─── Health derivation ────────────────────────────────────────────────────────

const DEGRADED_THRESHOLD = 3
const CRITICAL_THRESHOLD = 6

function deriveState(): BriefingHealthState {
  if (failureStreak >= CRITICAL_THRESHOLD || coalescedStreak >= CRITICAL_THRESHOLD) return 'critical'
  if (failureStreak >= DEGRADED_THRESHOLD || coalescedStreak >= DEGRADED_THRESHOLD) return 'degraded'
  return 'healthy'
}

function buildSnapshot(): BriefingRefreshHealthSnapshot {
  const samples = edited + skippedIdentical + coalesced + failed
  return {
    state: currentState,
    editRatio: samples > 0 ? edited / samples : 1,
    samples,
    failed,
    failureStreak,
    coalesced,
    skippedIdentical,
    coalescedStreak,
    recoveredFrom,
    recoveredCoin,
    recoveredPositionId,
    recoveredTarget,
    recoveredAttention,
    lastKind,
    lastOutcome,
    lastTarget,
    lastAttention,
    lastCoin,
    lastPositionId,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getBriefingRefreshStats(): {
  edited: number
  skippedIdentical: number
  coalesced: number
  lastOutcome: string | null
  requested: number
  failed: number
  lastAt: number | null
  lastKind: string | null
} {
  return { edited, skippedIdentical, coalesced, lastOutcome, requested, failed, lastAt: lastAtMs, lastKind }
}

export function getBriefingRefreshHealth(): BriefingRefreshHealthSnapshot {
  return buildSnapshot()
}

export function getBriefingRefreshHistory(limit = 10): HistoryEntry[] {
  return history.slice(-limit)
}

export function getBriefingRefreshIncidents(limit = 10): BriefingRefreshIncident[] {
  return incidents.slice(-limit)
}

export function recordBriefingRefreshRequested(): void {
  requested += 1
}

export function recordBriefingRefreshOutcome(
  outcome: 'coalesced' | 'skipped_identical' | 'edited' | 'failed',
  _key: string,
  kind: 'morning' | 'evening' | 'live',
  context?: BriefingRefreshContext,
): BriefingRefreshHealthTransition | null {
  lastOutcome = outcome
  lastAtMs = Date.now()
  lastKind = kind
  if (context != null) {
    lastTarget = context.target
    lastAttention = context.attention
    lastCoin = context.coin
    lastPositionId = context.positionId
  }

  switch (outcome) {
    case 'edited':
      edited += 1
      failureStreak = 0
      coalescedStreak = 0
      break
    case 'skipped_identical':
      skippedIdentical += 1
      failureStreak = 0
      coalescedStreak = 0
      break
    case 'coalesced':
      coalesced += 1
      coalescedStreak += 1
      failureStreak = 0
      break
    case 'failed':
      failed += 1
      failureStreak += 1
      coalescedStreak = 0
      break
  }

  const prev = currentState
  const next = deriveState()
  if (prev === next) return null

  // State changed — record transition
  currentState = next

  // Track recovery
  if (next === 'healthy' && prev !== 'healthy') {
    recoveredFrom = prev
    recoveredCoin = lastCoin
    recoveredPositionId = lastPositionId
    recoveredTarget = lastTarget
    recoveredAttention = lastAttention
  } else if (next !== 'healthy') {
    recoveredFrom = null
    recoveredCoin = null
    recoveredPositionId = null
    recoveredTarget = null
    recoveredAttention = null
  }

  const snapshot = buildSnapshot()
  const transition: BriefingRefreshHealthTransition = {
    from: prev,
    to: next,
    snapshot,
    target: lastTarget,
  }

  history.push({ from: prev, to: next, target: lastTarget })

  // Incident tracking
  if (next !== 'healthy' && prev === 'healthy') {
    incidents.push({
      status: 'active',
      peakState: next,
      target: lastTarget,
      transitions: [{ outcome }],
    })
  } else if (next === 'healthy' && prev !== 'healthy') {
    const active = [...incidents].reverse().find((i: BriefingRefreshIncident) => i.status === 'active')
    if (active != null) {
      active.status = 'recovered'
      active.transitions.push({ outcome })
    }
  } else {
    const active = [...incidents].reverse().find((i: BriefingRefreshIncident) => i.status === 'active')
    if (active != null) {
      if (next === 'critical' && active.peakState !== 'critical') {
        active.peakState = 'critical'
      }
      active.transitions.push({ outcome })
    }
  }

  return transition
}

export function resetBriefingRefreshStats(): void {
  requested = 0
  edited = 0
  skippedIdentical = 0
  coalesced = 0
  failed = 0
  lastOutcome = null
  lastAtMs = null
  failureStreak = 0
  coalescedStreak = 0
  currentState = 'healthy'
  lastKind = null
  lastTarget = null
  lastAttention = null
  lastCoin = null
  lastPositionId = null
  recoveredFrom = null
  recoveredCoin = null
  recoveredPositionId = null
  recoveredTarget = null
  recoveredAttention = null
  history.length = 0
  incidents.length = 0
}
