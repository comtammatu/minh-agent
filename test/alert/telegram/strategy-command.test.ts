/**
 * Telegram /strategy command tests — Sprint 4.5 S9.
 *
 * Tests:
 *   1. /strategy (no args) — lists all strategies with status
 *   2. /strategy pause <id> — disables strategy
 *   3. /strategy pause <id> — blocks if open positions (E30)
 *   4. /strategy resume <id> — enables strategy
 *   5. /strategy pause/resume unknown id — error
 *   6. /strategy pause already disabled — idempotent message
 *   7. /strategy resume already enabled — idempotent message
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { PatternType } from '../../../src/types.js'
import type { IStrategy } from '../../../src/strategy/registry.js'

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock position monitor
const mockPositions = new Map<string, { strategyId: string }>()

mock.module('../../../src/agent/position-monitor.js', () => ({
  getPositionMonitor: () => ({
    getPositions: () => mockPositions,
  }),
}))

// Mock agent (needed by other commands during registerBuiltinCommands)
mock.module('../../../src/agent/trading-agent.js', () => ({
  getAgent: () => ({
    getSnapshot: () => ({
      global: { dailyPnl: 0, totalConsecutiveLosses: 0, globalPaused: false, uptime: 0 },
      coins: {},
    }),
    pauseAll: () => {},
    resumeAll: () => {},
    dispatch: () => {},
    getCoinState: () => 'IDLE',
    getCoinContext: () => null,
  }),
}))

mock.module('../../../src/agent/self-healing.js', () => ({
  getHealthMonitor: () => ({
    getReport: () => ({ overall: 'HEALTHY', components: {} }),
  }),
}))

mock.module('../../../src/analytics/metrics-service.js', () => ({
  getLiveMetrics: () => Promise.resolve({
    pnl: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
    winRate: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
    trades: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
    currentDrawdown: 0,
    maxDrawdown: 0,
    openPositionCount: 0,
    patternMetrics: [],
    coinMetrics: [],
  }),
}))

mock.module('../../../src/agent/close-all.js', () => ({
  closeAllPositions: () => Promise.resolve({ cancelled: 0, closed: 0 }),
}))

mock.module('../../../src/config.js', () => ({
  TELEGRAM_BOT: { closeallConfirmTimeoutSec: 30 },
}))

// Strategy registry — use real one
import {
  StrategyRegistry,
  resetStrategyRegistry,
  getStrategyRegistry,
} from '../../../src/strategy/registry.js'

import {
  registerBuiltinCommands,
  resetCommands,
  findCommand,
} from '../../../src/alert/telegram/commands.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockStrategy(id: string, name: string): IStrategy {
  return {
    id,
    name,
    patternTypes: ['ema-rsi' as PatternType],
    scan: () => null,
    minCandles: () => 10,
    clearState: () => {},
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('/strategy command', () => {
  beforeEach(() => {
    resetCommands()
    resetStrategyRegistry()
    mockPositions.clear()

    // Register 2 strategies
    const registry = getStrategyRegistry()
    registry.register(mockStrategy('layered', 'Layered PA/SMC'))
    registry.register(mockStrategy('quant', 'Quant EMA/RSI'))

    registerBuiltinCommands()
  })

  test('lists all strategies with status', () => {
    const handler = findCommand('strategy')!
    const result = handler.handler('', 123) as string

    expect(result).toContain('Strategies')
    expect(result).toContain('Layered PA/SMC')
    expect(result).toContain('Quant EMA/RSI')
    expect(result).toContain('layered')
    expect(result).toContain('quant')
  })

  test('pause disables a strategy', () => {
    const handler = findCommand('strategy')!
    const result = handler.handler('pause quant', 123) as string

    expect(result).toContain('disabled')
    expect(getStrategyRegistry().isEnabled('quant')).toBe(false)
  })

  test('pause blocks if open positions (E30)', () => {
    // Add fake open position for quant
    mockPositions.set('BTC:quant', { strategyId: 'quant' })

    const handler = findCommand('strategy')!
    const result = handler.handler('pause quant', 123) as string

    expect(result).toContain('Cannot disable')
    expect(result).toContain('1')
    expect(result).toContain('open position')
    // Strategy should still be enabled
    expect(getStrategyRegistry().isEnabled('quant')).toBe(true)
  })

  test('resume enables a disabled strategy', () => {
    const registry = getStrategyRegistry()
    registry.disable('quant')

    const handler = findCommand('strategy')!
    const result = handler.handler('resume quant', 123) as string

    expect(result).toContain('enabled')
    expect(registry.isEnabled('quant')).toBe(true)
  })

  test('pause unknown strategy returns error', () => {
    const handler = findCommand('strategy')!
    const result = handler.handler('pause unknown', 123) as string

    expect(result).toContain('Unknown strategy')
  })

  test('resume unknown strategy returns error', () => {
    const handler = findCommand('strategy')!
    const result = handler.handler('resume unknown', 123) as string

    expect(result).toContain('Unknown strategy')
  })

  test('pause already disabled strategy returns message', () => {
    const registry = getStrategyRegistry()
    registry.disable('quant')

    const handler = findCommand('strategy')!
    const result = handler.handler('pause quant', 123) as string

    expect(result).toContain('already disabled')
  })

  test('resume already enabled strategy returns message', () => {
    const handler = findCommand('strategy')!
    const result = handler.handler('resume layered', 123) as string

    expect(result).toContain('already enabled')
  })
})
