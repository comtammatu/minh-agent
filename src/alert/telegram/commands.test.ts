import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── Mock singletons ─────────────────────────────────────────────────────────

const mockSnapshot = {
  coins: {
    BTC: { state: 'WATCHING', activeSetup: null, pendingOrderId: null, positionId: null, consecutiveLosses: 0, stateAge: 5000 },
    ETH: { state: 'IN_POSITION', activeSetup: null, pendingOrderId: null, positionId: 'pos-1', consecutiveLosses: 0, stateAge: 10000 },
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

mock.module('../../agent/trading-agent.js', () => ({
  getAgent: () => ({
    getSnapshot: () => mockSnapshot,
    pauseAll: (reason: string) => { pausedWith = reason },
    resumeAll: () => { resumed = true },
  }),
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
  })

  it('registers 6 built-in commands', () => {
    registerBuiltinCommands()
    expect(getCommands()).toHaveLength(6)
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
