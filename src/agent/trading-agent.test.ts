/**
 * Trading Agent state machine tests.
 * Tests each handler independently + full dispatch integration.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import {
  TradingAgent,
  resetAgent,
  handleIdle,
  handleWatching,
  handleEntering,
  handleInPosition,
  handleExiting,
  handlePaused,
} from './trading-agent.js'
import type { CoinContext, GlobalContext, AgentEvent } from './types.js'
import type { ActiveSetup } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides: Partial<ActiveSetup> = {}): ActiveSetup {
  return {
    id: 'BTC:1h:order-block:long',
    coin: 'BTC',
    interval: '1h',
    type: 'order-block',
    side: 'long',
    confidence: 0.75,
    entryPrice: 50000,
    slPrice: 49000,
    tpPrice: 52000,
    patternData: {},
    detectedAt: Date.now(),
    expiresAtBar: 100,
    confluenceGrade: 'B',
    confluenceCount: 4,
    ...overrides,
  }
}

function makeCoinCtx(overrides: Partial<CoinContext> = {}): CoinContext {
  return {
    state: 'IDLE',
    coin: 'BTC',
    activeSetup: null,
    pendingOrderId: null,
    positionId: null,
    stateEnteredAt: Date.now(),
    consecutiveLosses: 0,
    pauseReason: null,
    pauseUntil: null,
    ...overrides,
  }
}

function makeGlobal(overrides: Partial<GlobalContext> = {}): GlobalContext {
  return {
    dailyPnl: 0,
    peakAccountValue: 10000,
    totalConsecutiveLosses: 0,
    lastTradeTime: 0,
    globalPaused: false,
    globalPauseReason: null,
    startedAt: Date.now(),
    ...overrides,
  }
}

// ── Pure Handler Tests ───────────────────────────────────────────────────────

describe('handleIdle', () => {
  it('transitions to WATCHING on grade B setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'B' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
    expect(result.actions.some(a => a.type === 'watch')).toBe(true)
  })

  it('transitions to WATCHING on grade A setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'A' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
  })

  it('transitions to WATCHING on grade A+ setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'A+' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
  })

  it('stays IDLE on grade C setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'C' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions.some(a => a.type === 'log_journal' && a.eventType === 'skip')).toBe(true)
  })

  it('transitions to PAUSED when global paused', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'A' })
    const global = makeGlobal({ globalPaused: true, globalPauseReason: 'manual' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, global)
    expect(result.nextState).toBe('PAUSED')
  })

  it('transitions to PAUSED on pause event', () => {
    const ctx = makeCoinCtx()
    const result = handleIdle(ctx, { type: 'pause', reason: 'daily loss' }, makeGlobal())
    expect(result.nextState).toBe('PAUSED')
  })

  it('stays IDLE on tick', () => {
    const ctx = makeCoinCtx()
    const result = handleIdle(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions).toHaveLength(0)
  })
})

describe('handleWatching', () => {
  it('goes to IDLE on setup_invalidated', () => {
    const setup = makeSetup()
    const ctx = makeCoinCtx({ state: 'WATCHING', activeSetup: setup })
    const result = handleWatching(ctx, { type: 'setup_invalidated', setupId: setup.id, reason: 'zone-broken' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('stays WATCHING on low-grade replacement setup', () => {
    const setup = makeSetup({ confidence: 0.8 })
    const ctx = makeCoinCtx({ state: 'WATCHING', activeSetup: setup })
    const weaker = makeSetup({ confluenceGrade: 'C', confidence: 0.5 })
    const result = handleWatching(ctx, { type: 'setup_detected', setup: weaker }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
    expect(result.actions).toHaveLength(0)
  })

  it('upgrades setup on higher confidence', () => {
    const setup = makeSetup({ confidence: 0.6 })
    const ctx = makeCoinCtx({ state: 'WATCHING', activeSetup: setup })
    const better = makeSetup({ confluenceGrade: 'A', confidence: 0.9 })
    const result = handleWatching(ctx, { type: 'setup_detected', setup: better }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
    expect(result.actions.some(a => a.type === 'watch')).toBe(true)
  })

  it('transitions to PAUSED when global paused', () => {
    const ctx = makeCoinCtx({ state: 'WATCHING', activeSetup: makeSetup() })
    const global = makeGlobal({ globalPaused: true, globalPauseReason: 'emergency' })
    const result = handleWatching(ctx, { type: 'tick' }, global)
    expect(result.nextState).toBe('PAUSED')
  })
})

describe('handleEntering', () => {
  it('transitions to IN_POSITION on order_filled', () => {
    const ctx = makeCoinCtx({ state: 'ENTERING', pendingOrderId: 'ord-1', activeSetup: makeSetup() })
    const result = handleEntering(ctx, {
      type: 'order_filled', orderId: 'ord-1', fillPrice: 50100, positionId: 'pos-1',
    }, makeGlobal())
    expect(result.nextState).toBe('IN_POSITION')
    expect(result.actions.some(a => a.type === 'log_journal' && a.eventType === 'enter')).toBe(true)
  })

  it('transitions to IDLE on order_rejected', () => {
    const ctx = makeCoinCtx({ state: 'ENTERING', pendingOrderId: 'ord-1' })
    const result = handleEntering(ctx, {
      type: 'order_rejected', orderId: 'ord-1', reason: 'insufficient margin',
    }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('transitions to IDLE + cancels on order_timeout', () => {
    const ctx = makeCoinCtx({ state: 'ENTERING', pendingOrderId: 'ord-1' })
    const result = handleEntering(ctx, { type: 'order_timeout', orderId: 'ord-1' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions.some(a => a.type === 'cancel_order')).toBe(true)
  })

  it('cancels order on tick timeout', () => {
    const ctx = makeCoinCtx({
      state: 'ENTERING',
      pendingOrderId: 'ord-1',
      stateEnteredAt: Date.now() - 6 * 60 * 1000,  // 6 min ago (> 5 min timeout)
    })
    const result = handleEntering(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions.some(a => a.type === 'cancel_order' && a.orderId === 'ord-1')).toBe(true)
  })

  it('cancels order and goes IDLE on setup_invalidated', () => {
    const ctx = makeCoinCtx({ state: 'ENTERING', pendingOrderId: 'ord-1' })
    const result = handleEntering(ctx, {
      type: 'setup_invalidated', setupId: 'BTC:1h:ob:long', reason: 'zone-broken',
    }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions.some(a => a.type === 'cancel_order')).toBe(true)
  })

  it('cancels order on pause', () => {
    const ctx = makeCoinCtx({ state: 'ENTERING', pendingOrderId: 'ord-1' })
    const result = handleEntering(ctx, { type: 'pause', reason: 'manual' }, makeGlobal())
    expect(result.nextState).toBe('PAUSED')
    expect(result.actions.some(a => a.type === 'cancel_order')).toBe(true)
  })
})

describe('handleInPosition', () => {
  it('transitions to EXITING on sl_hit', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, {
      type: 'sl_hit', positionId: 'pos-1', closePrice: 49000, pnl: -100,
    }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
  })

  it('transitions to EXITING on tp_hit', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, {
      type: 'tp_hit', positionId: 'pos-1', closePrice: 52000, pnl: 200,
    }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
  })

  it('transitions to EXITING on trail_stop_hit', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, {
      type: 'trail_stop_hit', positionId: 'pos-1', closePrice: 51000, pnl: 100,
    }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
  })

  it('closes position on setup_invalidated', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, {
      type: 'setup_invalidated', setupId: 'BTC:1h:ob:long', reason: 'zone-broken',
    }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
    expect(result.actions.some(a => a.type === 'close_position' && a.positionId === 'pos-1')).toBe(true)
  })

  it('closes position on emergency pause', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, { type: 'pause', reason: 'emergency' }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
    expect(result.actions.some(a => a.type === 'close_position')).toBe(true)
  })

  it('stays IN_POSITION on circuit_break (R5)', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, {
      type: 'circuit_break', reason: 'daily loss', pauseUntil: null,
    }, makeGlobal())
    // R5: CB does NOT move IN_POSITION to PAUSED
    expect(result.nextState).toBe('IN_POSITION')
  })

  it('stays IN_POSITION on tick (no action)', () => {
    const ctx = makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1' })
    const result = handleInPosition(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('IN_POSITION')
    expect(result.actions).toHaveLength(0)
  })
})

describe('handleExiting', () => {
  it('transitions to IDLE on position_closed (profit)', () => {
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 0 })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 52000, pnl: 200, reason: 'tp_hit',
    }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('transitions to IDLE on position_closed (loss, under threshold)', () => {
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 0 })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 49000, pnl: -100, reason: 'sl_hit',
    }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('transitions to PAUSED on 3 consecutive losses', () => {
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 2 })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 49000, pnl: -100, reason: 'sl_hit',
    }, makeGlobal())
    expect(result.nextState).toBe('PAUSED')
    expect(result.actions.some(a => a.type === 'log_journal' && a.eventType === 'circuit_break')).toBe(true)
  })

  it('transitions to PAUSED when global paused', () => {
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 0 })
    const global = makeGlobal({ globalPaused: true })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 52000, pnl: 200, reason: 'tp_hit',
    }, global)
    expect(result.nextState).toBe('PAUSED')
  })

  it('goes IDLE on exit timeout', () => {
    const ctx = makeCoinCtx({
      state: 'EXITING',
      stateEnteredAt: Date.now() - 6 * 60 * 1000,
    })
    const result = handleExiting(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
    expect(result.actions.some(a => a.type === 'log_journal' && a.eventType === 'error')).toBe(true)
  })
})

describe('handlePaused', () => {
  it('transitions to IDLE on resume', () => {
    const ctx = makeCoinCtx({ state: 'PAUSED', pauseReason: 'manual' })
    const result = handlePaused(ctx, { type: 'resume' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('auto-resumes when cooldown expired', () => {
    const ctx = makeCoinCtx({
      state: 'PAUSED',
      pauseReason: 'consecutive_losses',
      pauseUntil: Date.now() - 1000,  // expired 1s ago
    })
    const result = handlePaused(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('stays PAUSED when cooldown not yet expired', () => {
    const ctx = makeCoinCtx({
      state: 'PAUSED',
      pauseReason: 'consecutive_losses',
      pauseUntil: Date.now() + 60_000,  // 1 min from now
    })
    const result = handlePaused(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('PAUSED')
  })

  it('stays PAUSED on setup_detected (ignores signals)', () => {
    const ctx = makeCoinCtx({ state: 'PAUSED', pauseReason: 'manual' })
    const setup = makeSetup({ confluenceGrade: 'A+' })
    const result = handlePaused(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('PAUSED')
  })
})

// ── Integration: TradingAgent class ──────────────────────────────────────────

describe('TradingAgent', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('starts coins in IDLE state', () => {
    expect(agent.getCoinState('BTC')).toBe('IDLE')
  })

  it('dispatches setup_detected → WATCHING', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    const result = agent.dispatch('BTC', { type: 'setup_detected', setup })
    expect(result.nextState).toBe('WATCHING')
    expect(agent.getCoinState('BTC')).toBe('WATCHING')
  })

  it('full lifecycle: IDLE → WATCHING → ENTERING → IN_POSITION → EXITING → IDLE', () => {
    const setup = makeSetup({ confluenceGrade: 'B' })

    // IDLE → WATCHING
    agent.dispatch('BTC', { type: 'setup_detected', setup })
    expect(agent.getCoinState('BTC')).toBe('WATCHING')

    // Simulate entry trigger: directly push to ENTERING
    // (In real flow, WATCHING would emit place_order action on entry trigger)
    // For testing, we simulate the order placement side-effect
    const btxCtx = (agent as unknown as { coins: Map<string, CoinContext> }).coins.get('BTC')!
    btxCtx.state = 'ENTERING'
    btxCtx.pendingOrderId = 'ord-1'
    btxCtx.stateEnteredAt = Date.now()

    // ENTERING → IN_POSITION
    agent.dispatch('BTC', { type: 'order_filled', orderId: 'ord-1', fillPrice: 50100, positionId: 'pos-1' })
    expect(agent.getCoinState('BTC')).toBe('IN_POSITION')

    // IN_POSITION → EXITING
    agent.dispatch('BTC', { type: 'tp_hit', positionId: 'pos-1', closePrice: 52000, pnl: 200 })
    expect(agent.getCoinState('BTC')).toBe('EXITING')

    // EXITING → IDLE
    agent.dispatch('BTC', { type: 'position_closed', positionId: 'pos-1', closePrice: 52000, pnl: 200, reason: 'tp' })
    expect(agent.getCoinState('BTC')).toBe('IDLE')
  })

  it('tracks multiple coins independently', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ coin: 'BTC', confluenceGrade: 'A' }) })
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH:1h:ob:long', confluenceGrade: 'B' }) })

    expect(agent.getCoinState('BTC')).toBe('WATCHING')
    expect(agent.getCoinState('ETH')).toBe('WATCHING')
    expect(agent.getCoinState('SOL')).toBe('IDLE')  // never touched
  })

  it('pauseAll pauses all coins', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH:1h:ob:long', confluenceGrade: 'B' }) })

    agent.pauseAll('daily loss limit')

    expect(agent.getCoinState('BTC')).toBe('PAUSED')
    expect(agent.getCoinState('ETH')).toBe('PAUSED')
  })

  it('resumeAll resumes paused coins', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    agent.pauseAll('test')
    expect(agent.getCoinState('BTC')).toBe('PAUSED')

    agent.resumeAll()
    expect(agent.getCoinState('BTC')).toBe('IDLE')
  })

  it('getSnapshot returns correct structure', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })

    const snap = agent.getSnapshot()
    expect(snap.coins['BTC']).toBeDefined()
    expect(snap.coins['BTC']!.state).toBe('WATCHING')
    expect(snap.global.dailyPnl).toBe(0)
    expect(snap.global.globalPaused).toBe(false)
    expect(typeof snap.global.uptime).toBe('number')
  })

  it('recordPnl updates global state', () => {
    agent.recordPnl(-50)
    expect(agent.getGlobal().dailyPnl).toBe(-50)
    expect(agent.getGlobal().totalConsecutiveLosses).toBe(1)

    agent.recordPnl(100)
    expect(agent.getGlobal().dailyPnl).toBe(50)
    expect(agent.getGlobal().totalConsecutiveLosses).toBe(0)
  })

  it('subscribes to pipeline EventEmitter', () => {
    const emitter = new EventEmitter()
    agent.subscribeToPipeline(emitter)

    const setup = makeSetup({ confluenceGrade: 'A' })
    emitter.emit('setup', setup)

    expect(agent.getCoinState('BTC')).toBe('WATCHING')
  })

  it('handles pipeline invalidation events', () => {
    const emitter = new EventEmitter()
    agent.subscribeToPipeline(emitter)

    // First put in WATCHING
    const setup = makeSetup({ confluenceGrade: 'A' })
    emitter.emit('setup', setup)
    expect(agent.getCoinState('BTC')).toBe('WATCHING')

    // Invalidate
    emitter.emit('invalidation', 'BTC:1h:order-block:long', 'zone-broken')
    expect(agent.getCoinState('BTC')).toBe('IDLE')
  })

  it('emits actions for orchestrator', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })

    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some((a: any) => a.type === 'watch')).toBe(true)
  })

  it('crash recovery: exchange position → IN_POSITION', () => {
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 0.1, entryPrice: 50000 }],
      [{ coin: 'BTC', positionId: 'pos-1', side: 'long' }],
    )
    expect(agent.getCoinState('BTC')).toBe('IN_POSITION')
  })

  it('crash recovery: DB position not on exchange → IDLE', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.recoverFromCrash(
      [],  // nothing on exchange
      [{ coin: 'ETH', positionId: 'pos-2', side: 'long' }],
    )
    expect(agent.getCoinState('ETH')).toBe('IDLE')
    expect(actions.some((a: any) => a.eventType === 'exit' && a.details?.reason === 'crash_recovery_closed')).toBe(true)
  })

  it('crash recovery: orphan exchange position (not in DB)', () => {
    agent.recoverFromCrash(
      [{ coin: 'SOL', size: 0.5, entryPrice: 100 }],
      [],  // nothing in DB
    )
    expect(agent.getCoinState('SOL')).toBe('IN_POSITION')
    const snap = agent.getSnapshot()
    expect(snap.coins['SOL']!.positionId).toContain('orphan')
  })
})
