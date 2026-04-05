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
    type: 'order-block',
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
    expect(stateKey('BTC', 'layered')).toBe('BTC:layered')
    expect(stateKey('ETH', 'quant')).toBe('ETH:quant')
  })

  it('defaults strategyId to layered', () => {
    expect(stateKey('BTC')).toBe('BTC:layered')
  })

  it('parses key back to coin + strategyId', () => {
    const { coin, strategyId } = parseStateKey('BTC:quant')
    expect(coin).toBe('BTC')
    expect(strategyId).toBe('quant')
  })

  it('parses key without colon as default strategy', () => {
    const { coin, strategyId } = parseStateKey('BTC')
    expect(coin).toBe('BTC')
    expect(strategyId).toBe('layered')
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
    const layeredSetup = makeSetup({ strategyId: 'layered', confluenceGrade: 'A' })
    const quantSetup = makeSetup({ strategyId: 'quant', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' })

    // Dispatch to two different strategies for same coin
    agent.dispatch('BTC', { type: 'setup_detected', setup: layeredSetup }, 'layered')
    agent.dispatch('BTC', { type: 'setup_detected', setup: quantSetup }, 'quant')

    expect(agent.getCoinState('BTC', 'layered')).toBe('WATCHING')
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')

    // Invalidate layered — quant should remain WATCHING
    agent.dispatch('BTC', {
      type: 'setup_invalidated',
      setupId: layeredSetup.id,
      reason: 'zone-broken',
    }, 'layered')

    expect(agent.getCoinState('BTC', 'layered')).toBe('IDLE')
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')
  })

  it('different coins, same strategy → independent states', () => {
    const btcSetup = makeSetup({ coin: 'BTC', strategyId: 'quant', confluenceGrade: 'A' })
    const ethSetup = makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'quant', confluenceGrade: 'B' })

    agent.dispatch('BTC', { type: 'setup_detected', setup: btcSetup }, 'quant')
    agent.dispatch('ETH', { type: 'setup_detected', setup: ethSetup }, 'quant')

    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')
    expect(agent.getCoinState('ETH', 'quant')).toBe('WATCHING')

    // Pause BTC only (via dispatch), ETH unaffected
    agent.dispatch('BTC', { type: 'pause', reason: 'manual' }, 'quant')

    expect(agent.getCoinState('BTC', 'quant')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'quant')).toBe('WATCHING')
  })

  it('onSetup routes to correct strategy from setup.strategyId', () => {
    const setup = makeSetup({ strategyId: 'quant', confluenceGrade: 'A' })
    agent.onSetup(setup)

    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')
    // Default strategy should still be IDLE
    expect(agent.getCoinState('BTC', 'layered')).toBe('IDLE')
  })

  it('onSetup defaults to layered when no strategyId', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    delete (setup as Record<string, unknown>).strategyId
    agent.onSetup(setup)

    expect(agent.getCoinState('BTC', 'layered')).toBe('WATCHING')
  })

  it('getCoinState defaults to layered for backward compat', () => {
    const setup = makeSetup({ confluenceGrade: 'A' })
    agent.dispatch('BTC', { type: 'setup_detected', setup }, 'layered')

    // No strategyId argument → defaults to 'layered'
    expect(agent.getCoinState('BTC')).toBe('WATCHING')
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
    agent.recordPnl(-100, 10000, 'BTC', 'layered')
    agent.recordPnl(200, 10000, 'BTC', 'quant')

    expect(agent.getStrategyGlobal('layered').dailyPnl).toBe(-100)
    expect(agent.getStrategyGlobal('quant').dailyPnl).toBe(200)
  })

  it('each strategy has independent consecutive loss count', () => {
    agent.recordPnl(-50, 10000, 'BTC', 'layered')
    agent.recordPnl(-50, 10000, 'BTC', 'layered')
    agent.recordPnl(100, 10000, 'BTC', 'quant')

    expect(agent.getStrategyGlobal('layered').totalConsecutiveLosses).toBe(2)
    expect(agent.getStrategyGlobal('quant').totalConsecutiveLosses).toBe(0)
  })

  it('each strategy has independent pnlHistory', () => {
    agent.recordPnl(-50, 10000, 'BTC', 'layered')
    agent.recordPnl(-30, 10000, 'ETH', 'quant')
    agent.recordPnl(100, 10000, 'BTC', 'layered')

    expect(agent.getStrategyGlobal('layered').pnlHistory).toHaveLength(2)
    expect(agent.getStrategyGlobal('quant').pnlHistory).toHaveLength(1)
  })

  it('each strategy has independent peakAccountValue', () => {
    agent.updateAccountValue(10000, 'layered')
    agent.updateAccountValue(5000, 'quant')

    expect(agent.getStrategyGlobal('layered').peakAccountValue).toBe(10000)
    expect(agent.getStrategyGlobal('quant').peakAccountValue).toBe(5000)
  })

  it('resetDailyPnl resets all strategies', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'layered')
    agent.recordPnl(-200, 10000, 'BTC', 'quant')

    agent.resetDailyPnl()

    expect(agent.getStrategyGlobal('layered').dailyPnl).toBe(0)
    expect(agent.getStrategyGlobal('quant').dailyPnl).toBe(0)
  })

  it('getGlobal() returns default strategy for backward compat', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'layered')
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
      setup: makeSetup({ strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'quant', id: 'BTC|1h|breakout|long', confluenceGrade: 'A' }),
    }, 'quant')

    expect(agent.getCoinState('BTC', 'layered')).toBe('WATCHING')
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')

    // Trip CB on layered (3.5% daily loss)
    agent.recordPnl(-350, 10000, 'ETH', 'layered')

    // Layered should be paused, quant should remain WATCHING
    expect(agent.getStrategyGlobal('layered').globalPaused).toBe(true)
    expect(agent.getCoinState('BTC', 'layered')).toBe('PAUSED')

    expect(agent.getStrategyGlobal('quant').globalPaused).toBe(false)
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')
  })

  it('CB respects R5 per-strategy: IN_POSITION coins keep SL/TP', () => {
    // Put BTC IN_POSITION for layered via internal state
    const coinsMap = (agent as unknown as { coins: Map<string, CoinContext> }).coins
    coinsMap.set('BTC:layered', {
      state: 'IN_POSITION',
      coin: 'BTC',
      strategyId: 'layered',
      activeSetup: null,
      pendingOrderId: null,
      positionId: 'pos-1',
      stateEnteredAt: Date.now(),
      consecutiveLosses: 0,
      pauseReason: null,
      pauseUntil: null,
    })

    // Put ETH WATCHING for layered
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')

    // Trip CB on layered
    agent.recordPnl(-400, 10000, 'SOL', 'layered')

    // R5: BTC IN_POSITION stays, ETH gets paused
    expect(agent.getCoinState('BTC', 'layered')).toBe('IN_POSITION')
    expect(agent.getCoinState('ETH', 'layered')).toBe('PAUSED')
  })

  it('pauseStrategy only pauses one strategy', () => {
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'quant', confluenceGrade: 'A' }),
    }, 'quant')

    agent.pauseStrategy('layered', 'manual test')

    expect(agent.getCoinState('BTC', 'layered')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'quant')).toBe('WATCHING')
    expect(agent.getStrategyGlobal('layered').globalPaused).toBe(true)
    expect(agent.getStrategyGlobal('quant').globalPaused).toBe(false)
  })

  it('resumeStrategy only resumes one strategy', () => {
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')
    agent.dispatch('ETH', {
      type: 'setup_detected',
      setup: makeSetup({ coin: 'ETH', id: 'ETH|1h|ob|long', strategyId: 'quant', confluenceGrade: 'A' }),
    }, 'quant')

    // Pause both
    agent.pauseAll('test')
    expect(agent.getCoinState('BTC', 'layered')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'quant')).toBe('PAUSED')

    // Resume only quant
    agent.resumeStrategy('quant')
    expect(agent.getCoinState('BTC', 'layered')).toBe('PAUSED')
    expect(agent.getCoinState('ETH', 'quant')).toBe('IDLE')
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
      setup: makeSetup({ strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'quant', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' }),
    }, 'quant')

    const snap = agent.getSnapshot()

    expect(snap.coins['BTC:layered']).toBeDefined()
    expect(snap.coins['BTC:layered']!.strategyId).toBe('layered')
    expect(snap.coins['BTC:layered']!.state).toBe('WATCHING')

    expect(snap.coins['BTC:quant']).toBeDefined()
    expect(snap.coins['BTC:quant']!.strategyId).toBe('quant')
    expect(snap.coins['BTC:quant']!.state).toBe('WATCHING')
  })

  it('snapshot includes per-strategy globals', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'layered')
    agent.recordPnl(50, 10000, 'BTC', 'quant')

    const snap = agent.getSnapshot()

    expect(snap.strategyGlobals).toBeDefined()
    expect(snap.strategyGlobals!['layered']!.dailyPnl).toBe(-100)
    expect(snap.strategyGlobals!['quant']!.dailyPnl).toBe(50)
  })

  it('snapshot.global is backward-compat default strategy', () => {
    agent.recordPnl(-100, 10000, 'BTC', 'layered')
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
      setup: makeSetup({ strategyId: 'layered', confluenceGrade: 'A' }),
    }, 'layered')
    agent.dispatch('BTC', {
      type: 'setup_detected',
      setup: makeSetup({ strategyId: 'quant', id: 'BTC|1h|breakout|long', confluenceGrade: 'B' }),
    }, 'quant')

    // Both WATCHING
    expect(agent.getCoinState('BTC', 'layered')).toBe('WATCHING')
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')

    // Layered progresses to IN_POSITION
    const coinsMap = (agent as unknown as { coins: Map<string, CoinContext> }).coins
    const layeredCtx = coinsMap.get('BTC:layered')!
    layeredCtx.state = 'ENTERING'
    layeredCtx.pendingOrderId = 'ord-L1'
    layeredCtx.stateEnteredAt = Date.now()

    agent.dispatch('BTC', {
      type: 'order_filled',
      orderId: 'ord-L1',
      fillPrice: 50000,
      positionId: 'pos-L1',
    }, 'layered')

    expect(agent.getCoinState('BTC', 'layered')).toBe('IN_POSITION')
    expect(agent.getCoinState('BTC', 'quant')).toBe('WATCHING')  // still WATCHING

    // Quant invalidated — goes IDLE
    agent.dispatch('BTC', {
      type: 'setup_invalidated',
      setupId: 'BTC|1h|breakout|long',
      reason: 'expired',
    }, 'quant')

    expect(agent.getCoinState('BTC', 'layered')).toBe('IN_POSITION')  // unaffected
    expect(agent.getCoinState('BTC', 'quant')).toBe('IDLE')

    // Layered TP hit → EXITING → IDLE
    agent.dispatch('BTC', {
      type: 'tp_hit',
      positionId: 'pos-L1',
      closePrice: 52000,
      pnl: 200,
    }, 'layered')
    expect(agent.getCoinState('BTC', 'layered')).toBe('EXITING')

    agent.dispatch('BTC', {
      type: 'position_closed',
      positionId: 'pos-L1',
      closePrice: 52000,
      pnl: 200,
      reason: 'tp_hit',
    }, 'layered')
    expect(agent.getCoinState('BTC', 'layered')).toBe('IDLE')
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
    coinsMap.set('BTC:layered', {
      state: 'IN_POSITION', coin: 'BTC', strategyId: 'layered',
      activeSetup: null, pendingOrderId: null, positionId: 'pos-L1',
      stateEnteredAt: Date.now(), consecutiveLosses: 0,
      pauseReason: null, pauseUntil: null,
    })
    coinsMap.set('BTC:quant', {
      state: 'IN_POSITION', coin: 'BTC', strategyId: 'quant',
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
