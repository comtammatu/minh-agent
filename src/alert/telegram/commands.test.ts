import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── Mock singletons ─────────────────────────────────────────────────────────

const mockSnapshot = {
  coins: {
    BTC: { state: 'WATCHING', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 5000 },
    ETH: { state: 'IN_POSITION', activeSetup: null, pendingOrderId: null, positionId: 'pos-1', consecutiveLosses: 2, stateAge: 10000 },
    SOL: { state: 'IDLE', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 1000 },
  },
  global: {
    dailyPnl: -42.5,
    totalConsecutiveLosses: 1,
    globalPaused: false,
    globalPauseReason: null,
    uptime: 3_660_000, // 61 minutes
  },
}

let pausedWith: string | null = null
let resumed = false
const dispatchedEvents: Array<{ coin: string; event: { type: string; reason?: string } }> = []

mock.module('../../agent/trading-agent.js', () => ({
  getAgent: () => ({
    getSnapshot: () => mockSnapshot,
    pauseAll: (reason: string) => { pausedWith = reason },
    resumeAll: () => { resumed = true },
    getCoinState: (coin: string) => mockSnapshot.coins[coin as keyof typeof mockSnapshot.coins]?.state ?? 'IDLE',
    getCoinContext: (coin: string) => mockSnapshot.coins[coin as keyof typeof mockSnapshot.coins] ?? null,
    dispatch: (coin: string, event: { type: string; reason?: string }) => { dispatchedEvents.push({ coin, event }) },
  }),
}))

let closeAllResult = { cancelled: 0, closed: 0 }
mock.module('../../agent/close-all.js', () => ({
  closeAllPositions: async (_reason: string) => closeAllResult,
}))

const mockPositions = new Map([
  ['pos-1', {
    positionId: 'pos-1',
    coin: 'ETH',
    side: 'long' as const,
    entryPrice: 3200.5,
    currentSize: 0.5,
    originalSize: 0.5,
    slPrice: 3100,
    tpPrice: 3500,
    entryOrderId: 'ord-1',
    trailingState: null,
    partialClosesFired: [],
    lastSyncAt: Date.now(),
    openedAt: Date.now(),
  }],
])

mock.module('../../agent/position-monitor.js', () => ({
  getPositionMonitor: () => ({
    getPositions: () => new Map(mockPositions),
  }),
}))

mock.module('../../agent/self-healing.js', () => ({
  getHealthMonitor: () => ({
    getReport: () => ({
      overall: 'ok',
      uptime: 3660,
      rssBytes: 50_000_000,
      components: {
        feed: { status: 'ok', lastSuccessAt: Date.now(), lastErrorAt: 0, consecutiveErrors: 0, lastError: null },
        db: { status: 'ok', lastSuccessAt: Date.now(), lastErrorAt: 0, consecutiveErrors: 0, lastError: null },
        exchange: { status: 'ok', lastSuccessAt: Date.now(), lastErrorAt: 0, consecutiveErrors: 0, lastError: null },
      },
    }),
  }),
}))

mock.module('../../analytics/metrics-service.js', () => ({
  getLiveMetrics: async () => ({
    winRate: { daily: 0.6, weekly: 0.55, monthly: 0.52, allTime: 0.5 },
    pnl: { daily: 120.5, weekly: 450.3, monthly: 1200.0, allTime: 5000.0 },
    trades: { daily: 5, weekly: 20, monthly: 80, allTime: 300 },
    patternMetrics: [],
    coinMetrics: [],
    currentDrawdown: -2.5,
    maxDrawdown: -8.3,
    openPositionCount: 1,
  }),
}))

import {
  registerCommand,
  getCommands,
  findCommand,
  resetCommands,
  registerBuiltinCommands,
  parsePauseCoinArgs,
  resetCloseAllState,
} from './commands.js'

describe('command registry', () => {
  beforeEach(() => {
    resetCommands()
  })

  it('starts empty', () => {
    expect(getCommands()).toHaveLength(0)
  })

  it('registers a command', () => {
    registerCommand({ name: 'test', description: 'A test command', handler: () => 'ok' })
    expect(getCommands()).toHaveLength(1)
    expect(getCommands()[0].name).toBe('test')
  })

  it('finds a registered command', () => {
    registerCommand({ name: 'foo', description: 'Foo', handler: () => 'bar' })
    const cmd = findCommand('foo')
    expect(cmd).not.toBeNull()
    expect(cmd!.name).toBe('foo')
  })

  it('returns null for unknown command', () => {
    expect(findCommand('nonexistent')).toBeNull()
  })

  it('resetCommands clears all', () => {
    registerCommand({ name: 'a', description: 'A', handler: () => '' })
    registerCommand({ name: 'b', description: 'B', handler: () => '' })
    expect(getCommands()).toHaveLength(2)
    resetCommands()
    expect(getCommands()).toHaveLength(0)
  })
})

describe('registerBuiltinCommands', () => {
  beforeEach(() => {
    resetCommands()
  })

  it('registers /help command', () => {
    registerBuiltinCommands()
    const cmd = findCommand('help')
    expect(cmd).not.toBeNull()
    expect(cmd!.description).toBe('Show this help message')
  })

  it('/help handler lists all commands', () => {
    registerBuiltinCommands()

    const helpCmd = findCommand('help')!
    const reply = helpCmd.handler('', 0) as string
    expect(reply).toContain('Minh')
    expect(reply).toContain('/help')
    expect(reply).toContain('/status')
    expect(reply).toContain('/positions')
    expect(reply).toContain('/pnl')
    expect(reply).toContain('/pause')
    expect(reply).toContain('/resume')
    expect(reply).toContain('/risk')
    expect(reply).toContain('/closeall')
    expect(reply).toContain('/confirm')
    expect(reply).toContain('/report')
  })

  it('registers 10 built-in commands', () => {
    registerBuiltinCommands()
    expect(getCommands()).toHaveLength(10)
  })
})

// ─── /status ──────────────────────────────────────────────────────────────────

describe('/status command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
  })

  it('returns agent state, health, uptime, positions, coins', () => {
    const cmd = findCommand('status')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('Status')
    expect(reply).toContain('RUNNING')
    expect(reply).toContain('ok')
    expect(reply).toContain('1h 1m')
    expect(reply).toContain('42\\.50') // dailyPnl abs value (escaped)
    expect(reply).toContain('Positions: 1')
    expect(reply).toContain('Coins: 3')
  })

  it('shows PAUSED when agent is paused', () => {
    mockSnapshot.global.globalPaused = true
    mockSnapshot.global.globalPauseReason = 'daily loss limit'

    const cmd = findCommand('status')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('PAUSED')
    expect(reply).toContain('daily loss limit')

    // Reset
    mockSnapshot.global.globalPaused = false
    mockSnapshot.global.globalPauseReason = null
  })
})

// ─── /positions ───────────────────────────────────────────────────────────────

describe('/positions command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
  })

  it('lists open positions with details', () => {
    const cmd = findCommand('positions')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('Open Positions')
    expect(reply).toContain('ETH')
    expect(reply).toContain('LONG')
    expect(reply).toContain('3200\\.50')  // entry price (escaped)
    expect(reply).toContain('0\\.5000')   // size (escaped)
    expect(reply).toContain('3100\\.00')  // SL (escaped)
    expect(reply).toContain('3500\\.00')  // TP (escaped)
  })

  it('shows message when no positions', () => {
    mockPositions.clear()
    const cmd = findCommand('positions')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('No open positions')

    // Restore
    mockPositions.set('pos-1', {
      positionId: 'pos-1',
      coin: 'ETH',
      side: 'long' as const,
      entryPrice: 3200.5,
      currentSize: 0.5,
      originalSize: 0.5,
      slPrice: 3100,
      tpPrice: 3500,
      entryOrderId: 'ord-1',
      trailingState: null,
      partialClosesFired: [],
      lastSyncAt: Date.now(),
      openedAt: Date.now(),
    })
  })
})

// ─── /pnl ─────────────────────────────────────────────────────────────────────

describe('/pnl command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
  })

  it('returns daily/weekly/monthly/all-time PnL and win rates', async () => {
    const cmd = findCommand('pnl')!
    const reply = await cmd.handler('', 0)
    expect(reply).toContain('PnL Summary')
    expect(reply).toContain('120\\.50')   // daily pnl (escaped)
    expect(reply).toContain('60\\.0')     // daily WR 60% (escaped)
    expect(reply).toContain('450\\.30')   // weekly pnl (escaped)
    expect(reply).toContain('5000\\.00')  // all-time pnl (escaped)
    expect(reply).toContain('5 trades')  // daily trades
    expect(reply).toContain('300 trades') // all-time trades
    expect(reply).toContain('2\\.50')     // current drawdown (escaped)
    expect(reply).toContain('8\\.30')     // max drawdown (escaped)
  })
})

// ─── /pause ───────────────────────────────────────────────────────────────────

describe('/pause command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
    pausedWith = null
    dispatchedEvents.length = 0
  })

  it('pauses agent with default reason', () => {
    const cmd = findCommand('pause')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('Agent paused')
    expect(reply).toContain('manual via Telegram')
    expect(pausedWith).toBe('manual via Telegram')
  })

  it('pauses agent with custom reason', () => {
    const cmd = findCommand('pause')!
    const reply = cmd.handler('news event', 0) as string
    expect(reply).toContain('Agent paused')
    expect(reply).toContain('news event')
    expect(pausedWith).toBe('news event')
  })

  it('pauses single coin with duration', () => {
    const cmd = findCommand('pause')!
    const reply = cmd.handler('BTC 4h', 0) as string
    expect(reply).toContain('BTC')
    expect(reply).toContain('4h')
    expect(dispatchedEvents).toHaveLength(1)
    expect(dispatchedEvents[0].coin).toBe('BTC')
    expect(dispatchedEvents[0].event.type).toBe('pause')
  })

  it('falls back to global pause for invalid per-coin args', () => {
    const cmd = findCommand('pause')!
    const reply = cmd.handler('some reason without coin', 0) as string
    expect(reply).toContain('Agent paused')
    expect(pausedWith).toBe('some reason without coin')
  })
})

// ─── /resume ──────────────────────────────────────────────────────────────────

describe('/resume command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
    resumed = false
  })

  it('resumes agent', () => {
    const cmd = findCommand('resume')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('Agent resumed')
    expect(resumed).toBe(true)
  })
})

// ─── parsePauseCoinArgs ──────────────────────────────────────────────────────

describe('parsePauseCoinArgs', () => {
  it('parses "BTC 4h"', () => {
    const result = parsePauseCoinArgs('BTC 4h')
    expect(result).not.toBeNull()
    expect(result!.coin).toBe('BTC')
    expect(result!.durationMs).toBe(4 * 3_600_000)
    expect(result!.label).toBe('4h')
  })

  it('parses "eth 30m" (case-insensitive coin)', () => {
    const result = parsePauseCoinArgs('eth 30m')
    expect(result).not.toBeNull()
    expect(result!.coin).toBe('ETH')
    expect(result!.durationMs).toBe(30 * 60_000)
  })

  it('parses "SOL 1d"', () => {
    const result = parsePauseCoinArgs('SOL 1d')
    expect(result).not.toBeNull()
    expect(result!.durationMs).toBe(86_400_000)
  })

  it('returns null for empty args', () => {
    expect(parsePauseCoinArgs('')).toBeNull()
  })

  it('returns null for single word', () => {
    expect(parsePauseCoinArgs('BTC')).toBeNull()
  })

  it('returns null for invalid duration format', () => {
    expect(parsePauseCoinArgs('BTC forever')).toBeNull()
    expect(parsePauseCoinArgs('BTC 4x')).toBeNull()
  })

  it('returns null for zero duration', () => {
    expect(parsePauseCoinArgs('BTC 0h')).toBeNull()
  })
})

// ─── /risk ───────────────────────────────────────────────────────────────────

describe('/risk command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
  })

  it('returns risk dashboard with PnL, positions, CB status', () => {
    const cmd = findCommand('risk')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('Risk Dashboard')
    expect(reply).toContain('42\\.50')  // daily PnL (escaped)
    expect(reply).toContain('Circuit breaker')
    expect(reply).toContain('OK')  // 1 consecutive loss < 3
    expect(reply).toContain('Global paused: NO')
  })

  it('shows per-coin consecutive losses when > 0', () => {
    const cmd = findCommand('risk')!
    const reply = cmd.handler('', 0) as string
    expect(reply).toContain('ETH')
    expect(reply).toContain('2 consecutive')
  })
})

// ─── /closeall + /confirm ────────────────────────────────────────────────────

describe('/closeall + /confirm commands', () => {
  const CHAT_ID = 12345

  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
    resetCloseAllState()
    closeAllResult = { cancelled: 2, closed: 1 }
  })

  it('/closeall requests confirmation', () => {
    const cmd = findCommand('closeall')!
    const reply = cmd.handler('', CHAT_ID) as string
    expect(reply).toContain('CLOSE ALL')
    expect(reply).toContain('Confirmation required')
    expect(reply).toContain('/confirm')
    expect(reply).toContain('30s')
  })

  it('/confirm with no pending returns no-op', async () => {
    const cmd = findCommand('confirm')!
    const reply = await cmd.handler('', CHAT_ID)
    expect(reply).toContain('No pending')
  })

  it('/closeall → /confirm executes close-all', async () => {
    const closeallCmd = findCommand('closeall')!
    closeallCmd.handler('', CHAT_ID)

    const confirmCmd = findCommand('confirm')!
    const reply = await confirmCmd.handler('', CHAT_ID)
    expect(reply).toContain('Close\\-all executed')
    expect(reply).toContain('Cancelled orders: 2')
    expect(reply).toContain('Closed positions: 1')
  })

  it('/confirm from different chatId is rejected', async () => {
    const closeallCmd = findCommand('closeall')!
    closeallCmd.handler('', CHAT_ID)

    const confirmCmd = findCommand('confirm')!
    const reply = await confirmCmd.handler('', 99999)
    expect(reply).toContain('No pending')
  })

  it('/closeall while already pending shows already-pending message', () => {
    const cmd = findCommand('closeall')!
    cmd.handler('', CHAT_ID)
    const reply = cmd.handler('', CHAT_ID) as string
    expect(reply).toContain('already pending')
  })
})

// ─── /report ─────────────────────────────────────────────────────────────────

describe('/report command', () => {
  beforeEach(() => {
    resetCommands()
    registerBuiltinCommands()
  })

  it('returns daily report with PnL, win rate, drawdown', async () => {
    const cmd = findCommand('report')!
    const reply = await cmd.handler('', 0)
    expect(reply).toContain('Daily Report')
    expect(reply).toContain('120\\.50')    // daily pnl
    expect(reply).toContain('450\\.30')    // weekly pnl
    expect(reply).toContain('1200\\.00')   // monthly pnl
    expect(reply).toContain('5000\\.00')   // all-time pnl
    expect(reply).toContain('60\\.0%')     // daily WR
    expect(reply).toContain('5 trades')   // daily trades
    expect(reply).toContain('2\\.50')      // current drawdown
    expect(reply).toContain('8\\.30')      // max drawdown
    expect(reply).toContain('Open positions:* 1')
  })

  it('shows no pattern/coin sections when arrays are empty', async () => {
    const cmd = findCommand('report')!
    const reply = await cmd.handler('', 0)
    // Default mock has empty arrays
    expect(reply).not.toContain('Top Patterns')
    expect(reply).not.toContain('Top Coins')
  })
})
