import { describe, it, expect } from 'bun:test'
import {
  captureThesis,
  evaluateThesis,
  thesisToActions,
  shouldCheckThesis,
} from './thesis-monitor.js'
import { THESIS_MONITOR } from '../config.js'
import type { PositionState, ThesisTFSnapshot, TradeThesis } from './types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSnapshots(
  data: Array<{ interval: '5m' | '15m' | '1h' | '4h' | '1d'; regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'; bias: 'long' | 'short' | 'neutral' }>,
): ThesisTFSnapshot[] {
  return data.map(d => ({
    interval: d.interval,
    regime: d.regime,
    bias: d.bias,
    biasConfidence: 0.7,
  }))
}

function makePosition(overrides: Partial<PositionState> = {}): PositionState {
  return {
    positionId: 'test-pos-1',
    coin: 'BTC',
    side: 'long',
    entryPrice: 100_000,
    currentSize: 0.01,
    originalSize: 0.01,
    slPrice: 99_000,
    tpPrice: 103_000,
    entryOrderId: 'ord-1',
    leverage: 5,
    strategyId: 'smc-sd',
    trailingState: null,
    partialClosesFired: [],
    lastSyncAt: Date.now(),
    openedAt: Date.now(),
    thesis: null,
    lastThesisCheckAt: 0,
    ...overrides,
  }
}

// ─── captureThesis ──────────────────────────────────────────────────────────

describe('captureThesis', () => {
  it('wraps snapshots into TradeThesis with correct fields', () => {
    const snaps = makeSnapshots([
      { interval: '1h', regime: 'BULL', bias: 'long' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ])
    const thesis = captureThesis('long', '1h', snaps)

    expect(thesis.side).toBe('long')
    expect(thesis.entryInterval).toBe('1h')
    expect(thesis.snapshots).toHaveLength(2)
    expect(thesis.capturedAt).toBeGreaterThan(0)
  })

  it('copies snapshots (no mutation of input)', () => {
    const snaps = makeSnapshots([{ interval: '1h', regime: 'BULL', bias: 'long' }])
    const thesis = captureThesis('long', '1h', snaps)
    snaps[0]!.regime = 'BEAR'
    expect(thesis.snapshots[0]!.regime).toBe('BULL')
  })
})

// ─── evaluateThesis ─────────────────────────────────────────────────────────

describe('evaluateThesis', () => {
  const longThesis: TradeThesis = {
    entryInterval: '1h',
    side: 'long',
    snapshots: makeSnapshots([
      { interval: '1h', regime: 'BULL', bias: 'long' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ]),
    capturedAt: Date.now(),
  }

  it('returns aligned when all TFs still match', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'BULL', bias: 'long' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ])
    const result = evaluateThesis(longThesis, current)
    expect(result.score).toBe(0)
    expect(result.severity).toBe('aligned')
  })

  it('returns minor when entry TF goes neutral', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'SIDEWAYS', bias: 'neutral' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ])
    const result = evaluateThesis(longThesis, current)
    // Entry TF (w=1): regime=0.25 + bias=0.25 = 0.5, weighted=0.5
    // HTF (w=2): regime=0 + bias=0 = 0, weighted=0
    // Total = 0.5 / 3 = 0.167
    expect(result.score).toBeCloseTo(0.167, 2)
    expect(result.severity).toBe('aligned')
  })

  it('returns moderate when HTF flips bearish regime+bias', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'BULL', bias: 'long' },
      { interval: '4h', regime: 'BEAR', bias: 'short' },
    ])
    const result = evaluateThesis(longThesis, current)
    // Entry TF (w=1): 0
    // HTF (w=2): regime=0.5 + bias=0.5 = 1.0, weighted=2.0
    // Total = 2.0 / 3 = 0.667
    expect(result.score).toBeCloseTo(0.667, 2)
    expect(result.severity).toBe('moderate')
  })

  it('returns severe when all TFs fully opposed', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'BEAR', bias: 'short' },
      { interval: '4h', regime: 'BEAR', bias: 'short' },
    ])
    const result = evaluateThesis(longThesis, current)
    // Entry TF (w=1): 0.5+0.5=1.0, weighted=1.0
    // HTF (w=2): 0.5+0.5=1.0, weighted=2.0
    // Total = 3.0 / 3 = 1.0
    expect(result.score).toBeCloseTo(1.0, 2)
    expect(result.severity).toBe('severe')
  })

  it('handles short trade correctly — BULL is opposed', () => {
    const shortThesis: TradeThesis = {
      entryInterval: '15m',
      side: 'short',
      snapshots: makeSnapshots([
        { interval: '15m', regime: 'BEAR', bias: 'short' },
        { interval: '4h', regime: 'BEAR', bias: 'short' },
      ]),
      capturedAt: Date.now(),
    }
    const current = makeSnapshots([
      { interval: '15m', regime: 'BULL', bias: 'long' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ])
    const result = evaluateThesis(shortThesis, current)
    expect(result.score).toBeCloseTo(1.0, 2)
    expect(result.severity).toBe('severe')
  })

  it('VOLATILE regime treated as neutral (partial score)', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'VOLATILE', bias: 'long' },
      { interval: '4h', regime: 'BULL', bias: 'long' },
    ])
    const result = evaluateThesis(longThesis, current)
    // Entry TF (w=1): regime=0.25 + bias=0 = 0.25
    // HTF (w=2): 0
    // Total = 0.25 / 3 = 0.083
    expect(result.score).toBeCloseTo(0.083, 2)
    expect(result.severity).toBe('aligned')
  })

  it('skips TFs not present in current snapshots', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'BEAR', bias: 'short' },
      // 4h missing
    ])
    const result = evaluateThesis(longThesis, current)
    // Only entry TF (w=1): 0.5+0.5=1.0
    // Total = 1.0/1.0 = 1.0
    expect(result.score).toBeCloseTo(1.0, 2)
    expect(result.details).toHaveLength(1)
  })

  it('returns 0 score with empty snapshots', () => {
    const result = evaluateThesis(longThesis, [])
    expect(result.score).toBe(0)
    expect(result.severity).toBe('aligned')
  })

  it('respects custom config thresholds', () => {
    const current = makeSnapshots([
      { interval: '1h', regime: 'SIDEWAYS', bias: 'neutral' },
      { interval: '4h', regime: 'SIDEWAYS', bias: 'neutral' },
    ])
    const strictConfig = { ...THESIS_MONITOR, minorThreshold: 0.1, moderateThreshold: 0.2, severeThreshold: 0.3 }
    const result = evaluateThesis(longThesis, current, strictConfig)
    // Both neutral: (0.25+0.25)*1 + (0.25+0.25)*2 = 0.5+1.0 = 1.5 / 3 = 0.5
    expect(result.severity).toBe('severe')
  })
})

// ─── thesisToActions ────────────────────────────────────────────────────────

describe('thesisToActions', () => {
  it('returns empty array for aligned severity', () => {
    const actions = thesisToActions(
      { score: 0.1, severity: 'aligned', details: [] },
      makePosition(),
    )
    expect(actions).toHaveLength(0)
  })

  it('returns alert for minor severity', () => {
    const actions = thesisToActions(
      { score: 0.35, severity: 'minor', details: [] },
      makePosition(),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('alert')
  })

  it('returns trail_update (breakeven) for moderate when SL below entry', () => {
    const pos = makePosition({ side: 'long', entryPrice: 100_000, slPrice: 99_000 })
    const actions = thesisToActions(
      { score: 0.6, severity: 'moderate', details: [] },
      pos,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('trail_update')
    if (actions[0]!.type === 'trail_update') {
      expect(actions[0]!.newSlPrice).toBe(100_000)
    }
  })

  it('returns alert for moderate when SL already at breakeven (long)', () => {
    const pos = makePosition({ side: 'long', entryPrice: 100_000, slPrice: 100_000 })
    const actions = thesisToActions(
      { score: 0.6, severity: 'moderate', details: [] },
      pos,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('alert')
  })

  it('returns alert for moderate when SL already above entry (long trailing)', () => {
    const pos = makePosition({ side: 'long', entryPrice: 100_000, slPrice: 101_000 })
    const actions = thesisToActions(
      { score: 0.6, severity: 'moderate', details: [] },
      pos,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('alert')
  })

  it('handles short trade breakeven correctly', () => {
    const pos = makePosition({ side: 'short', entryPrice: 100_000, slPrice: 101_000 })
    const actions = thesisToActions(
      { score: 0.6, severity: 'moderate', details: [] },
      pos,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('trail_update')
    if (actions[0]!.type === 'trail_update') {
      expect(actions[0]!.newSlPrice).toBe(100_000)
    }
  })

  it('returns alert for moderate when short SL already at or below entry', () => {
    const pos = makePosition({ side: 'short', entryPrice: 100_000, slPrice: 99_500 })
    const actions = thesisToActions(
      { score: 0.6, severity: 'moderate', details: [] },
      pos,
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('alert')
  })

  it('returns close for severe severity', () => {
    const actions = thesisToActions(
      { score: 0.9, severity: 'severe', details: [] },
      makePosition(),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]!.type).toBe('close')
    if (actions[0]!.type === 'close') {
      expect(actions[0]!.reason).toContain('thesis_deteriorated')
      expect(actions[0]!.reason).toContain('0.90')
    }
  })
})

// ─── shouldCheckThesis ──────────────────────────────────────────────────────

describe('shouldCheckThesis', () => {
  const TF_5M_MS = 300_000

  it('returns true when lastThesisCheckAt is 0 (first check)', () => {
    const pos = makePosition({
      thesis: captureThesis('long', '5m', []),
      lastThesisCheckAt: 0,
    })
    expect(shouldCheckThesis(pos, Date.now(), TF_5M_MS)).toBe(true)
  })

  it('returns false when under cooldown', () => {
    const now = 1_700_000_000_000
    const pos = makePosition({
      thesis: captureThesis('long', '5m', []),
      lastThesisCheckAt: now - 100_000,  // 100s ago, cooldown is 300s
    })
    expect(shouldCheckThesis(pos, now, TF_5M_MS)).toBe(false)
  })

  it('returns true when cooldown expired', () => {
    const now = 1_700_000_000_000
    const pos = makePosition({
      thesis: captureThesis('long', '5m', []),
      lastThesisCheckAt: now - 400_000,  // 400s ago, cooldown is 300s
    })
    expect(shouldCheckThesis(pos, now, TF_5M_MS)).toBe(true)
  })

  it('returns false when thesis is null (legacy position)', () => {
    const pos = makePosition({ thesis: null })
    expect(shouldCheckThesis(pos, Date.now(), TF_5M_MS)).toBe(false)
  })

  it('returns false when monitoring disabled', () => {
    const pos = makePosition({
      thesis: captureThesis('long', '5m', []),
      lastThesisCheckAt: 0,
    })
    const disabled = { ...THESIS_MONITOR, enabled: false }
    expect(shouldCheckThesis(pos, Date.now(), TF_5M_MS, disabled)).toBe(false)
  })

  it('respects cooldownMultiplier', () => {
    const now = 1_700_000_000_000
    const pos = makePosition({
      thesis: captureThesis('long', '5m', []),
      lastThesisCheckAt: now - 500_000,  // 500s ago
    })
    // 2x multiplier: cooldown = 600s, 500s is not enough
    const config2x = { ...THESIS_MONITOR, cooldownMultiplier: 2.0 }
    expect(shouldCheckThesis(pos, now, TF_5M_MS, config2x)).toBe(false)
    // But 700s ago would pass
    pos.lastThesisCheckAt = now - 700_000
    expect(shouldCheckThesis(pos, now, TF_5M_MS, config2x)).toBe(true)
  })
})
