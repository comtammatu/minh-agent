import { describe, expect, it } from 'bun:test'
import type { ActiveSetup, DecisionTrace } from '../../src/types.js'
import {
  buildDeliberationFocusCandidates,
  buildDeliberationFocusSlots,
  cycleDeliberationFocus,
  describeDeliberationFocus,
  pickDecisionTrace,
  resolveFocusedCoin,
  resolveFocusedOperatorAudit,
  resolveBriefingHealthFocus,
  resolveFocusedPosition,
  resolveFocusedSetup,
  resolveFocusedStrategyId,
  resolveDeliberationFocusDigit,
  resolveFocusedDecisionTrace,
  type DeliberationFocus,
} from '../../src/ui/deliberation-focus.js'

function makeTrace(overrides: Partial<DecisionTrace>): DecisionTrace {
  return {
    traceId: 'smc-sd:BTC|1h|setup|1',
    coin: 'BTC',
    interval: '1h',
    strategyId: 'smc-sd',
    exchange: 'HL',
    ts: 1,
    regime: {
      state: 'BULL',
      confidence: 0.7,
      modifier: 1,
    },
    roles: {
      judge: {
        role: 'judge',
        verdict: 'approve',
        confidence: 0.7,
        summary: 'approved',
        reasonsFor: [],
        reasonsAgainst: [],
      },
    },
    timeline: [],
    outcome: {
      action: 'watch',
      confidence: 0.7,
      summary: 'watching',
    },
    ...overrides,
  }
}

describe('deliberation focus helpers', () => {
  const positions = [
    { positionId: 'pos-1', coin: 'BTC', side: 'long' as const, strategyId: 'smc-sd' },
    { positionId: 'pos-2', coin: 'ETH', side: 'short' as const, strategyId: 'smc-sd' },
  ]
  const setups: ActiveSetup[] = [
    {
      id: 'smc-sd:BTC|1h|smc-sd',
      coin: 'BTC',
      interval: '1h',
      detectedAt: 1,
      detectedAtBar: 1,
      expiresAtBar: 10,
      strategyId: 'smc-sd',
      exchange: 'HL',
      type: 'smc-sd',
      side: 'long',
      confidence: 0.8,
      entryPrice: 100,
      slPrice: 95,
      tpPrice: 110,
      patternData: {},
      confluenceGrade: 'A',
      confluenceCount: 3,
    },
  ]

  it('builds focus candidates from positions first, then setups', () => {
    const candidates = buildDeliberationFocusCandidates(positions, setups)
    expect(candidates).toEqual<DeliberationFocus[]>([
      { kind: 'position', positionId: 'pos-1' },
      { kind: 'position', positionId: 'pos-2' },
      { kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' },
    ])
  })

  it('cycles focus across candidates and wraps', () => {
    const candidates = buildDeliberationFocusCandidates(positions, setups)
    expect(cycleDeliberationFocus({ kind: 'auto' }, candidates, 1)).toEqual({ kind: 'position', positionId: 'pos-1' })
    expect(cycleDeliberationFocus({ kind: 'position', positionId: 'pos-1' }, candidates, 1)).toEqual({ kind: 'position', positionId: 'pos-2' })
    expect(cycleDeliberationFocus({ kind: 'position', positionId: 'pos-1' }, candidates, -1)).toEqual({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' })
  })

  it('resolves manual focus to the matching trace', () => {
    const traces = [
      makeTrace({ traceId: 'older', ts: 1, outcome: { action: 'hold', confidence: 0.5, summary: 'old', positionId: 'pos-1' } }),
      makeTrace({ traceId: 'newer', ts: 2, outcome: { action: 'trail_sl', confidence: 0.8, summary: 'new', positionId: 'pos-1' } }),
      makeTrace({ traceId: 'setup', ts: 3, outcome: { action: 'watch', confidence: 0.6, summary: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' } }),
    ]

    const positionTrace = resolveFocusedDecisionTrace(traces, { kind: 'position', positionId: 'pos-1' })
    const setupTrace = resolveFocusedDecisionTrace(traces, { kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' })

    expect(positionTrace?.traceId).toBe('newer')
    expect(setupTrace?.traceId).toBe('setup')
  })

  it('falls back to priority selection in auto mode', () => {
    const traces = [
      makeTrace({ traceId: 'system', strategyId: 'system', ts: 2, outcome: { action: 'skip', confidence: 0.9, summary: 'skip' } }),
      makeTrace({ traceId: 'watch', ts: 1, outcome: { action: 'watch', confidence: 0.7, summary: 'watch' } }),
    ]
    expect(pickDecisionTrace(traces)?.traceId).toBe('watch')
    expect(resolveFocusedDecisionTrace(traces, { kind: 'auto' })?.traceId).toBe('watch')
  })

  it('describes focused target for the panel header', () => {
    expect(describeDeliberationFocus({ kind: 'auto' }, positions, setups)).toBe('AUTO')
    expect(describeDeliberationFocus({ kind: 'position', positionId: 'pos-1' }, positions, setups)).toBe('POS BTC LONG')
    expect(describeDeliberationFocus({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, positions, setups)).toBe('SETUP BTC 1h')
  })

  it('resolves the focused coin for watchlist highlighting', () => {
    expect(resolveFocusedCoin({ kind: 'auto' }, positions, setups)).toBeNull()
    expect(resolveFocusedCoin({ kind: 'position', positionId: 'pos-2' }, positions, setups)).toBe('ETH')
    expect(resolveFocusedCoin({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, positions, setups)).toBe('BTC')
  })

  it('resolves the focused strategy for operator actions', () => {
    expect(resolveFocusedStrategyId({ kind: 'auto' }, positions, setups)).toBeNull()
    expect(resolveFocusedStrategyId({ kind: 'position', positionId: 'pos-2' }, positions, setups)).toBe('smc-sd')
    expect(resolveFocusedStrategyId({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, positions, setups)).toBe('smc-sd')
  })

  it('resolves the focused position payload for operator actions', () => {
    expect(resolveFocusedPosition({ kind: 'auto' }, positions)).toBeNull()
    expect(resolveFocusedPosition({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, positions)).toBeNull()
    expect(resolveFocusedPosition({ kind: 'position', positionId: 'pos-2' }, positions)).toEqual(
      { positionId: 'pos-2', coin: 'ETH', side: 'short', strategyId: 'smc-sd' },
    )
  })

  it('resolves the focused setup payload for setup detail panels', () => {
    expect(resolveFocusedSetup({ kind: 'auto' }, setups)).toBeNull()
    expect(resolveFocusedSetup({ kind: 'position', positionId: 'pos-1' }, setups)).toBeNull()
    expect(resolveFocusedSetup({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, setups)).toEqual(setups[0])
  })

  it('builds numbered focus slots and resolves digit jumps', () => {
    const candidates = buildDeliberationFocusCandidates(positions, setups)
    const slots = buildDeliberationFocusSlots(candidates, positions, setups)

    expect(slots).toEqual([
      { digit: '1', focus: { kind: 'position', positionId: 'pos-1' }, label: 'POS BTC LONG' },
      { digit: '2', focus: { kind: 'position', positionId: 'pos-2' }, label: 'POS ETH SHORT' },
      { digit: '3', focus: { kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, label: 'SETUP BTC 1h' },
    ])
    expect(resolveDeliberationFocusDigit('2', slots)).toEqual({ kind: 'position', positionId: 'pos-2' })
    expect(resolveDeliberationFocusDigit('9', slots)).toBeNull()
  })

  it('resolves linked operator audit for focused position and setup', () => {
    const entries = [
      { ts: 1, action: 'pause', target: 'smc-sd', status: 'submitted' as const, coin: 'BTC', strategyId: 'smc-sd' },
      { ts: 2, action: 'reduce 25%', target: 'BTC LONG', status: 'armed' as const, coin: 'BTC', strategyId: 'smc-sd', positionId: 'pos-1' },
      { ts: 3, action: 'close', target: 'ETH SHORT', status: 'submitted' as const, coin: 'ETH', strategyId: 'smc-sd', positionId: 'pos-2' },
    ]

    expect(
      resolveFocusedOperatorAudit(entries, { kind: 'position', positionId: 'pos-1' }, positions, setups)?.action,
    ).toBe('reduce 25%')

    expect(
      resolveFocusedOperatorAudit(entries, { kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' }, positions, setups)?.action,
    ).toBe('reduce 25%')
  })

  it('resolves briefing health focus to recovered target first, then current target', () => {
    expect(
      resolveBriefingHealthFocus(
        { state: 'healthy', recoveredPositionId: 'pos-2', recoveredCoin: 'ETH', lastPositionId: 'pos-1', lastCoin: 'BTC' },
        positions,
        setups,
      ),
    ).toEqual({ kind: 'position', positionId: 'pos-2' })

    expect(
      resolveBriefingHealthFocus(
        { state: 'healthy', recoveredCoin: 'BTC' },
        positions.filter(item => item.coin !== 'BTC'),
        setups,
      ),
    ).toEqual({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' })

    expect(
      resolveBriefingHealthFocus({ lastPositionId: 'pos-2', lastCoin: 'ETH' }, positions, setups),
    ).toEqual({ kind: 'position', positionId: 'pos-2' })

    expect(
      resolveBriefingHealthFocus({ lastCoin: 'BTC' }, positions.filter(item => item.coin !== 'BTC'), setups),
    ).toEqual({ kind: 'setup', setupId: 'smc-sd:BTC|1h|smc-sd' })

    expect(resolveBriefingHealthFocus({ lastCoin: 'SOL' }, positions, setups)).toBeNull()
  })
})
