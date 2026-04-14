export type BriefingRefreshKind = 'morning' | 'evening' | 'live'
export type BriefingRefreshOutcome = 'coalesced' | 'skipped_identical' | 'edited' | 'failed'
export type BriefingRefreshHealthState = 'healthy' | 'degraded' | 'critical'

export interface BriefingRefreshHealthSnapshot {
  state: BriefingRefreshHealthState
  samples: number
  requested: number
  edited: number
  failed: number
  coalesced: number
  skippedIdentical: number
  editRatio: number
  failureStreak: number
  coalescedStreak: number
  lastOutcome: BriefingRefreshOutcome | null
  lastKey: string | null
  lastKind: BriefingRefreshKind | null
  lastAt: number | null
  lastCoin: string | null
  lastPositionId: string | null
  lastTarget: string | null
  lastAttention: string | null
  recoveredFrom: Exclude<BriefingRefreshHealthState, 'healthy'> | null
  recoveredAt: number | null
  recoveredCoin: string | null
  recoveredPositionId: string | null
  recoveredTarget: string | null
  recoveredAttention: string | null
}

export interface BriefingRefreshHealthTransition {
  from: BriefingRefreshHealthState
  to: BriefingRefreshHealthState
  snapshot: BriefingRefreshHealthSnapshot
}

export interface BriefingRefreshHistoryEntry {
  ts: number
  from: BriefingRefreshHealthState
  to: BriefingRefreshHealthState
  kind: BriefingRefreshKind | null
  outcome: BriefingRefreshOutcome | null
  coin: string | null
  positionId: string | null
  target: string | null
  attention: string | null
}

export interface BriefingRefreshIncident {
  startedAt: number
  resolvedAt: number | null
  target: string | null
  attention: string | null
  peakState: Exclude<BriefingRefreshHealthState, 'healthy'>
  status: 'active' | 'recovered'
  transitions: readonly BriefingRefreshHistoryEntry[]
}

interface BriefingRefreshStatsState {
  requested: number
  coalesced: number
  skippedIdentical: number
  edited: number
  failed: number
  lastOutcome: BriefingRefreshOutcome | null
  lastKey: string | null
  lastKind: BriefingRefreshKind | null
  lastAt: number | null
  lastCoin: string | null
  lastPositionId: string | null
  lastTarget: string | null
  lastAttention: string | null
  recoveredFrom: Exclude<BriefingRefreshHealthState, 'healthy'> | null
  recoveredAt: number | null
  recoveredCoin: string | null
  recoveredPositionId: string | null
  recoveredTarget: string | null
  recoveredAttention: string | null
}

export interface BriefingRefreshContext {
  coin?: string | null
  positionId?: string | null
  target?: string | null
  attention?: string | null
}

const BRIEFING_REFRESH_HISTORY_LIMIT = 8
const BRIEFING_REFRESH_MIN_SAMPLES_FOR_DEGRADED = 4
const BRIEFING_REFRESH_MIN_SAMPLES_FOR_CRITICAL = 5
const BRIEFING_REFRESH_MIN_FAILED_FOR_CRITICAL = 2
const BRIEFING_REFRESH_MIN_FAILED_FOR_DEGRADED = 1
const BRIEFING_REFRESH_MIN_COALESCED_STREAK_FOR_DEGRADED = 2
const BRIEFING_REFRESH_MIN_COALESCED_STREAK_FOR_CRITICAL = 4
const BRIEFING_REFRESH_MIN_COALESCED_FOR_CRITICAL = 3
const BRIEFING_REFRESH_MAX_EDIT_RATIO_FOR_DEGRADED = 0.5
const BRIEFING_REFRESH_MAX_EDIT_RATIO_FOR_CRITICAL = 0.25
const BRIEFING_HEALTH_TRANSITION_HISTORY_LIMIT = 8

const stats: BriefingRefreshStatsState = {
  requested: 0,
  coalesced: 0,
  skippedIdentical: 0,
  edited: 0,
  failed: 0,
  lastOutcome: null,
  lastKey: null,
  lastKind: null,
  lastAt: null,
  lastCoin: null,
  lastPositionId: null,
  lastTarget: null,
  lastAttention: null,
  recoveredFrom: null,
  recoveredAt: null,
  recoveredCoin: null,
  recoveredPositionId: null,
  recoveredTarget: null,
  recoveredAttention: null,
}
const recentOutcomes: BriefingRefreshOutcome[] = []
const transitionHistory: BriefingRefreshHistoryEntry[] = []
let currentHealthState: BriefingRefreshHealthState = 'healthy'

function pushRecentOutcome(outcome: BriefingRefreshOutcome): void {
  recentOutcomes.push(outcome)
  if (recentOutcomes.length > BRIEFING_REFRESH_HISTORY_LIMIT) {
    recentOutcomes.shift()
  }
}

function countRecentOutcomes(outcome: BriefingRefreshOutcome): number {
  return recentOutcomes.filter(item => item === outcome).length
}

function countTrailingOutcomes(
  predicate: (outcome: BriefingRefreshOutcome) => boolean,
): number {
  let total = 0
  for (let index = recentOutcomes.length - 1; index >= 0; index -= 1) {
    const outcome = recentOutcomes[index]!
    if (!predicate(outcome)) break
    total += 1
  }
  return total
}

function buildHealthSnapshot(state: BriefingRefreshHealthState): BriefingRefreshHealthSnapshot {
  const samples = recentOutcomes.length
  const editRatio = samples === 0 ? 1 : stats.edited / samples

  return {
    state,
    samples,
    requested: stats.requested,
    edited: stats.edited,
    failed: stats.failed,
    coalesced: stats.coalesced,
    skippedIdentical: stats.skippedIdentical,
    editRatio,
    failureStreak: countTrailingOutcomes(outcome => outcome === 'failed'),
    coalescedStreak: countTrailingOutcomes(outcome => outcome === 'coalesced'),
    lastOutcome: stats.lastOutcome,
    lastKey: stats.lastKey,
    lastKind: stats.lastKind,
    lastAt: stats.lastAt,
    lastCoin: stats.lastCoin,
    lastPositionId: stats.lastPositionId,
    lastTarget: stats.lastTarget,
    lastAttention: stats.lastAttention,
    recoveredFrom: stats.recoveredFrom,
    recoveredAt: stats.recoveredAt,
    recoveredCoin: stats.recoveredCoin,
    recoveredPositionId: stats.recoveredPositionId,
    recoveredTarget: stats.recoveredTarget,
    recoveredAttention: stats.recoveredAttention,
  }
}

function pushTransitionHistory(transition: BriefingRefreshHealthTransition): void {
  const snapshot = transition.snapshot
  const target =
    transition.to === 'healthy' && snapshot.recoveredFrom != null
      ? snapshot.recoveredTarget
      : snapshot.lastTarget
  const attention =
    transition.to === 'healthy' && snapshot.recoveredFrom != null
      ? snapshot.recoveredAttention
      : snapshot.lastAttention
  const coin =
    transition.to === 'healthy' && snapshot.recoveredFrom != null
      ? snapshot.recoveredCoin
      : snapshot.lastCoin
  const positionId =
    transition.to === 'healthy' && snapshot.recoveredFrom != null
      ? snapshot.recoveredPositionId
      : snapshot.lastPositionId

  transitionHistory.push({
    ts: snapshot.lastAt ?? Date.now(),
    from: transition.from,
    to: transition.to,
    kind: snapshot.lastKind,
    outcome: snapshot.lastOutcome,
    coin,
    positionId,
    target,
    attention,
  })

  if (transitionHistory.length > BRIEFING_HEALTH_TRANSITION_HISTORY_LIMIT) {
    transitionHistory.shift()
  }
}

function evaluateBriefingRefreshHealth(): BriefingRefreshHealthState {
  const samples = recentOutcomes.length
  if (samples < BRIEFING_REFRESH_MIN_SAMPLES_FOR_DEGRADED) {
    return 'healthy'
  }

  const failed = countRecentOutcomes('failed')
  const coalesced = countRecentOutcomes('coalesced')
  const editRatio = stats.edited / samples
  const failureStreak = countTrailingOutcomes(outcome => outcome === 'failed')
  const coalescedStreak = countTrailingOutcomes(outcome => outcome === 'coalesced')

  if (
    samples >= BRIEFING_REFRESH_MIN_SAMPLES_FOR_CRITICAL &&
    (
      failureStreak >= BRIEFING_REFRESH_MIN_FAILED_FOR_CRITICAL ||
      failed >= BRIEFING_REFRESH_MIN_FAILED_FOR_CRITICAL + 1 ||
      coalescedStreak >= BRIEFING_REFRESH_MIN_COALESCED_STREAK_FOR_CRITICAL ||
      (failed + coalesced >= BRIEFING_REFRESH_MIN_COALESCED_FOR_CRITICAL &&
        editRatio <= BRIEFING_REFRESH_MAX_EDIT_RATIO_FOR_CRITICAL)
    )
  ) {
    return 'critical'
  }

  if (
    failureStreak >= BRIEFING_REFRESH_MIN_FAILED_FOR_DEGRADED ||
    coalescedStreak >= BRIEFING_REFRESH_MIN_COALESCED_STREAK_FOR_DEGRADED ||
    (stats.requested >= BRIEFING_REFRESH_MIN_SAMPLES_FOR_DEGRADED &&
      editRatio < BRIEFING_REFRESH_MAX_EDIT_RATIO_FOR_DEGRADED &&
      failed + coalesced >= BRIEFING_REFRESH_MIN_FAILED_FOR_DEGRADED + 1)
  ) {
    return 'degraded'
  }

  return 'healthy'
}

export function recordBriefingRefreshRequested(): void {
  stats.requested += 1
}

export function recordBriefingRefreshOutcome(
  outcome: BriefingRefreshOutcome,
  key: string,
  kind: BriefingRefreshKind,
  context?: BriefingRefreshContext,
): BriefingRefreshHealthTransition | null {
  const previousSnapshot = buildHealthSnapshot(currentHealthState)

  if (outcome === 'coalesced') stats.coalesced += 1
  if (outcome === 'skipped_identical') stats.skippedIdentical += 1
  if (outcome === 'edited') stats.edited += 1
  if (outcome === 'failed') stats.failed += 1
  stats.lastOutcome = outcome
  stats.lastKey = key
  stats.lastKind = kind
  stats.lastAt = Date.now()
  if (context?.coin !== undefined) stats.lastCoin = context.coin?.trim().toUpperCase() ?? null
  if (context?.positionId !== undefined) stats.lastPositionId = context.positionId ?? null
  if (context?.target !== undefined) stats.lastTarget = context.target
  if (context?.attention !== undefined) stats.lastAttention = context.attention
  pushRecentOutcome(outcome)

  const nextHealthState = evaluateBriefingRefreshHealth()
  if (nextHealthState !== 'healthy') {
    stats.recoveredFrom = null
    stats.recoveredAt = null
    stats.recoveredCoin = null
    stats.recoveredPositionId = null
    stats.recoveredTarget = null
    stats.recoveredAttention = null
  } else if (currentHealthState !== 'healthy' && nextHealthState === 'healthy') {
    stats.recoveredFrom = currentHealthState
    stats.recoveredAt = stats.lastAt
    stats.recoveredCoin = previousSnapshot.lastCoin
    stats.recoveredPositionId = previousSnapshot.lastPositionId
    stats.recoveredTarget = previousSnapshot.lastTarget
    stats.recoveredAttention = previousSnapshot.lastAttention
  }
  if (nextHealthState === currentHealthState) return null

  const transition: BriefingRefreshHealthTransition = {
    from: currentHealthState,
    to: nextHealthState,
    snapshot: buildHealthSnapshot(nextHealthState),
  }
  pushTransitionHistory(transition)
  currentHealthState = nextHealthState
  return transition
}

export function getBriefingRefreshStats(): Readonly<BriefingRefreshStatsState> {
  return { ...stats }
}

export function getBriefingRefreshHealth(): Readonly<BriefingRefreshHealthSnapshot> {
  return buildHealthSnapshot(currentHealthState)
}

export function getBriefingRefreshHistory(limit = 3): readonly BriefingRefreshHistoryEntry[] {
  if (limit <= 0) return []
  return transitionHistory.slice(-limit).reverse()
}

export function getBriefingRefreshIncidents(limit = 2): readonly BriefingRefreshIncident[] {
  if (limit <= 0 || transitionHistory.length === 0) return []

  const incidents: BriefingRefreshIncident[] = []
  let current: {
    startedAt: number
    target: string | null
    attention: string | null
    peakState: Exclude<BriefingRefreshHealthState, 'healthy'>
    transitions: BriefingRefreshHistoryEntry[]
  } | null = null

  for (const entry of transitionHistory) {
    const nextState =
      entry.to === 'healthy'
        ? (entry.from === 'critical' ? 'critical' : 'degraded')
        : entry.to

    if (current == null && entry.to !== 'healthy') {
      current = {
        startedAt: entry.ts,
        target: entry.target,
        attention: entry.attention,
        peakState: nextState,
        transitions: [],
      }
    }

    if (current == null && entry.to === 'healthy') {
      current = {
        startedAt: entry.ts,
        target: entry.target,
        attention: entry.attention,
        peakState: entry.from === 'critical' ? 'critical' : 'degraded',
        transitions: [],
      }
    }

    if (current == null) continue

    current.transitions.push(entry)
    if (entry.target != null) current.target = entry.target
    if (entry.attention != null) current.attention = entry.attention
    if (entry.from === 'critical' || entry.to === 'critical') current.peakState = 'critical'

    if (entry.to === 'healthy') {
      incidents.push({
        startedAt: current.startedAt,
        resolvedAt: entry.ts,
        target: current.target,
        attention: current.attention,
        peakState: current.peakState,
        status: 'recovered',
        transitions: [...current.transitions],
      })
      current = null
    }
  }

  if (current != null) {
    incidents.push({
      startedAt: current.startedAt,
      resolvedAt: null,
      target: current.target,
      attention: current.attention,
      peakState: current.peakState,
      status: 'active',
      transitions: [...current.transitions],
    })
  }

  return incidents.slice(-limit).reverse()
}

export function resetBriefingRefreshStats(): void {
  stats.requested = 0
  stats.coalesced = 0
  stats.skippedIdentical = 0
  stats.edited = 0
  stats.failed = 0
  stats.lastOutcome = null
  stats.lastKey = null
  stats.lastKind = null
  stats.lastAt = null
  stats.lastCoin = null
  stats.lastPositionId = null
  stats.lastTarget = null
  stats.lastAttention = null
  stats.recoveredFrom = null
  stats.recoveredAt = null
  stats.recoveredCoin = null
  stats.recoveredPositionId = null
  stats.recoveredTarget = null
  stats.recoveredAttention = null
  recentOutcomes.length = 0
  transitionHistory.length = 0
  currentHealthState = 'healthy'
}
