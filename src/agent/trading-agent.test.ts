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
    id: 'BTC|1h|order-block|long',
    coin: 'BTC',
    interval: '1h',
    type: 'smc-sd',
    side: 'long',
    confidence: 0.75,
    entryPrice: 50000,
    slPrice: 49000,
    tpPrice: 52000,
    patternData: {},
    detectedAt: Date.now(),
    detectedAtBar: 0,
    expiresAtBar: 100,
    confluenceGrade: 'B',
    confluenceCount: 4,
    exchange: 'HL',
    ...overrides,
  }
}

function makeCoinCtx(overrides: Partial<CoinContext> = {}): CoinContext {
  return {
    state: 'IDLE',
    coin: 'BTC',
    strategyId: 'smc-sd',
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
    pnlHistory: [],
    ...overrides,
  }
}

// ── Pure Handler Tests ───────────────────────────────────────────────────────

describe('handleIdle', () => {
  it('transitions to ENTERING on grade B setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'B' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('ENTERING')
    expect(result.actions.some(a => a.type === 'place_order')).toBe(true)
  })

  it('transitions to ENTERING on grade A setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'A' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('ENTERING')
  })

  it('transitions to ENTERING on grade A+ setup', () => {
    const ctx = makeCoinCtx()
    const setup = makeSetup({ confluenceGrade: 'A+' })
    const result = handleIdle(ctx, { type: 'setup_detected', setup }, makeGlobal())
    expect(result.nextState).toBe('ENTERING')
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
    const skip = result.actions.find(
      a => a.type === 'log_journal' && a.eventType === 'skip',
    ) as { details?: { reason?: string } } | undefined
    expect(skip?.details?.reason).toMatch(/Grade C below B/)
  })

  it('stays WATCHING with skip when new setup is not higher confidence', () => {
    const setup = makeSetup({ confidence: 0.7, id: 'active-id' })
    const ctx = makeCoinCtx({ state: 'WATCHING', activeSetup: setup })
    const sameConf = makeSetup({ confluenceGrade: 'A', confidence: 0.7, id: 'new-id' })
    const result = handleWatching(ctx, { type: 'setup_detected', setup: sameConf }, makeGlobal())
    expect(result.nextState).toBe('WATCHING')
    const skip = result.actions.find(
      a => a.type === 'log_journal' && a.eventType === 'skip',
    ) as { details?: { reason?: string } } | undefined
    expect(skip?.details?.reason).toMatch(/not above active/)
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
      type: 'setup_invalidated', setupId: 'BTC|1h|ob|long', reason: 'zone-broken',
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
      type: 'setup_invalidated', setupId: 'BTC|1h|ob|long', reason: 'zone-broken',
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

  it('transitions to IDLE on loss (CB checks moved to orchestrator S11)', () => {
    // S11: Inline CB logic removed from handleExiting. CB checks run via
    // TradingAgent.checkCircuitBreakers() after recordPnl(). Handler just exits.
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 2 })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 49000, pnl: -100, reason: 'sl_hit',
    }, makeGlobal())
    expect(result.nextState).toBe('IDLE')
  })

  it('transitions to PAUSED when global paused', () => {
    const ctx = makeCoinCtx({ state: 'EXITING', positionId: 'pos-1', consecutiveLosses: 0 })
    const global = makeGlobal({ globalPaused: true })
    const result = handleExiting(ctx, {
      type: 'position_closed', positionId: 'pos-1', closePrice: 52000, pnl: 200, reason: 'tp_hit',
    }, global)
    expect(result.nextState).toBe('PAUSED')
  })

  it('retries close on exit timeout (stays EXITING)', () => {
    const ctx = makeCoinCtx({
      state: 'EXITING',
      positionId: 'pos-timeout',
      stateEnteredAt: Date.now() - 6 * 60 * 1000,
    })
    const result = handleExiting(ctx, { type: 'tick' }, makeGlobal())
    expect(result.nextState).toBe('EXITING')
    expect(result.actions.some(a => a.type === 'close_position')).toBe(true)
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
    const skip = result.actions.find(
      a => a.type === 'log_journal' && a.eventType === 'skip',
    ) as { details?: { reason?: string } } | undefined
    expect(skip?.details?.reason).toMatch(/paused \(manual\)/)
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

  it('dispatches setup_detected → ENTERING', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    const result = agent.dispatch('BTC', { type: 'setup_detected', setup })
    expect(result.nextState).toBe('ENTERING')
    expect(agent.getCoinState('BTC')).toBe('ENTERING')
  })

  it('full lifecycle: IDLE → ENTERING → IN_POSITION → EXITING → IDLE', () => {
    const setup = makeSetup({ confluenceGrade: 'B' })

    // IDLE → ENTERING (place_order emitted)
    agent.dispatch('BTC', { type: 'setup_detected', setup })
    expect(agent.getCoinState('BTC')).toBe('ENTERING')

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
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', confluenceGrade: 'B' }) })

    expect(agent.getCoinState('BTC')).toBe('ENTERING')
    expect(agent.getCoinState('ETH')).toBe('ENTERING')
    expect(agent.getCoinState('SOL')).toBe('IDLE')  // never touched
  })

  it('pauseAll pauses all coins', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', confluenceGrade: 'B' }) })

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
    expect(snap.coins['BTC:smc-sd']).toBeDefined()
    expect(snap.coins['BTC:smc-sd']!.state).toBe('ENTERING')
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

    expect(agent.getCoinState('BTC')).toBe('ENTERING')
  })

  it('handles pipeline invalidation events via bridge', () => {
    const { InvalidationBridge } = require('./invalidation-bridge.js')
    const emitter = new EventEmitter()
    const bridge = new InvalidationBridge()

    agent.subscribeToPipeline(emitter)
    bridge.connect(emitter, agent)

    // First put in ENTERING
    const setup = makeSetup({ confluenceGrade: 'A' })
    emitter.emit('setup', setup)
    expect(agent.getCoinState('BTC')).toBe('ENTERING')

    // Invalidate — bridge validates setupId match before dispatch
    emitter.emit('invalidation', 'BTC|1h|order-block|long', 'zone-broken')
    expect(agent.getCoinState('BTC')).toBe('IDLE')
  })

  it('emits actions for orchestrator', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })

    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some((a: any) => a.type === 'place_order')).toBe(true)
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
    expect(snap.coins['SOL:smc-sd']!.positionId).toContain('orphan')
  })

  it('crash recovery: prefers unique side match for same coin', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.recoverFromCrash(
      [{ coin: 'BTC', size: -0.25, entryPrice: 50000 }],
      [
        { coin: 'BTC', positionId: 'pos-long', side: 'long', strategyId: 'trend' },
        { coin: 'BTC', positionId: 'pos-short', side: 'short', strategyId: 'mean-revert' },
      ],
    )

    expect(agent.getCoinState('BTC', 'mean-revert')).toBe('IN_POSITION')
    expect(agent.getCoinContext('BTC', 'mean-revert')?.positionId).toBe('pos-short')
    expect(agent.getCoinState('BTC', 'trend')).toBe('IDLE')
    expect(actions.some((a: any) => a.eventType === 'exit' && a.details?.positionId === 'pos-long')).toBe(true)
  })

  it('crash recovery: preserves orphan ownership when same coin + side is ambiguous', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 0.5, entryPrice: 50000 }],
      [
        { coin: 'BTC', positionId: 'pos-a', side: 'long', strategyId: 'trend' },
        { coin: 'BTC', positionId: 'pos-b', side: 'long', strategyId: 'mean-revert' },
      ],
    )

    expect(agent.getCoinState('BTC')).toBe('IN_POSITION')
    expect(agent.getCoinContext('BTC')?.positionId).toBe('orphan-BTC')
    expect(agent.getCoinState('BTC', 'trend')).toBe('IDLE')
    expect(agent.getCoinState('BTC', 'mean-revert')).toBe('IDLE')
    expect(actions.some((a: any) => a.eventType === 'exit' && a.coin === 'BTC')).toBe(false)
  })

  it('crash recovery: prefers exchange strategyId when present', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 0.5, entryPrice: 50000, strategyId: 'mean-revert' }],
      [
        { coin: 'BTC', positionId: 'pos-trend', side: 'long', strategyId: 'trend' },
        { coin: 'BTC', positionId: 'pos-mean', side: 'long', strategyId: 'mean-revert' },
      ],
    )

    expect(agent.getCoinState('BTC', 'mean-revert')).toBe('IN_POSITION')
    expect(agent.getCoinContext('BTC', 'mean-revert')?.positionId).toBe('pos-mean')
    expect(agent.getCoinState('BTC', 'trend')).toBe('IDLE')
    expect(actions.some((a: any) => a.eventType === 'exit' && a.details?.positionId === 'pos-trend')).toBe(true)
  })

  // ── Circuit Breaker Integration (S11) ───────────────────────────────────

  it('checkCircuitBreakers pauses on daily loss', () => {
    // Put BTC in ENTERING
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    expect(agent.getCoinState('BTC')).toBe('ENTERING')

    // Simulate daily loss > 3% of 10000
    agent.recordPnl(-350, 10000)  // -3.5% → trips daily loss CB

    expect(agent.getGlobal().globalPaused).toBe(true)
    expect(agent.getCoinState('BTC')).toBe('PAUSED')
  })

  it('checkCircuitBreakers does NOT pause IN_POSITION coins (R5)', () => {
    // Put BTC in IN_POSITION
    const btcCtx = (agent as unknown as { coins: Map<string, CoinContext> }).coins
    btcCtx.set('BTC:smc-sd', makeCoinCtx({ state: 'IN_POSITION', positionId: 'pos-1', coin: 'BTC' }))

    // Put ETH in ENTERING
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', confluenceGrade: 'A' }) })

    // Trigger daily loss CB
    agent.recordPnl(-400, 10000)

    // R5: BTC stays IN_POSITION, ETH gets paused
    expect(agent.getCoinState('BTC')).toBe('IN_POSITION')
    expect(agent.getCoinState('ETH')).toBe('PAUSED')
  })

  it('checkCircuitBreakers trips on rapid loss', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })

    // Two rapid losses within 1h window that total > 2%
    agent.recordPnl(-120, 10000)  // -1.2%
    agent.recordPnl(-100, 10000)  // cumulative -2.2% in window → trips rapid

    expect(agent.getGlobal().globalPaused).toBe(true)
  })

  it('checkCircuitBreakers trips on max drawdown', () => {
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })

    // Set peak high, then check with low current value
    agent.updateAccountValue(10000)
    agent.checkCircuitBreakers(8900)  // 11% drawdown from peak → trips

    expect(agent.getGlobal().globalPaused).toBe(true)
    expect(agent.getCoinState('BTC')).toBe('PAUSED')
  })

  it('updateAccountValue tracks peak', () => {
    agent.updateAccountValue(10000)
    expect(agent.getGlobal().peakAccountValue).toBe(10000)

    agent.updateAccountValue(11000)
    expect(agent.getGlobal().peakAccountValue).toBe(11000)

    // Lower value does not update peak
    agent.updateAccountValue(9000)
    expect(agent.getGlobal().peakAccountValue).toBe(11000)
  })

  it('recordPnl pushes to pnlHistory', () => {
    agent.recordPnl(-50, 10000)
    agent.recordPnl(100, 10000)
    expect(agent.getGlobal().pnlHistory).toHaveLength(2)
    expect(agent.getGlobal().pnlHistory[0]!.pnl).toBe(-50)
    expect(agent.getGlobal().pnlHistory[1]!.pnl).toBe(100)
  })

  it('position close events update dailyPnl via recordPnl', () => {
    // Enter position first
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    agent.dispatch('BTC', { type: 'order_filled', positionId: 'pos-1', fillPrice: 100 })
    expect(agent.getCoinState('BTC')).toBe('IN_POSITION')

    // Close with PnL — should update global dailyPnl
    agent.dispatch('BTC', { type: 'position_closed', positionId: 'pos-1', closePrice: 110, pnl: 50, reason: 'tp_hit' })
    expect(agent.getGlobal().dailyPnl).toBe(50)

    // Another trade with loss
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', confluenceGrade: 'A' }) })
    agent.dispatch('ETH', { type: 'order_filled', positionId: 'pos-2', fillPrice: 200 })
    agent.dispatch('ETH', { type: 'sl_hit', positionId: 'pos-2', closePrice: 190, pnl: -30 })
    expect(agent.getGlobal().dailyPnl).toBe(20) // 50 - 30
  })

  it('checkCircuitBreakers emits journal action', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ confluenceGrade: 'A' }) })
    agent.recordPnl(-400, 10000)  // 4% daily loss → CB trips

    const cbActions = actions.filter((a: any) => a.eventType === 'circuit_break')
    expect(cbActions.length).toBeGreaterThan(0)
  })
})

// ─── S12: Anti-Correlation Guard Integration ─────────────────────────────────

describe('TradingAgent — correlation guard', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('allows entry when no correlated positions exist', () => {
    const result = agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'BTC', confluenceGrade: 'A' }),
    })
    expect(result.nextState).toBe('ENTERING')
  })

  it('blocks entry when correlated positions exceed limit', () => {
    const actions: unknown[] = []
    agent.onAction((a) => actions.push(a))

    // Put BTC and STX in position (both btc-ecosystem) via crash recovery
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 1, entryPrice: 50000 }, { coin: 'STX', size: 100, entryPrice: 1.5 }],
      [{ coin: 'BTC', positionId: 'p1', side: 'long' }, { coin: 'STX', positionId: 'p2', side: 'long' }],
    )

    // Try to enter ORDI (also btc-ecosystem) — should be blocked
    agent.onSetup(makeSetup({ coin: 'ORDI', id: 'ORDI|1h|ob|long', confluenceGrade: 'A' }))

    // ORDI should still be IDLE (blocked)
    expect(agent.getCoinState('ORDI')).toBe('IDLE')

    // Should have emitted a skip journal action
    const skipActions = actions.filter((a: any) => a.eventType === 'skip' && a.coin === 'ORDI')
    expect(skipActions.length).toBe(1)
    expect((skipActions[0] as any).details.reason).toContain('Correlated')
  })

  it('allows entry for coins in different groups', () => {
    // Put BTC in position via crash recovery
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 1, entryPrice: 50000 }],
      [{ coin: 'BTC', positionId: 'p1', side: 'long' }],
    )

    // ETH is in eth-ecosystem, not btc-ecosystem — should be allowed
    agent.onSetup(makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', confluenceGrade: 'A' }))
    expect(agent.getCoinState('ETH')).toBe('ENTERING')
  })

  it('allows entry for unknown coins (not in any group)', () => {
    // Fill btc-ecosystem with 2 positions
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 1, entryPrice: 50000 }, { coin: 'STX', size: 100, entryPrice: 1.5 }],
      [{ coin: 'BTC', positionId: 'p1', side: 'long' }, { coin: 'STX', positionId: 'p2', side: 'long' }],
    )

    // HYPE is not in any correlation group — should always pass
    agent.onSetup(makeSetup({ coin: 'HYPE', id: 'HYPE|1h|ob|long', confluenceGrade: 'A' }))
    expect(agent.getCoinState('HYPE')).toBe('ENTERING')
  })

  it('counts ENTERING state coins as open for correlation check', () => {
    // Put BTC in IN_POSITION via crash recovery
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 1, entryPrice: 50000 }],
      [{ coin: 'BTC', positionId: 'p1', side: 'long' }],
    )

    // Put STX in ENTERING via internal state (same pattern as CB tests)
    const coinsMap = (agent as unknown as { coins: Map<string, CoinContext> }).coins
    coinsMap.set('STX:smc-sd', makeCoinCtx({ state: 'ENTERING', coin: 'STX', pendingOrderId: 'o2' }))

    // ORDI blocked — BTC (IN_POSITION) + STX (ENTERING) = 2 in btc-ecosystem
    agent.onSetup(makeSetup({ coin: 'ORDI', id: 'ORDI|1h|ob|long', confluenceGrade: 'A' }))
    expect(agent.getCoinState('ORDI')).toBe('IDLE')
  })

  it('getOpenPositionCoins returns correct coins', () => {
    agent.recoverFromCrash(
      [{ coin: 'BTC', size: 1, entryPrice: 50000 }],
      [{ coin: 'BTC', positionId: 'p1', side: 'long' }],
    )

    // ETH in ENTERING — counted as open
    agent.dispatch('ETH', { type: 'setup_detected', setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', confluenceGrade: 'A' }) })

    const openCoins = agent.getOpenPositionCoins()
    expect(openCoins).toContain('BTC')       // IN_POSITION
    expect(openCoins).toContain('ETH')       // ENTERING — counted as open
  })

  it('does not block when coin is already ENTERING (re-evaluation)', () => {
    // BTC already in ENTERING — correlation guard only checks IDLE/WATCHING → new entry
    agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup({ coin: 'BTC', confluenceGrade: 'A' }) })
    expect(agent.getCoinState('BTC')).toBe('ENTERING')

    // Sending another setup while ENTERING — guard skips (not IDLE/WATCHING), handleEntering ignores it
    agent.onSetup(makeSetup({ coin: 'BTC', id: 'BTC|1h|ob2|long', confluenceGrade: 'A+', confidence: 0.9 }))
    // Should still be ENTERING
    expect(agent.getCoinState('BTC')).toBe('ENTERING')
  })
})
