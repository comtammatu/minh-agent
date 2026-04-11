/**
 * Multi-strategy independence tests (Sprint 4.5 S5).
 *
 * V2:  Agent state key = `coin:strategyId` — same coin, different strategies → independent states.
 * V6:  Per-strategy GlobalContext — dailyPnl, circuit breakers isolated per strategy.
 * V7:  Cross-strategy allowed — different strategies CAN hold same coin same direction.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { TradingAgent, resetAgent, stateKey, parseStateKey } from '../../src/agent/trading-agent.js'
import type { CoinContext, GlobalContext } from '../../src/agent/types.js'
import type { ActiveSetup } from '../../src/types.js'

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
    ...overrides,
  }
}

// ── State Key Utilities ──────────────────────────────────────────────────────

describe('stateKey / parseStateKey', () => {
  it('builds key from coin + strategyId', () => {
    expect(stateKey('BTC', 'smc-sd')).toBe('BTC:smc-sd')
    expect(stateKey('ETH', 'alpha')).toBe('ETH:alpha')
  })

  it('defaults strategyId to layered', () => {
    expect(stateKey('BTC')).toBe('BTC:smc-sd')
  })

  it('parses key back to coin + strategyId', () => {
    const { coin, strategyId } = parseStateKey('BTC:alpha')
    expect(coin).toBe('BTC')
    expect(strategyId).toBe('alpha')
  })

  it('parses key without colon as default strategy', () => {
    const { coin, strategyId } = parseStateKey('BTC')
    expect(coin).toBe('BTC')
    expect(strategyId).toBe('smc-sd')
  })

  it('handles coin names with special chars', () => {
    // No coin names contain colons, but test robustness
    const { coin, strategyId } = parseStateKey('1000PEPE:smc-sd')
    expect(coin).toBe('1000PEPE')
    expect(strategyId).toBe('smc-sd')
  })
})

// ── Multi-Strategy State Independence ────────────────────────────────────────

describe('Multi-strategy state independence', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('same coin, different strategies → independent states (V2)', () => {
    const layeredSetup = makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' })
    const quantSetup = makeSetup({ strategyId: 'alpha', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' })

    // Dispatch to two different strategies for same coin
    agent.dispatch('BTC', { type: 'setup_detected', setup: layeredSetup }, 'smc-sd')
    agent.dispatch('BTC', { type: 'setup_detected', setup: quantSetup }, 'alpha')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('ENTERING')
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')

    // Invalidate layered — quant should remain WATCHING
    agent.dispatch('BTC', {
      type: 'setup_invalidated',
      setupId: layeredSetup.id,
      reason: 'zone-broken',
    }, 'smc-sd')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IDLE')
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')
  })

  it('different coins, same strategy → independent states', () => {
    const btcSetup = makeSetup({ coin: 'BTC', strategyId: 'alpha', confluenceGrade: 'A' })
    const ethSetup = makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'alpha', confluenceGrade: 'B' })

    agent.dispatch('BTC', { type: 'setup_detected', setup: btcSetup }, 'alpha')
    agent.dispatch('ETH', { type: 'setup_detected', setup: ethSetup }, 'alpha')

    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')
    expect(agent.getCoinState('ETH', 'alpha')).toBe('ENTERING')

    // Pause BTC only (via dispatch), ETH unaffected
    agent.dispatch('BTC', { type: 'pause', reason: 'manual' }, 'alpha')

    expect(agent.getCoinState('BTC', 'alpha')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'alpha')).toBe('ENTERING')
  })

  it('onSetup routes to correct strategy from setup.strategyId', () => {
    const setup = makeSetup({ strategyId: 'alpha', confluenceGrade: 'A' })
    agent.onSetup(setup)

    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')
    // Default strategy should still be IDLE
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IDLE')
  })

  it('onSetup defaults to layered when no strategyId', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    delete (setup as Record<string, unknown>).strategyId
    agent.onSetup(setup)

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('ENTERING')
  })

  it('getCoinState defaults to layered for backward compat', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    agent.dispatch('BTC', { type: 'setup_detected', setup }, 'smc-sd')

    // No strategyId argument → defaults to 'smc-sd'
    expect(agent.getCoinState('BTC')).toBe('ENTERING')
  })
})

// ── Per-Strategy GlobalContext Isolation ──────────────────────────────────────

describe('Per-strategy GlobalContext (V6)', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('each strategy has independent dailyPnl', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(200, 10000, 'BTC', 'alpha')

    expect(agent.getStrategyGlobal('smc-sd').dailyPnl).toBe(-100)
    expect(agent.getStrategyGlobal('alpha').dailyPnl).toBe(200)
  })

  it('each strategy has independent consecutive loss count', () => {
    agent.recordPnl(-50, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(-50, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(100, 10000, 'BTC', 'alpha')

    expect(agent.getStrategyGlobal('smc-sd').totalConsecutiveLosses).toBe(2)
    expect(agent.getStrategyGlobal('alpha').totalConsecutiveLosses).toBe(0)
  })

  it('each strategy has independent pnlHistory', () => {
    agent.recordPnl(-50, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(-30, 10000, 'ETH', 'alpha')
    agent.recordPnl(100, 10000, 'BTC', 'smc-sd')

    expect(agent.getStrategyGlobal('smc-sd').pnlHistory).toHaveLength(2)
    expect(agent.getStrategyGlobal('alpha').pnlHistory).toHaveLength(1)
  })

  it('each strategy has independent peakAccountValue', () => {
    agent.updateAccountValue(10000, 'smc-sd')
    agent.updateAccountValue(5000, 'alpha')

    expect(agent.getStrategyGlobal('smc-sd').peakAccountValue).toBe(10000)
    expect(agent.getStrategyGlobal('alpha').peakAccountValue).toBe(5000)
  })

  it('resetDailyPnl resets all strategies', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(-200, 10000, 'BTC', 'alpha')

    agent.resetDailyPnl()

    expect(agent.getStrategyGlobal('smc-sd').dailyPnl).toBe(0)
    expect(agent.getStrategyGlobal('alpha').dailyPnl).toBe(0)
  })

  it('getGlobal() returns default strategy for backward compat', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'smc-sd')
    expect(agent.getGlobal().dailyPnl).toBe(-100)
  })
})

// ── Per-Strategy Circuit Breaker Isolation ────────────────────────────────────

describe('Per-strategy circuit breakers (V6)', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('CB on strategy A does NOT affect strategy B', () => {
    // Put BTC watching on both strategies
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'alpha', id: 'BTC|1h|breakout|long', confluenceGrade: 'A' }),
    }, 'alpha')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('ENTERING')
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')

    // Trip CB on layered (3.5% daily loss)
    agent.recordPnl(-350, 10000, 'ETH', 'smc-sd')

    // Layered should be paused, quant should remain WATCHING
    expect(agent.getStrategyGlobal('smc-sd').globalPaused).toBe(true)
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('PAUSED')

    expect(agent.getStrategyGlobal('alpha').globalPaused).toBe(false)
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')
  })

  it('CB respects R5 per-strategy: IN_POSITION coins keep SL/TP', () => {
    // Put BTC IN_POSITION for layered via internal state
    const coinsMap = (agent as unknown as { coins: Map<string, CoinContext> }).coins
    coinsMap.set('BTC:smc-sd', {
      state: 'IN_POSITION',
      coin: 'BTC',
      strategyId: 'smc-sd',
      activeSetup: null,
      pendingOrderId: null,
      positionId: 'pos-1',
      stateEnteredAt: Date.now(),
      consecutiveLosses: 0,
      pauseReason: null,
      pauseUntil: null,
    })

    // Put ETH ENTERING for layered
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')

    // Trip CB on layered
    agent.recordPnl(-400, 10000, 'SOL', 'smc-sd')

    // R5: BTC IN_POSITION stays, ETH gets paused
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IN_POSITION')
    expect(agent.getCoinState('ETH', 'smc-sd')).toBe('PAUSED')
  })

  it('pauseStrategy only pauses one strategy', () => {
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'alpha', confluenceGrade: 'A' }),
    }, 'alpha')

    agent.pauseStrategy('smc-sd', 'manual test')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'alpha')).toBe('ENTERING')
    expect(agent.getStrategyGlobal('smc-sd').globalPaused).toBe(true)
    expect(agent.getStrategyGlobal('alpha').globalPaused).toBe(false)
  })

  it('resumeStrategy only resumes one strategy', () => {
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'alpha', confluenceGrade: 'A' }),
    }, 'alpha')

    // Pause both
    agent.pauseAll('test')
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'alpha')).toBe('PAUSED')

    // Resume only quant
    agent.resumeStrategy('alpha')
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'alpha')).toBe('IDLE')
  })
})

// ── Snapshot ──────────────────────────────────────────────────────────────────

describe('Multi-strategy snapshot', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('snapshot includes strategyId in coin entries', () => {
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'alpha', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' }),
    }, 'alpha')

    const snap = agent.getSnapshot()

    expect(snap.coins['BTC:smc-sd']).toBeDefined()
    expect(snap.coins['BTC:smc-sd']!.strategyId).toBe('smc-sd')
    expect(snap.coins['BTC:smc-sd']!.state).toBe('ENTERING')

    expect(snap.coins['BTC:alpha']).toBeDefined()
    expect(snap.coins['BTC:alpha']!.strategyId).toBe('alpha')
    expect(snap.coins['BTC:alpha']!.state).toBe('ENTERING')
  })

  it('snapshot includes per-strategy globals', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'smc-sd')
    agent.recordPnl(50, 10000, 'BTC', 'alpha')

    const snap = agent.getSnapshot()

    expect(snap.strategyGlobals).toBeDefined()
    expect(snap.strategyGlobals!['smc-sd']!.dailyPnl).toBe(-100)
    expect(snap.strategyGlobals!['alpha']!.dailyPnl).toBe(50)
  })

  it('snapshot.global is backward-compat default strategy', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'smc-sd')
    const snap = agent.getSnapshot()
    expect(snap.global.dailyPnl).toBe(-100)
  })
})

// ── Full Lifecycle: Two Strategies, Same Coin ────────────────────────────────

describe('Full lifecycle: two strategies, same coin', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('independent lifecycle from IDLE to EXITING', () => {
    // Both strategies detect BTC setup
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'smc-sd', confluenceGrade: 'A' }),
    }, 'smc-sd')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'alpha', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' }),
    }, 'alpha')

    // Both ENTERING (place_order emitted)
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('ENTERING')
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')

    // Layered progresses to IN_POSITION (order filled)
    agent.dispatch('BTC', {
      type: 'order_filled',
      orderId: 'ord-L1',
      fillPrice: 50000,
      positionId: 'pos-L1',
    }, 'smc-sd')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IN_POSITION')
    expect(agent.getCoinState('BTC', 'alpha')).toBe('ENTERING')  // still ENTERING

    // Quant invalidated — goes IDLE
    agent.dispatch('BTC', {
      type: 'setup_invalidated',
      setupId: 'BTC|1h|breakout|long',
      reason: 'expired',
    }, 'alpha')

    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IN_POSITION')  // unaffected
    expect(agent.getCoinState('BTC', 'alpha')).toBe('IDLE')

    // Layered TP hit → EXITING → IDLE
    agent.dispatch('BTC', {
      type: 'tp_hit',
      positionId: 'pos-L1',
      closePrice: 52000,
      pnl: 200,
    }, 'smc-sd')
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('EXITING')

    agent.dispatch('BTC', {
      type: 'position_closed',
      positionId: 'pos-L1',
      closePrice: 52000,
      pnl: 200,
      reason: 'tp_hit',
    }, 'smc-sd')
    expect(agent.getCoinState('BTC', 'smc-sd')).toBe('IDLE')
  })
})

// ── Cross-Strategy Open Positions ────────────────────────────────────────────

describe('Cross-strategy open positions (V7)', () => {
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    agent = new TradingAgent()
  })

  it('getOpenPositionCoins returns unique coins across all strategies', () => {
    const coinsMap = (agent as unknown as { coins: Map<string, CoinContext> }).coins

    // BTC in position for both strategies
    coinsMap.set('BTC:smc-sd', {
      state: 'IN_POSITION', coin: 'BTC', strategyId: 'smc-sd',
      activeSetup: null, pendingOrderId: null, positionId: 'pos-L1',
      stateEnteredAt: Date.now(), consecutiveLosses: 0,
      pauseReason: null, pauseUntil: null,
    })
    coinsMap.set('BTC:alpha', {
      state: 'IN_POSITION', coin: 'BTC', strategyId: 'alpha',
      activeSetup: null, pendingOrderId: null, positionId: 'pos-Q1',
      stateEnteredAt: Date.now(), consecutiveLosses: 0,
      pauseReason: null, pauseUntil: null,
    })

    // BTC should appear only once (deduped by coin)
    const openCoins = agent.getOpenPositionCoins()
    expect(openCoins.filter(c => c === 'BTC')).toHaveLength(1)
    expect(openCoins).toContain('BTC')
  })
})
