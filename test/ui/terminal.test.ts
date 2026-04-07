import { describe, test, expect } from 'bun:test'
import {
  ANSI,
  formatSide,
  formatGrade,
  formatState,
  formatPnl,
  formatAction,
  formatSetupAlert,
  formatAgentStatus,
} from '../../src/ui/terminal.js'
import type { AgentAction, AgentSnapshot } from '../../src/agent/types.js'

// ─── Helper: strip ANSI codes for content assertions ─────────────────────

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// ─── formatSide ─────────────────────────────────────────────────────────

describe('formatSide', () => {
  test('long → green LONG', () => {
    const result = formatSide('long')
    expect(result).toContain(ANSI.green)
    expect(strip(result)).toBe('LONG')
  })

  test('short → red SHORT', () => {
    const result = formatSide('short')
    expect(result).toContain(ANSI.red)
    expect(strip(result)).toBe('SHORT')
  })
})

// ─── formatGrade ────────────────────────────────────────────────────────

describe('formatGrade', () => {
  test('A+ → magenta bg badge', () => {
    const result = formatGrade('A+')
    expect(result).toContain(ANSI.bgMagenta)
    expect(strip(result)).toBe(' A+ ')
  })

  test('A → green bg badge', () => {
    const result = formatGrade('A')
    expect(result).toContain(ANSI.bgGreen)
    expect(strip(result)).toBe(' A ')
  })

  test('B → blue bg badge', () => {
    const result = formatGrade('B')
    expect(result).toContain(ANSI.bgBlue)
    expect(strip(result)).toBe(' B ')
  })

  test('C → dim', () => {
    const result = formatGrade('C')
    expect(result).toContain(ANSI.dim)
    expect(strip(result)).toBe('[C]')
  })
})

// ─── formatState ────────────────────────────────────────────────────────

describe('formatState', () => {
  test('IDLE → dim', () => {
    const result = formatState('IDLE')
    expect(result).toContain(ANSI.dim)
    expect(strip(result)).toBe('[IDLE]')
  })

  test('WATCHING → cyan', () => {
    const result = formatState('WATCHING')
    expect(result).toContain(ANSI.cyan)
    expect(strip(result)).toBe('[WATCHING]')
  })

  test('IN_POSITION → bold green', () => {
    const result = formatState('IN_POSITION')
    expect(result).toContain(ANSI.green)
    expect(strip(result)).toBe('[IN_POSITION]')
  })

  test('PAUSED → bold red', () => {
    const result = formatState('PAUSED')
    expect(result).toContain(ANSI.red)
    expect(strip(result)).toBe('[PAUSED]')
  })

  test('ENTERING → yellow', () => {
    expect(strip(formatState('ENTERING'))).toBe('[ENTERING]')
  })

  test('EXITING → yellow', () => {
    expect(strip(formatState('EXITING'))).toBe('[EXITING]')
  })
})

// ─── formatPnl ──────────────────────────────────────────────────────────

describe('formatPnl', () => {
  test('positive → green with +', () => {
    const result = formatPnl(42.50)
    expect(result).toContain(ANSI.green)
    expect(strip(result)).toBe('+42.50')
  })

  test('negative → red', () => {
    const result = formatPnl(-15.30)
    expect(result).toContain(ANSI.red)
    expect(strip(result)).toBe('-15.30')
  })

  test('zero → green with +', () => {
    const result = formatPnl(0)
    expect(result).toContain(ANSI.green)
    expect(strip(result)).toBe('+0.00')
  })
})

// ─── formatAction ───────────────────────────────────────────────────────

describe('formatAction', () => {
  test('non-journal action → null', () => {
    const action: AgentAction = { type: 'none' }
    expect(formatAction(action)).toBeNull()
  })

  test('signal → SETUP with grade + confidence + levels', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'BTC',
      details: {
        grade: 'A',
        confidence: 0.85,
        side: 'long',
        setupId: 'abc',
        interval: '5m',
        entryPrice: 100,
        slPrice: 95,
        tpPrice: 110,
      },
    }
    const result = formatAction(action)!
    expect(result).not.toBeNull()
    const stripped = strip(result)
    expect(stripped).toContain('SETUP')
    expect(stripped).toContain('BTC')
    expect(stripped).toContain('5m')
    expect(stripped).toContain('LONG')
    expect(stripped).toContain('85%')
    expect(stripped).toContain('entry')
    expect(stripped).toContain('100.00')
    expect(stripped).toContain('95.00')
    expect(stripped).toContain('110.00')
  })

  test('enter → FILLED', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'enter',
      coin: 'ETH',
      details: { side: 'short', fillPrice: 3500.1234 },
    }
    const result = formatAction(action)!
    const stripped = strip(result)
    expect(stripped).toContain('FILLED')
    expect(stripped).toContain('ETH')
    expect(stripped).toContain('SHORT')
    expect(stripped).toContain('3500.1234')
  })

  test('exit → CLOSED with PnL', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'exit',
      coin: 'SOL',
      details: { pnl: -22.5, reason: 'sl_hit' },
    }
    const result = formatAction(action)!
    const stripped = strip(result)
    expect(stripped).toContain('CLOSED')
    expect(stripped).toContain('SOL')
    expect(stripped).toContain('-22.50')
    expect(stripped).toContain('sl_hit')
  })

  test('skip → dim SKIP', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'skip',
      coin: 'BTC',
      details: { reason: 'Grade C below B' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('SKIP')
    expect(strip(result)).toContain('Grade C below B')
  })

  test('invalidate with position → INVALID+CLOSE', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'invalidate',
      coin: 'BTC',
      details: { reason: 'close_beyond', positionId: 'pos-1' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('INVALID+CLOSE')
  })

  test('invalidate without position → INVALID only', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'invalidate',
      coin: 'BTC',
      details: { reason: 'ttl_expired' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('INVALID')
    expect(strip(result)).not.toContain('CLOSE')
  })

  test('circuit_break → highlighted', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'circuit_break',
      coin: '*',
      details: { reason: 'daily_loss_3pct' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('CIRCUIT BREAKER')
    expect(strip(result)).toContain('daily_loss_3pct')
  })

  test('pause → red', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'pause',
      coin: 'BTC',
      details: { reason: 'manual' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('PAUSED')
  })

  test('resume → green', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'resume',
      coin: 'ETH',
      details: {},
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('RESUMED')
  })

  test('error → red', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'error',
      coin: 'SOL',
      details: { reason: 'exchange timeout' },
    }
    const result = formatAction(action)!
    expect(strip(result)).toContain('ERROR')
    expect(strip(result)).toContain('exchange timeout')
  })

  test('unknown event type → null', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'unknown_type' as string,
      coin: 'BTC',
      details: {},
    }
    expect(formatAction(action)).toBeNull()
  })
})

// ─── formatSetupAlert ───────────────────────────────────────────────────

describe('formatSetupAlert', () => {
  test('signal action → formatted alert', () => {
    const action = {
      type: 'log_journal' as const,
      eventType: 'signal',
      coin: 'BTC',
      details: {
        grade: 'A+',
        confidence: 0.92,
        side: 'long',
        setupId: 'test-123',
        interval: '1h',
        entryPrice: 50_000.12,
        slPrice: 49_000,
        tpPrice: 52_000,
      },
    }
    const result = formatSetupAlert(action)!
    expect(result).not.toBeNull()
    const stripped = strip(result)
    expect(stripped).toContain('SETUP')
    expect(stripped).toContain('BTC')
    expect(stripped).toContain('1h')
    expect(stripped).toContain('LONG')
    expect(stripped).toContain('92%')
    expect(stripped).toContain('50000.12')
    expect(stripped).toContain('49000.00')
    expect(stripped).toContain('52000.00')
  })

  test('non-signal event → null', () => {
    const action = {
      type: 'log_journal' as const,
      eventType: 'enter',
      coin: 'BTC',
      details: {},
    }
    expect(formatSetupAlert(action)).toBeNull()
  })
})

// ─── formatAgentStatus ──────────────────────────────────────────────────

describe('formatAgentStatus', () => {
  test('all idle → compact status line', () => {
    const snapshot: AgentSnapshot = {
      coins: {
        BTC: { state: 'IDLE', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 5000 },
        ETH: { state: 'IDLE', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 5000 },
      },
      global: {
        dailyPnl: 0,
        totalConsecutiveLosses: 0,
        globalPaused: false,
        globalPauseReason: null,
        uptime: 3600,
      },
    }
    const result = formatAgentStatus(snapshot)
    const stripped = strip(result)
    expect(stripped).toContain('AGENT')
    expect(stripped).toContain('2idle')
    expect(stripped).toContain('+0.00')
  })

  test('active coins shown with state badges', () => {
    const snapshot: AgentSnapshot = {
      coins: {
        BTC: { state: 'IN_POSITION', activeSetup: null, pendingOrderId: null, positionId: 'pos-1', consecutiveLosses: 0, stateAge: 120000 },
        ETH: { state: 'IDLE', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 5000 },
        SOL: { state: 'WATCHING', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 3000 },
      },
      global: {
        dailyPnl: 42.50,
        totalConsecutiveLosses: 0,
        globalPaused: false,
        globalPauseReason: null,
        uptime: 7200,
      },
    }
    const result = formatAgentStatus(snapshot)
    const stripped = strip(result)
    expect(stripped).toContain('1idle')
    expect(stripped).toContain('BTC[IN_POSITION]')
    expect(stripped).toContain('SOL[WATCHING]')
    expect(stripped).toContain('+42.50')
  })

  test('paused → PAUSED tag', () => {
    const snapshot: AgentSnapshot = {
      coins: {},
      global: {
        dailyPnl: -100,
        totalConsecutiveLosses: 3,
        globalPaused: true,
        globalPauseReason: 'daily_loss',
        uptime: 1000,
      },
    }
    const result = formatAgentStatus(snapshot)
    const stripped = strip(result)
    expect(stripped).toContain('PAUSED')
    expect(stripped).toContain('-100.00')
  })
})
