import { afterEach, describe, expect, it } from 'bun:test'
import { buildSetupDecisionTrace, buildStatusDecisionTrace } from './decision-trace.js'
import type { ActiveSetup, StructureBreak } from '../types.js'
import {
  clearPipelineState,
  getDecisionTraces,
  publishDecisionTrace,
  recordDecisionTraceAgentAction,
  recordDecisionTraceMonitorEvent,
  recordDecisionTracePaperExit,
} from './orchestrator.js'

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: 'smc-sd:BTC|1h|smc-sd',
    coin: 'BTC',
    interval: '1h',
    type: 'smc-sd',
    side: 'long',
    confidence: 0.74,
    entryPrice: 50000,
    slPrice: 49500,
    tpPrice: 51000,
    patternData: {
      zoneOrigin: 'order-block',
      pattern: 'engulfing',
      regime: 'pullback',
    },
    detectedAt: 1_710_000_000_000,
    detectedAtBar: 120,
    expiresAtBar: 135,
    strategyId: 'smc-sd',
    confluenceGrade: 'A',
    confluenceCount: 4,
    exchange: 'HL',
    ...overrides,
  }
}

function makeBreaks(): StructureBreak[] {
  return [
    { kind: 'bos', direction: 'bullish', level: 49850, index: 90 },
    { kind: 'choch', direction: 'bullish', level: 50125, index: 110 },
  ]
}

afterEach(() => {
  clearPipelineState()
})

describe('buildStatusDecisionTrace', () => {
  it('builds a system trace that stays neutral when bias is absent', () => {
    const trace = buildStatusDecisionTrace({
      coin: 'BTC',
      interval: '1h',
      exchange: 'HL',
      regime: 'SIDEWAYS',
      bias: null,
      wyckoff: { phase: null, confidence: 0, event: null },
      breaks: [],
      activeCount: 0,
      ts: 1_710_000_000_000,
    })

    expect(trace.strategyId).toBe('system')
    expect(trace.outcome.action).toBe('skip')
    expect(trace.roles.judge?.verdict).toBe('reject')
    expect(trace.roles.wyckoff?.summary).toContain('inconclusive')
    expect(trace.timeline).toHaveLength(1)
    expect(trace.timeline[0]?.actor).toBe('scanner')
  })
})

describe('buildSetupDecisionTrace', () => {
  it('builds an approval-ready trace for a qualified setup', () => {
    const trace = buildSetupDecisionTrace({
      setup: makeSetup(),
      regime: 'BULL',
      bias: { bias: 'long', confidence: 0.78, source: 'wyckoff+smc', htfBias: 'long' },
      wyckoff: { phase: 'accumulation', confidence: 0.82, event: 'spring' },
      breaks: makeBreaks(),
      activeCount: 1,
    })

    expect(trace.strategyId).toBe('smc-sd')
    expect(trace.outcome.action).toBe('watch')
    expect(trace.outcome.setupId).toBe('smc-sd:BTC|1h|smc-sd')
    expect(trace.roles.judge?.verdict).toBe('approve')
    expect(trace.roles.risk?.evidence.some(item => item.includes('R:R'))).toBe(true)
    expect(trace.roles.executor?.state).toBe('idle')
    expect(trace.timeline).toHaveLength(1)
    expect(trace.timeline[0]?.actor).toBe('judge')
  })
})

describe('decision trace runtime lifecycle', () => {
  function seedSetupTrace(): void {
    publishDecisionTrace(buildSetupDecisionTrace({
      setup: makeSetup(),
      regime: 'BULL',
      bias: { bias: 'long', confidence: 0.78, source: 'wyckoff+smc', htfBias: 'long' },
      wyckoff: { phase: 'accumulation', confidence: 0.82, event: 'spring' },
      breaks: makeBreaks(),
      activeCount: 1,
    }))
  }

  it('updates executor from watch to submitting to filled', () => {
    const setup = makeSetup()
    seedSetupTrace()

    recordDecisionTraceAgentAction({ type: 'place_order', setup })
    let trace = getDecisionTraces()[0]!
    expect(trace.roles.executor?.state).toBe('submitting')
    expect(trace.outcome.action).toBe('enter')
    expect(trace.timeline.at(-1)?.actor).toBe('executor')
    expect(trace.timeline.at(-1)?.action).toBe('submit')

    recordDecisionTraceAgentAction({
      type: 'log_journal',
      eventType: 'enter',
      coin: 'BTC',
      details: {
        setupId: setup.id,
        positionId: 'pos-1',
        strategyId: 'smc-sd',
      },
    })
    trace = getDecisionTraces()[0]!
    expect(trace.roles.executor?.state).toBe('filled')
    expect(trace.roles.guardian?.state).toBe('holding')
    expect(trace.outcome.positionId).toBe('pos-1')
    expect(trace.timeline.slice(-2).map(item => item.action)).toEqual(['filled', 'hold'])
  })

  it('updates guardian on trail and partial-close events', () => {
    const setup = makeSetup()
    seedSetupTrace()
    recordDecisionTraceAgentAction({
      type: 'log_journal',
      eventType: 'enter',
      coin: 'BTC',
      details: {
        setupId: setup.id,
        positionId: 'pos-1',
        strategyId: 'smc-sd',
      },
    })

    recordDecisionTraceMonitorEvent({
      positionId: 'pos-1',
      coin: 'BTC',
      strategyId: 'smc-sd',
      action: 'trail_update',
      summary: 'Guardian trailed SL on BTC to 50200.00.',
    })
    let trace = getDecisionTraces()[0]!
    expect(trace.roles.guardian?.state).toBe('trail_sl')
    expect(trace.outcome.action).toBe('trail_sl')
    expect(trace.timeline.at(-1)?.action).toBe('trail_update')

    recordDecisionTraceMonitorEvent({
      positionId: 'pos-1',
      coin: 'BTC',
      strategyId: 'smc-sd',
      action: 'partial_close',
      summary: 'Guardian scaled out 50% on BTC.',
    })
    trace = getDecisionTraces()[0]!
    expect(trace.roles.guardian?.state).toBe('partial_tp')
    expect(trace.outcome.action).toBe('partial_close')
    expect(trace.timeline.at(-1)?.action).toBe('partial_close')
  })

  it('closes the trace on exit and paper exit updates', () => {
    const setup = makeSetup()
    seedSetupTrace()
    recordDecisionTraceAgentAction({
      type: 'log_journal',
      eventType: 'enter',
      coin: 'BTC',
      details: {
        setupId: setup.id,
        positionId: 'pos-1',
        strategyId: 'smc-sd',
      },
    })

    recordDecisionTraceAgentAction({
      type: 'log_journal',
      eventType: 'exit',
      coin: 'BTC',
      details: {
        positionId: 'pos-1',
        strategyId: 'smc-sd',
        reason: 'tp_hit',
      },
    })
    let trace = getDecisionTraces()[0]!
    expect(trace.roles.executor?.state).toBe('closed')
    expect(trace.outcome.action).toBe('exit')
    expect(trace.timeline.at(-1)?.action).toBe('closed')

    seedSetupTrace()
    recordDecisionTracePaperExit({
      coin: 'BTC',
      strategyId: 'smc-sd',
      exitReason: 'tp2_hit',
      closePrice: 51250,
      pnl: 180,
    })
    trace = getDecisionTraces().find(item => item.strategyId === 'smc-sd')!
    expect(trace.roles.guardian?.state).toBe('exit_ready')
    expect(trace.roles.executor?.state).toBe('closed')
    expect(trace.timeline.slice(-2).map(item => item.action)).toEqual(['paper_exit', 'exit'])
  })
})
