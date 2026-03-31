/**
 * TradeJournal tests (Sprint 2 S9).
 *
 * Tests journal write (fire-and-forget), read (getEntries), and dailySummary.
 * Mocks DB via bun:test mock.module — pure logic verification.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ── DB Mock ─────────────────────────────────────────────────────────────────

/**
 * Collects all top-level SQL calls (strings + interpolated values).
 * The postgres library uses tagged templates: sql`SELECT ... ${val}`.
 * Inner sql`fragment` calls also trigger the proxy, so we track all of them.
 */
let allSqlCalls: Array<{ strings: string[]; values: unknown[] }> = []
let sqlMockResult: unknown[] = []
let sqlShouldThrow = false

/** Get all interpolated values across all sql calls in a test. */
function allInterpolatedValues(): unknown[] {
  return allSqlCalls.flatMap(c => c.values)
}

/** Check if any sql call's query text contains a substring. */
function anyQueryContains(text: string): boolean {
  return allSqlCalls.some(c => c.strings.join(' ').includes(text))
}

function taggedSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  if (sqlShouldThrow) {
    return Promise.reject(new Error('DB connection failed'))
  }
  allSqlCalls.push({ strings: [...strings], values })
  return Promise.resolve(sqlMockResult)
}

const sqlProxy = Object.assign(taggedSql, {
  end: () => Promise.resolve(),
  json: (obj: unknown) => obj, // postgres sql.json() passthrough for JSONB
})

mock.module('../db/connection.js', () => ({
  sql: sqlProxy,
}))

mock.module('../lib/logger.js', () => ({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))

import {
  logJournalEntry,
  handleJournalAction,
  getJournalEntries,
  getDailySummary,
} from './journal.js'
import type { AgentAction } from './types.js'

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  allSqlCalls = []
  sqlMockResult = []
  sqlShouldThrow = false
})

// ── logJournalEntry ─────────────────────────────────────────────────────────

describe('logJournalEntry', () => {
  it('inserts a row into trade_journal', async () => {
    await logJournalEntry('signal', 'BTC', { grade: 'A', confidence: 0.85 }, 'IDLE')

    expect(anyQueryContains('INSERT INTO trade_journal')).toBe(true)
    const values = allInterpolatedValues()
    expect(values).toContain('signal')
    expect(values).toContain('BTC')
    // sql.json() passes the object directly (no double-encoding)
    expect(values).toContainEqual({ grade: 'A', confidence: 0.85 })
    expect(values).toContain('IDLE')
  })

  it('handles null coin', async () => {
    await logJournalEntry('error', null, { reason: 'startup_failure' })

    const values = allInterpolatedValues()
    expect(values).toContain('error')
    expect(values).toContain(null)  // coin is null
  })

  it('defaults agentState to null when not provided', async () => {
    await logJournalEntry('skip', 'ETH', { reason: 'low grade' })

    const values = allInterpolatedValues()
    expect(values).toContain('skip')
    // agentState param defaults to null
    expect(values.filter(v => v === null).length).toBeGreaterThanOrEqual(1)
  })

  it('does not throw on DB error (fire-and-forget)', async () => {
    sqlShouldThrow = true
    // Should NOT throw — errors are caught internally
    await logJournalEntry('exit', 'ETH', { pnl: 42.5 }, 'EXITING')
    // No exception = pass
  })
})

// ── handleJournalAction ─────────────────────────────────────────────────────

describe('handleJournalAction', () => {
  it('writes log_journal action to DB', async () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'enter',
      coin: 'SOL',
      details: { orderId: 'abc', fillPrice: 150 },
    }

    handleJournalAction(action, 'ENTERING')
    await new Promise(r => setTimeout(r, 10))

    expect(anyQueryContains('INSERT INTO trade_journal')).toBe(true)
    const values = allInterpolatedValues()
    expect(values).toContain('enter')
    expect(values).toContain('SOL')
    expect(values).toContain('ENTERING')
  })

  it('ignores non-journal actions', async () => {
    const action: AgentAction = { type: 'none' }
    handleJournalAction(action, 'IDLE')
    await new Promise(r => setTimeout(r, 10))

    expect(allSqlCalls).toHaveLength(0)
  })

  it('defaults agentState to null', async () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'skip',
      coin: 'DOGE',
      details: { reason: 'low grade' },
    }

    handleJournalAction(action)
    await new Promise(r => setTimeout(r, 10))

    const values = allInterpolatedValues()
    expect(values).toContain(null)  // agentState default
  })
})

// ── getJournalEntries ───────────────────────────────────────────────────────

describe('getJournalEntries', () => {
  it('returns mapped entries from DB rows', async () => {
    sqlMockResult = [
      {
        id: 1,
        ts: new Date('2026-03-30T10:00:00Z'),
        event_type: 'signal',
        coin: 'BTC',
        details: { grade: 'A' },
        agent_state: 'IDLE',
      },
      {
        id: 2,
        ts: new Date('2026-03-30T10:01:00Z'),
        event_type: 'enter',
        coin: 'BTC',
        details: { fillPrice: 50000 },
        agent_state: 'ENTERING',
      },
    ]

    const entries = await getJournalEntries()

    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).toBe(1)
    expect(entries[0]!.eventType).toBe('signal')
    expect(entries[0]!.coin).toBe('BTC')
    expect(entries[0]!.details).toEqual({ grade: 'A' })
    expect(entries[0]!.agentState).toBe('IDLE')
    expect(entries[1]!.eventType).toBe('enter')
  })

  it('passes coin filter to query', async () => {
    sqlMockResult = []
    await getJournalEntries({ coin: 'ETH' })

    expect(anyQueryContains('trade_journal')).toBe(true)
    expect(allInterpolatedValues()).toContain('ETH')
  })

  it('passes eventType filter to query', async () => {
    sqlMockResult = []
    await getJournalEntries({ eventType: 'exit' })

    expect(anyQueryContains('trade_journal')).toBe(true)
    expect(allInterpolatedValues()).toContain('exit')
  })

  it('passes both coin and eventType filters', async () => {
    sqlMockResult = []
    await getJournalEntries({ coin: 'SOL', eventType: 'signal' })

    const values = allInterpolatedValues()
    expect(values).toContain('SOL')
    expect(values).toContain('signal')
  })

  it('passes since/until date filters', async () => {
    sqlMockResult = []
    const since = new Date('2026-03-01T00:00:00Z')
    const until = new Date('2026-03-31T23:59:59Z')
    await getJournalEntries({ since, until })

    const values = allInterpolatedValues()
    expect(values).toContainEqual(since)
    expect(values).toContainEqual(until)
  })

  it('clamps limit: over max → 500', async () => {
    sqlMockResult = []
    await getJournalEntries({ limit: 9999 })
    expect(allInterpolatedValues()).toContain(500)
  })

  it('clamps limit: under min → 1', async () => {
    sqlMockResult = []
    await getJournalEntries({ limit: -5 })
    expect(allInterpolatedValues()).toContain(1)
  })

  it('defaults limit to 50', async () => {
    sqlMockResult = []
    await getJournalEntries()
    expect(allInterpolatedValues()).toContain(50)
  })

  it('returns empty array when DB returns empty', async () => {
    sqlMockResult = []
    const entries = await getJournalEntries()
    expect(entries).toEqual([])
  })
})

// ── getDailySummary ─────────────────────────────────────────────────────────

describe('getDailySummary', () => {
  it('returns zero summary when no exits found', async () => {
    sqlMockResult = []

    const summary = await getDailySummary(new Date('2026-03-30'))

    expect(summary.date).toBe('2026-03-30')
    expect(summary.totalTrades).toBe(0)
    expect(summary.wins).toBe(0)
    expect(summary.losses).toBe(0)
    expect(summary.winRate).toBe(0)
    expect(summary.totalPnl).toBe(0)
    expect(summary.avgPnl).toBe(0)
    expect(summary.largestWin).toBe(0)
    expect(summary.largestLoss).toBe(0)
    expect(summary.entryCount).toBe(0)
  })

  it('queries with correct UTC day bounds', async () => {
    sqlMockResult = []
    await getDailySummary(new Date('2026-01-15T12:30:00Z'))

    const values = allInterpolatedValues()
    // Should contain the day start/end bounds
    expect(values).toContainEqual(new Date('2026-01-15T00:00:00Z'))
    expect(values).toContainEqual(new Date('2026-01-15T23:59:59.999Z'))
  })

  it('queries for exit events with pnl', async () => {
    sqlMockResult = []
    await getDailySummary(new Date('2026-03-30'))

    expect(anyQueryContains('exit')).toBe(true)
    expect(anyQueryContains('pnl')).toBe(true)
  })

  it('computes win/loss stats from exit rows', async () => {
    // Simulate: first call (exits) returns PnL rows, second call (count) returns count
    // Since our mock returns the same result for all calls, we test the math
    // by setting the result to exit rows (count query will also get these, but
    // the code handles it: cnt comes from [0].cnt which won't exist on exit rows → 0)
    sqlMockResult = [
      { pnl: 100 },
      { pnl: -30 },
      { pnl: 50 },
      { pnl: -20 },
    ]

    const summary = await getDailySummary(new Date('2026-03-30'))

    expect(summary.totalTrades).toBe(4)
    expect(summary.wins).toBe(2)
    expect(summary.losses).toBe(2)
    expect(summary.winRate).toBe(0.5)
    expect(summary.totalPnl).toBe(100)  // 100 - 30 + 50 - 20
    expect(summary.avgPnl).toBe(25)     // 100 / 4
    expect(summary.largestWin).toBe(100)
    expect(summary.largestLoss).toBe(-30)
  })

  it('handles all-wins scenario', async () => {
    sqlMockResult = [{ pnl: 50 }, { pnl: 80 }]

    const summary = await getDailySummary(new Date('2026-03-30'))

    expect(summary.wins).toBe(2)
    expect(summary.losses).toBe(0)
    expect(summary.winRate).toBe(1)
    expect(summary.largestLoss).toBe(0)
  })

  it('handles all-losses scenario', async () => {
    sqlMockResult = [{ pnl: -10 }, { pnl: -40 }]

    const summary = await getDailySummary(new Date('2026-03-30'))

    expect(summary.wins).toBe(0)
    expect(summary.losses).toBe(2)
    expect(summary.winRate).toBe(0)
    expect(summary.largestWin).toBe(0)
  })
})

// ── Integration: state machine action shape ─────────────────────────────────

describe('integration: journalAction shape', () => {
  it('trading-agent log_journal action has correct fields', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'BTC',
      details: { setupId: 'BTC|1h|fvg|long', grade: 'A', confidence: 0.9 },
    }

    expect(action.type).toBe('log_journal')
    expect(action.eventType).toBe('signal')
    expect(action.coin).toBe('BTC')
    expect(action.details.setupId).toBe('BTC|1h|fvg|long')
  })

  it('all event types produce valid journal actions', async () => {
    const eventTypes = [
      'signal', 'enter', 'exit', 'skip', 'invalidate',
      'circuit_break', 'pause', 'resume', 'error',
    ]

    for (const eventType of eventTypes) {
      allSqlCalls = []
      const action: AgentAction = {
        type: 'log_journal',
        eventType,
        coin: 'BTC',
        details: { reason: 'test' },
      }
      handleJournalAction(action, 'IDLE')
      await new Promise(r => setTimeout(r, 10))

      expect(allInterpolatedValues()).toContain(eventType)
    }
  })
})
