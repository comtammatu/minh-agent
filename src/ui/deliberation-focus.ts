import type { ActiveSetup, DecisionTrace } from '../types.js'

export interface DeliberationPositionRef {
  positionId?: string
  coin: string
  side: 'long' | 'short'
  strategyId: string
}

export type DeliberationFocus =
  | { kind: 'auto' }
  | { kind: 'position'; positionId: string }
  | { kind: 'setup'; setupId: string }

export interface DeliberationFocusSlot {
  digit: string
  focus: DeliberationFocus
  label: string
}

export interface FocusAwareOperatorAuditEntry {
  ts: number
  action: string
  target: string
  status: 'armed' | 'submitted' | 'failed'
  coin?: string | null
  strategyId?: string | null
  positionId?: string | null
}

interface BriefingHealthTarget {
  state?: 'healthy' | 'degraded' | 'critical'
  lastCoin?: string | null
  lastPositionId?: string | null
  recoveredCoin?: string | null
  recoveredPositionId?: string | null
}

export function tracePriority(trace: DecisionTrace): number {
  let score = 0
  if (trace.strategyId !== 'system') score += 100
  if (trace.outcome.action === 'enter') score += 60
  if (trace.outcome.action === 'watch') score += 40
  if (trace.roles.judge?.verdict === 'approve') score += 20
  score += Math.round(trace.outcome.confidence * 100)
  return score
}

export function pickDecisionTrace(traces: DecisionTrace[]): DecisionTrace | null {
  if (traces.length === 0) return null
  return [...traces].sort((a, b) => {
    const prioDiff = tracePriority(b) - tracePriority(a)
    if (prioDiff !== 0) return prioDiff
    return b.ts - a.ts
  })[0] ?? null
}

export function buildDeliberationFocusCandidates(
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): DeliberationFocus[] {
  const candidates: DeliberationFocus[] = []
  const seen = new Set<string>()

  for (const position of positions) {
    if (position.positionId == null || position.positionId.length === 0) continue
    const key = `position:${position.positionId}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ kind: 'position', positionId: position.positionId })
  }

  for (const setup of activeSetups) {
    const key = `setup:${setup.id}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ kind: 'setup', setupId: setup.id })
  }

  return candidates
}

export function cycleDeliberationFocus(
  current: DeliberationFocus,
  candidates: DeliberationFocus[],
  direction: 1 | -1,
): DeliberationFocus {
  if (candidates.length === 0) return { kind: 'auto' }
  if (current.kind === 'auto') {
    return direction === 1 ? candidates[0]! : candidates[candidates.length - 1]!
  }

  const currentKey = current.kind === 'position'
    ? `position:${current.positionId}`
    : `setup:${current.setupId}`
  const idx = candidates.findIndex(candidate => {
    const candidateKey = candidate.kind === 'position'
      ? `position:${candidate.positionId}`
      : candidate.kind === 'setup'
        ? `setup:${candidate.setupId}`
        : 'auto'
    return candidateKey === currentKey
  })

  if (idx === -1) return direction === 1 ? candidates[0]! : candidates[candidates.length - 1]!

  const next = (idx + direction + candidates.length) % candidates.length
  return candidates[next]!
}

export function resolveFocusedDecisionTrace(
  traces: DecisionTrace[],
  focus: DeliberationFocus,
): DecisionTrace | null {
  if (focus.kind === 'auto') return pickDecisionTrace(traces)

  const filtered = traces.filter(trace =>
    focus.kind === 'position'
      ? trace.outcome.positionId === focus.positionId
      : trace.outcome.setupId === focus.setupId,
  )

  if (filtered.length === 0) return null
  return filtered.sort((a, b) => b.ts - a.ts)[0] ?? null
}

export function describeDeliberationFocus(
  focus: DeliberationFocus,
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): string {
  if (focus.kind === 'auto') return 'AUTO'

  if (focus.kind === 'position') {
    const position = positions.find(item => item.positionId === focus.positionId)
    if (position != null) return `POS ${position.coin} ${position.side.toUpperCase()}`
    return `POS ${focus.positionId}`
  }

  const setup = activeSetups.find(item => item.id === focus.setupId)
  if (setup != null) return `SETUP ${setup.coin} ${setup.interval}`
  return `SETUP ${focus.setupId}`
}

export function resolveFocusedCoin(
  focus: DeliberationFocus,
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): string | null {
  if (focus.kind === 'auto') return null
  if (focus.kind === 'position') {
    return positions.find(item => item.positionId === focus.positionId)?.coin ?? null
  }
  return activeSetups.find(item => item.id === focus.setupId)?.coin ?? null
}

export function resolveFocusedStrategyId(
  focus: DeliberationFocus,
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): string | null {
  if (focus.kind === 'auto') return null
  if (focus.kind === 'position') {
    return positions.find(item => item.positionId === focus.positionId)?.strategyId ?? null
  }
  return activeSetups.find(item => item.id === focus.setupId)?.strategyId ?? null
}

export function resolveFocusedPosition(
  focus: DeliberationFocus,
  positions: DeliberationPositionRef[],
): DeliberationPositionRef | null {
  if (focus.kind !== 'position') return null
  return positions.find(item => item.positionId === focus.positionId) ?? null
}

export function resolveFocusedSetup(
  focus: DeliberationFocus,
  activeSetups: ActiveSetup[],
): ActiveSetup | null {
  if (focus.kind !== 'setup') return null
  return activeSetups.find(item => item.id === focus.setupId) ?? null
}

export function resolveFocusedOperatorAudit(
  entries: FocusAwareOperatorAuditEntry[],
  focus: DeliberationFocus,
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): FocusAwareOperatorAuditEntry | null {
  const filtered = entries.filter(entry => {
    if (focus.kind === 'position') {
      if (entry.positionId === focus.positionId) return true
      const position = positions.find(item => item.positionId === focus.positionId)
      if (position == null) return false
      return entry.coin === position.coin && entry.strategyId === position.strategyId
    }

    if (focus.kind === 'setup') {
      const setup = activeSetups.find(item => item.id === focus.setupId)
      if (setup == null) return false
      return entry.coin === setup.coin && entry.strategyId === (setup.strategyId ?? null)
    }

    return false
  })

  return filtered.sort((a, b) => b.ts - a.ts)[0] ?? null
}

export function resolveBriefingHealthFocus(
  health: BriefingHealthTarget,
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
): DeliberationFocus | null {
  const preferredPositionId =
    health.state === 'healthy' && health.recoveredPositionId != null
      ? health.recoveredPositionId
      : health.lastPositionId
  if (preferredPositionId != null) {
    const position = positions.find(item => item.positionId === preferredPositionId)
    if (position != null) {
      return { kind: 'position', positionId: preferredPositionId }
    }
  }

  const coin = (
    health.state === 'healthy' && health.recoveredCoin != null
      ? health.recoveredCoin
      : health.lastCoin
  )?.trim().toUpperCase()
  if (coin == null || coin.length === 0) return null

  const position = positions.find(item => item.coin.toUpperCase() === coin)
  if (position?.positionId != null) {
    return { kind: 'position', positionId: position.positionId }
  }

  const setup = activeSetups.find(item => item.coin.toUpperCase() === coin)
  if (setup != null) {
    return { kind: 'setup', setupId: setup.id }
  }

  return null
}

export function buildDeliberationFocusSlots(
  candidates: DeliberationFocus[],
  positions: DeliberationPositionRef[],
  activeSetups: ActiveSetup[],
  maxSlots = 9,
): DeliberationFocusSlot[] {
  return candidates.slice(0, Math.max(0, maxSlots)).map((focus, idx) => ({
    digit: String(idx + 1),
    focus,
    label: describeDeliberationFocus(focus, positions, activeSetups),
  }))
}

export function resolveDeliberationFocusDigit(
  input: string,
  slots: DeliberationFocusSlot[],
): DeliberationFocus | null {
  const slot = slots.find(item => item.digit === input)
  return slot?.focus ?? null
}
