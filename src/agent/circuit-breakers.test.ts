import { describe, it, expect } from 'bun:test'
import {
  checkDailyLoss,
  checkConsecutiveLosses,
  checkRapidLoss,
  checkMaxDrawdown,
  runAllChecks,
  nextUtcMidnight,
  prunePnlHistory,
} from './circuit-breakers.js'
import { CIRCUIT_BREAKER } from '../config.js'
import type { PnlEntry } from './types.js'

const NOW = 1_700_000_000_000  // fixed timestamp for deterministic tests
const ACCOUNT = 10_000

// ─── checkDailyLoss ─────────────────────────────────────────────────────────

describe('checkDailyLoss', () => {
  it('does not trip when loss is below limit', () => {
    // -2% loss, limit is 3%
    const result = checkDailyLoss(-200, ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('trips at exactly the limit', () => {
    // -3% of 10000 = -300
    const result = checkDailyLoss(-300, ACCOUNT, NOW)
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Daily loss')
    expect(result.reason).toContain('3')
    expect(result.pauseUntil).toBe(nextUtcMidnight(NOW))
  })

  it('trips when loss exceeds limit', () => {
    const result = checkDailyLoss(-500, ACCOUNT, NOW)
    expect(result.tripped).toBe(true)
  })

  it('does not trip on positive PnL', () => {
    const result = checkDailyLoss(500, ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('returns OK for zero account value (safety)', () => {
    const result = checkDailyLoss(-100, 0, NOW)
    expect(result.tripped).toBe(false)
  })

  it('pauseUntil is next UTC midnight', () => {
    const result = checkDailyLoss(-300, ACCOUNT, NOW)
    expect(result.pauseUntil).toBe(nextUtcMidnight(NOW))
    // Midnight should be in the future
    expect(result.pauseUntil!).toBeGreaterThan(NOW)
  })
})

// ─── checkConsecutiveLosses ─────────────────────────────────────────────────

describe('checkConsecutiveLosses', () => {
  it('does not trip below threshold', () => {
    const result = checkConsecutiveLosses(2, NOW)
    expect(result.tripped).toBe(false)
  })

  it('trips at exactly the threshold', () => {
    const result = checkConsecutiveLosses(3, NOW)
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('3 consecutive losses')
    expect(result.pauseUntil).toBe(NOW + CIRCUIT_BREAKER.consecutiveLossPauseMs)
  })

  it('trips above threshold', () => {
    const result = checkConsecutiveLosses(5, NOW)
    expect(result.tripped).toBe(true)
  })

  it('does not trip at zero', () => {
    const result = checkConsecutiveLosses(0, NOW)
    expect(result.tripped).toBe(false)
  })
})

// ─── checkRapidLoss ─────────────────────────────────────────────────────────

describe('checkRapidLoss', () => {
  it('does not trip when no history', () => {
    const result = checkRapidLoss([], ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('does not trip when losses are below limit within window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 30 * 60_000, pnl: -50 },  // -0.5%
      { ts: NOW - 10 * 60_000, pnl: -50 },  // -0.5% total = -1%
    ]
    const result = checkRapidLoss(history, ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('trips when losses exceed limit within window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 30 * 60_000, pnl: -100 },
      { ts: NOW - 10 * 60_000, pnl: -150 },  // total = -250 = -2.5%
    ]
    const result = checkRapidLoss(history, ACCOUNT, NOW)
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Rapid loss')
    expect(result.pauseUntil).toBe(NOW + CIRCUIT_BREAKER.rapidLossPauseMs)
  })

  it('ignores entries outside the window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 2 * 60 * 60_000, pnl: -300 },  // 2 hours ago, outside 1h window
      { ts: NOW - 10 * 60_000, pnl: -50 },         // within window, only -0.5%
    ]
    const result = checkRapidLoss(history, ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('does not trip on net positive within window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 30 * 60_000, pnl: -200 },
      { ts: NOW - 10 * 60_000, pnl: 300 },  // net = +100
    ]
    const result = checkRapidLoss(history, ACCOUNT, NOW)
    expect(result.tripped).toBe(false)
  })

  it('returns OK for zero account value', () => {
    const history: PnlEntry[] = [{ ts: NOW, pnl: -500 }]
    const result = checkRapidLoss(history, 0, NOW)
    expect(result.tripped).toBe(false)
  })
})

// ─── checkMaxDrawdown ───────────────────────────────────────────────────────

describe('checkMaxDrawdown', () => {
  it('does not trip when drawdown is below limit', () => {
    // 5% drawdown: peak 10000, current 9500
    const result = checkMaxDrawdown(9500, 10000)
    expect(result.tripped).toBe(false)
  })

  it('trips at exactly the limit', () => {
    // 10% drawdown: peak 10000, current 9000
    const result = checkMaxDrawdown(9000, 10000)
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Max drawdown')
    expect(result.reason).toContain('10')
    // No auto-resume for max drawdown
    expect(result.pauseUntil).toBeNull()
  })

  it('trips above limit', () => {
    const result = checkMaxDrawdown(8000, 10000)
    expect(result.tripped).toBe(true)
  })

  it('does not trip when current equals peak', () => {
    const result = checkMaxDrawdown(10000, 10000)
    expect(result.tripped).toBe(false)
  })

  it('returns OK for zero/negative peak (safety)', () => {
    expect(checkMaxDrawdown(5000, 0).tripped).toBe(false)
    expect(checkMaxDrawdown(0, 10000).tripped).toBe(false)
  })
})

// ─── runAllChecks ───────────────────────────────────────────────────────────

describe('runAllChecks', () => {
  const baseParams = {
    dailyPnl: 0,
    accountValue: ACCOUNT,
    peakAccountValue: ACCOUNT,
    consecutiveLosses: 0,
    pnlHistory: [] as PnlEntry[],
    now: NOW,
  }

  it('returns OK when nothing is tripped', () => {
    const result = runAllChecks(baseParams)
    expect(result.tripped).toBe(false)
  })

  it('returns max drawdown first (most severe)', () => {
    const result = runAllChecks({
      ...baseParams,
      accountValue: 8000,       // 20% drawdown
      dailyPnl: -500,           // also daily loss trip
      consecutiveLosses: 5,     // also consecutive trip
    })
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Max drawdown')
    // Max drawdown has no auto-resume
    expect(result.pauseUntil).toBeNull()
  })

  it('returns daily loss when drawdown OK but daily tripped', () => {
    const result = runAllChecks({
      ...baseParams,
      dailyPnl: -400,          // 4% daily loss
      consecutiveLosses: 5,    // also consecutive trip
    })
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Daily loss')
  })

  it('returns rapid loss when daily OK but rapid tripped', () => {
    const result = runAllChecks({
      ...baseParams,
      dailyPnl: -100,  // 1% daily — below limit
      pnlHistory: [
        { ts: NOW - 20 * 60_000, pnl: -150 },
        { ts: NOW - 5 * 60_000, pnl: -100 },  // -250 in 1h = 2.5%
      ],
    })
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('Rapid loss')
  })

  it('returns consecutive when only that is tripped', () => {
    const result = runAllChecks({
      ...baseParams,
      consecutiveLosses: 3,
    })
    expect(result.tripped).toBe(true)
    expect(result.reason).toContain('consecutive losses')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────────────

describe('nextUtcMidnight', () => {
  it('returns a time in the future', () => {
    const midnight = nextUtcMidnight(NOW)
    expect(midnight).toBeGreaterThan(NOW)
  })

  it('returns exactly midnight UTC', () => {
    const midnight = nextUtcMidnight(NOW)
    const d = new Date(midnight)
    expect(d.getUTCHours()).toBe(0)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getUTCSeconds()).toBe(0)
    expect(d.getUTCMilliseconds()).toBe(0)
  })

  it('at 23:59 UTC, returns next day midnight', () => {
    const almostMidnight = new Date('2024-01-15T23:59:59.999Z').getTime()
    const midnight = nextUtcMidnight(almostMidnight)
    const d = new Date(midnight)
    expect(d.toISOString()).toBe('2024-01-16T00:00:00.000Z')
  })
})

describe('prunePnlHistory', () => {
  it('removes entries outside the window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 2 * 60 * 60_000, pnl: -100 },  // 2h ago — outside 1h window
      { ts: NOW - 30 * 60_000, pnl: -50 },         // 30min ago — inside
      { ts: NOW - 5 * 60_000, pnl: -25 },           // 5min ago — inside
    ]
    const pruned = prunePnlHistory(history, NOW)
    expect(pruned).toHaveLength(2)
    expect(pruned[0].pnl).toBe(-50)
    expect(pruned[1].pnl).toBe(-25)
  })

  it('returns empty for all-stale entries', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 3 * 60 * 60_000, pnl: -100 },
    ]
    expect(prunePnlHistory(history, NOW)).toHaveLength(0)
  })

  it('keeps all entries within window', () => {
    const history: PnlEntry[] = [
      { ts: NOW - 10 * 60_000, pnl: -50 },
      { ts: NOW - 5 * 60_000, pnl: -25 },
    ]
    expect(prunePnlHistory(history, NOW)).toHaveLength(2)
  })
})
