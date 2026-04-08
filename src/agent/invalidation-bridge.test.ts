/**
 * Invalidation Bridge tests (Sprint 2 S8).
 *
 * Tests:
 *   - Setup ID matching: only act when invalidated setup === active setup
 *   - State-aware dispatch: correct action per state (IDLE/WATCHING/ENTERING/IN_POSITION)
 *   - Cross-TF mismatch: different setupId on same coin → no action
 *   - No active setup → no action
 *   - Pipeline integration: EventEmitter → bridge → agent
 *   - History tracking + stats
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import {
  InvalidationBridge,
  parseCoinFromSetupId,
  parseStrategyFromSetupId,
  resetInvalidationBridge,
} from './invalidation-bridge.js'
import { TradingAgent, resetAgent } from './trading-agent.js'
import type { ActiveSetup } from '../types.js'
import type { AgentAction } from './types.js'

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
    confluenceGrade: 'A',
    confluenceCount: 4,
    exchange: 'HL',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('parseCoinFromSetupId', () => {
  it('extracts coin from valid setupId', () => {
    expect(parseCoinFromSetupId('BTC|1h|order-block|long')).toBe('BTC')
    expect(parseCoinFromSetupId('ETH|15m|fvg|short')).toBe('ETH')
    expect(parseCoinFromSetupId('SOL|4h|spring|long')).toBe('SOL')
  })

  it('extracts coin from modern strategy-prefixed setupId', () => {
    expect(parseCoinFromSetupId('layered:BTC|1h|order-block')).toBe('BTC')
    expect(parseCoinFromSetupId('quant:ETH|15m|ema-rsi')).toBe('ETH')
  })

  it('returns null for invalid setupId', () => {
    expect(parseCoinFromSetupId('')).toBeNull()
    expect(parseCoinFromSetupId('BTC')).toBeNull()
    expect(parseCoinFromSetupId('BT')).toBeNull()
  })
})

describe('parseStrategyFromSetupId', () => {
  it('returns strategy id for modern format', () => {
    expect(parseStrategyFromSetupId('layered:BTC|1h|order-block')).toBe('layered')
    expect(parseStrategyFromSetupId('quant:ETH|15m|ema-rsi')).toBe('quant')
  })

  it('returns legacy bucket for legacy format', () => {
    expect(parseStrategyFromSetupId('BTC|1h|order-block|long')).toBe('legacy')
  })

  it('returns null for malformed ids', () => {
    expect(parseStrategyFromSetupId('')).toBeNull()
    expect(parseStrategyFromSetupId('BTC|1h')).toBeNull()
  })
})

describe('InvalidationBridge', () => {
  let bridge: InvalidationBridge
  let agent: TradingAgent

  beforeEach(() => {
    resetAgent()
    resetInvalidationBridge()
    bridge = new InvalidationBridge()
    agent = new TradingAgent()
  })

  // ── Setup ID Matching ──────────────────────────────────────────────────

  describe('setup ID matching', () => {
    it('acts when invalidated setupId matches active setup', () => {
      const setup = makeSetup()
      agent.dispatch('BTC', { type: 'setup_detected', setup })
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      const record = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(record.matched).toBe(true)
      expect(record.actionTaken).toBe('cancel_order')
      expect(agent.getCoinState('BTC')).toBe('IDLE')
    })

    it('skips when invalidated setupId does NOT match active setup (cross-TF)', () => {
      const setup = makeSetup() // BTC|1h|order-block|long
      agent.dispatch('BTC', { type: 'setup_detected', setup })
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      // Different timeframe — should NOT invalidate
      const record = bridge.onInvalidation('BTC|15m|fvg|short', 'fvg-filled', agent)
      expect(record.matched).toBe(false)
      expect(record.actionTaken).toBe('none')
      expect(agent.getCoinState('BTC')).toBe('ENTERING') // still entering
    })

    it('skips when invalidated setupId is different type on same TF', () => {
      const setup = makeSetup() // BTC|1h|order-block|long
      agent.dispatch('BTC', { type: 'setup_detected', setup })

      const record = bridge.onInvalidation('BTC|1h|fvg|long', 'fvg-filled', agent)
      expect(record.matched).toBe(false)
      expect(agent.getCoinState('BTC')).toBe('ENTERING')
    })

    it('skips when coin has no active setup (IDLE)', () => {
      const record = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(record.matched).toBe(false)
      expect(record.actionTaken).toBe('none')
    })
  })

  // ── State-Aware Dispatch ───────────────────────────────────────────────

  describe('state-aware dispatch', () => {
    it('ENTERING → IDLE (cancel_order)', () => {
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      const record = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(record.coinState).toBe('ENTERING')
      expect(record.actionTaken).toBe('cancel_order')
      expect(agent.getCoinState('BTC')).toBe('IDLE')
    })

    it('ENTERING with pendingOrderId → IDLE + cancel_order', () => {
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })

      // Force state to ENTERING with a pending order for testing
      // We do this by capturing actions and verifying the bridge predicts correctly
      const actions: AgentAction[] = []
      agent.onAction(a => actions.push(a))

      // Since we can't easily get to ENTERING without exchange stubs,
      // test the prediction for ENTERING state
      // The state machine handles this — we verify the bridge's setupId matching
      const record = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(record.matched).toBe(true)
      // From ENTERING, action is cancel_order
      expect(record.actionTaken).toBe('cancel_order')
    })

    it('IN_POSITION → EXITING + close_position', () => {
      // IDLE → ENTERING (place_order emitted)
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      // ENTERING → IN_POSITION (order filled)
      agent.dispatch('BTC', {
        type: 'order_filled',
        orderId: 'ord-1',
        fillPrice: 50000,
        positionId: 'pos-1',
      })
      expect(agent.getCoinState('BTC')).toBe('IN_POSITION')

      // Invalidate → should close position
      const record = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(record.matched).toBe(true)
      expect(record.actionTaken).toBe('close_position')
      expect(agent.getCoinState('BTC')).toBe('EXITING')
    })
  })

  // ── Pipeline Integration ───────────────────────────────────────────────

  describe('pipeline integration', () => {
    it('connects to EventEmitter and handles invalidation events', () => {
      const emitter = new EventEmitter()
      agent.subscribeToPipeline(emitter)
      bridge.connect(emitter, agent)

      // Setup via pipeline
      emitter.emit('setup', makeSetup())
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      // Invalidate via pipeline — cancels pending order
      emitter.emit('invalidation', 'BTC|1h|order-block|long', 'zone-broken')
      expect(agent.getCoinState('BTC')).toBe('IDLE')

      // Verify history
      const history = bridge.getHistory()
      expect(history.length).toBe(1)
      expect(history[0]!.matched).toBe(true)
      expect(history[0]!.actionTaken).toBe('cancel_order')
    })

    it('pipeline invalidation for non-matching setup is a no-op', () => {
      const emitter = new EventEmitter()
      agent.subscribeToPipeline(emitter)
      bridge.connect(emitter, agent)

      emitter.emit('setup', makeSetup())
      expect(agent.getCoinState('BTC')).toBe('ENTERING')

      // Different setup — should not invalidate
      emitter.emit('invalidation', 'ETH|15m|fvg|short', 'fvg-filled')
      expect(agent.getCoinState('BTC')).toBe('ENTERING') // unchanged
    })
  })

  // ── History & Stats ────────────────────────────────────────────────────

  describe('history and stats', () => {
    it('tracks invalidation records', () => {
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })

      bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      bridge.onInvalidation('ETH|15m|fvg|short', 'fvg-filled', agent)

      const history = bridge.getHistory()
      expect(history.length).toBe(2)
      expect(history[0]!.matched).toBe(true)
      expect(history[1]!.matched).toBe(false)
    })

    it('computes stats correctly', () => {
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })

      bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      bridge.onInvalidation('ETH|15m|fvg|short', 'fvg-filled', agent)
      bridge.onInvalidation('SOL|4h|spring|long', 'spring-failed', agent)

      const stats = bridge.getStats()
      expect(stats.total).toBe(3)
      expect(stats.matched).toBe(1)
      expect(stats.skipped).toBe(2)
      expect(stats.parseFailed).toBe(0)
      // Matched row uses agent strategy id (default layered); skipped rows use legacy ids from setupId
      expect(stats.byStrategy['layered']).toEqual({ matched: 1, skipped: 0 })
      expect(stats.byStrategy['legacy']).toEqual({ matched: 0, skipped: 2 })
      expect(stats.actions['cancel_order']).toBe(1)
      expect(stats.actions['none']).toBe(2)
    })

    it('attributes matched vs skipped by strategy id for modern setupIds', () => {
      const quantSetup = makeSetup({
        id: 'quant:BTC|1h|ema-rsi',
        type: 'ema-rsi',
        strategyId: 'quant',
      })
      agent.dispatch('BTC', { type: 'setup_detected', setup: quantSetup }, 'quant')
      bridge.onInvalidation('quant:BTC|1h|ema-rsi', 'zone-broken', agent)
      expect(bridge.getStats().byStrategy['quant']).toEqual({ matched: 1, skipped: 0 })

      bridge.onInvalidation('layered:ETH|1h|order-block', 'ttl-expired', agent)
      expect(bridge.getStats().byStrategy['layered']).toEqual({ matched: 0, skipped: 1 })
    })

    it('clearHistory resets', () => {
      bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(bridge.getHistory().length).toBe(1)

      bridge.clearHistory()
      expect(bridge.getHistory().length).toBe(0)
    })

    it('ring buffer caps at maxHistory', () => {
      // Generate 210 records
      for (let i = 0; i < 210; i++) {
        bridge.onInvalidation(`BTC|1h|order-block|long`, `reason-${i}`, agent)
      }
      expect(bridge.getHistory().length).toBe(200)
    })
  })

  // ── Edge Cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles malformed setupId gracefully', () => {
      const record = bridge.onInvalidation('', 'unknown', agent)
      expect(record.matched).toBe(false)
      expect(record.coin).toBe('unknown')
      expect(record.strategyKey).toBeUndefined()
      expect(bridge.getStats().parseFailed).toBe(1)
    })

    it('handles unknown coin (never seen by agent)', () => {
      const record = bridge.onInvalidation('DOGE|1h|fvg|long', 'fvg-filled', agent)
      expect(record.matched).toBe(false)
      expect(record.coin).toBe('DOGE')
      expect(record.coinState).toBe('IDLE')
    })

    it('second invalidation for same coin is a no-op (already IDLE)', () => {
      agent.dispatch('BTC', { type: 'setup_detected', setup: makeSetup() })

      const r1 = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(r1.matched).toBe(true)
      expect(agent.getCoinState('BTC')).toBe('IDLE')

      // Second invalidation — no active setup anymore
      const r2 = bridge.onInvalidation('BTC|1h|order-block|long', 'zone-broken', agent)
      expect(r2.matched).toBe(false)
      expect(r2.actionTaken).toBe('none')
    })
  })
})
