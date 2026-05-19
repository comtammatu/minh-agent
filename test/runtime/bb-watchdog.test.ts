import { describe, it, expect } from 'bun:test'
import { evaluateHeartbeat } from '../../scripts/bb-watchdog.js'
import {
  isBbWatchdogEnabled,
  BB_HEARTBEAT_WRITE_MS,
  BB_HEARTBEAT_THRESHOLD_MS,
} from '../../src/config.js'

/**
 * Watchdog decision logic — pure function, no IO, no Bybit calls.
 *
 * Decision matrix (mirrors docs/operations/dead-man-switch.md):
 *
 *   record  | age vs threshold | pid alive | decision
 *   --------|------------------|-----------|------------------
 *   null    | —                | —         | sleep (intentional stop)
 *   present | fresh            | —         | sleep
 *   present | stale            | true      | cancel (freeze)
 *   present | stale            | false     | cancel (crash)
 */
describe('evaluateHeartbeat', () => {
  const THRESHOLD = 300_000  // 5 min, matching BB_HEARTBEAT_THRESHOLD_MS default

  it('sleeps when the heartbeat file is missing (treated as intentional shutdown)', () => {
    const decision = evaluateHeartbeat({
      record: null,
      now: 1_700_000_000_000,
      thresholdMs: THRESHOLD,
      isAlive: () => true,  // shouldn't be consulted
    })
    expect(decision.action).toBe('sleep')
    expect(decision.reason).toBe('no-heartbeat-file')
  })

  it('sleeps when the heartbeat is fresh, regardless of pid liveness', () => {
    const now = 1_700_000_000_000
    const decision = evaluateHeartbeat({
      record: { pid: 1234, ts: now - 30_000 },  // 30s old, well under threshold
      now,
      thresholdMs: THRESHOLD,
      isAlive: () => true,
    })
    expect(decision.action).toBe('sleep')
    expect(decision.reason).toBe('fresh')
  })

  it('sleeps right up to but not including the threshold boundary', () => {
    const now = 1_700_000_000_000
    const justUnder = evaluateHeartbeat({
      record: { pid: 1234, ts: now - (THRESHOLD - 1) },
      now,
      thresholdMs: THRESHOLD,
      isAlive: () => false,  // even with dead pid, fresh-enough wins
    })
    expect(justUnder.action).toBe('sleep')
  })

  it('cancels with "stale-but-alive" when file is stale AND pid is still alive (freeze case)', () => {
    const now = 1_700_000_000_000
    const decision = evaluateHeartbeat({
      record: { pid: 1234, ts: now - 600_000 },  // 10 min old
      now,
      thresholdMs: THRESHOLD,
      isAlive: () => true,
    })
    expect(decision.action).toBe('cancel')
    if (decision.action === 'cancel') {
      expect(decision.reason).toBe('stale-but-alive')
      expect(decision.pid).toBe(1234)
      expect(decision.ageMs).toBe(600_000)
    }
  })

  it('cancels with "stale-and-dead" when file is stale AND pid is gone (crash case)', () => {
    const now = 1_700_000_000_000
    const decision = evaluateHeartbeat({
      record: { pid: 9999, ts: now - 600_000 },
      now,
      thresholdMs: THRESHOLD,
      isAlive: () => false,
    })
    expect(decision.action).toBe('cancel')
    if (decision.action === 'cancel') {
      expect(decision.reason).toBe('stale-and-dead')
      expect(decision.pid).toBe(9999)
      expect(decision.ageMs).toBe(600_000)
    }
  })

  it('cancels exactly at threshold boundary (age == threshold → stale)', () => {
    const now = 1_700_000_000_000
    const decision = evaluateHeartbeat({
      record: { pid: 1234, ts: now - THRESHOLD },
      now,
      thresholdMs: THRESHOLD,
      isAlive: () => false,
    })
    expect(decision.action).toBe('cancel')
  })

  it('only calls isAlive when the file is stale (no liveness probe on the fresh path)', () => {
    let probed = false
    const isAlive = (): boolean => {
      probed = true
      return true
    }
    evaluateHeartbeat({
      record: { pid: 1234, ts: 1_700_000_000_000 - 1_000 },
      now: 1_700_000_000_000,
      thresholdMs: THRESHOLD,
      isAlive,
    })
    expect(probed).toBe(false)
  })

  it('does not consult isAlive when the file is missing', () => {
    let probed = false
    evaluateHeartbeat({
      record: null,
      now: 1_700_000_000_000,
      thresholdMs: THRESHOLD,
      isAlive: () => {
        probed = true
        return true
      },
    })
    expect(probed).toBe(false)
  })
})

/**
 * Gating policy — isBbWatchdogEnabled mirrors isDmsEnabled but for Bybit.
 * Lock in the contract so the watchdog and the main process arm/disarm together.
 */
describe('isBbWatchdogEnabled', () => {
  let origExchange: string | undefined
  let origPaper: string | undefined

  function setEnv(active: string | null, paper: string | null): void {
    origExchange = process.env['ACTIVE_EXCHANGE']
    origPaper = process.env['PAPER_TRADE']
    if (active === null) delete process.env['ACTIVE_EXCHANGE']
    else process.env['ACTIVE_EXCHANGE'] = active
    if (paper === null) delete process.env['PAPER_TRADE']
    else process.env['PAPER_TRADE'] = paper
  }

  function restoreEnv(): void {
    if (origExchange === undefined) delete process.env['ACTIVE_EXCHANGE']
    else process.env['ACTIVE_EXCHANGE'] = origExchange
    if (origPaper === undefined) delete process.env['PAPER_TRADE']
    else process.env['PAPER_TRADE'] = origPaper
  }

  it('true when ACTIVE_EXCHANGE=BB AND PAPER_TRADE=false', () => {
    setEnv('BB', 'false')
    try {
      expect(isBbWatchdogEnabled()).toBe(true)
    } finally {
      restoreEnv()
    }
  })

  it('false when ACTIVE_EXCHANGE=BB but paper-mode (safe default)', () => {
    setEnv('BB', null)
    try {
      expect(isBbWatchdogEnabled()).toBe(false)
    } finally {
      restoreEnv()
    }
  })

  it('false when ACTIVE_EXCHANGE=HL even if PAPER_TRADE=false (HL uses its own DMS)', () => {
    setEnv('HL', 'false')
    try {
      expect(isBbWatchdogEnabled()).toBe(false)
    } finally {
      restoreEnv()
    }
  })

  it('false when ACTIVE_EXCHANGE is unset', () => {
    setEnv(null, 'false')
    try {
      expect(isBbWatchdogEnabled()).toBe(false)
    } finally {
      restoreEnv()
    }
  })
})

/**
 * Cadence invariants — keep the threshold an honest multiple of the write
 * cadence so a brief stutter never trips a false-positive cancel.
 */
describe('cadence invariants', () => {
  it('threshold is at least 5x the write cadence (safety margin)', () => {
    expect(BB_HEARTBEAT_THRESHOLD_MS).toBeGreaterThanOrEqual(BB_HEARTBEAT_WRITE_MS * 5)
  })

  it('threshold defaults to ≥ 1 minute (avoids GC/IO false-positives)', () => {
    expect(BB_HEARTBEAT_THRESHOLD_MS).toBeGreaterThanOrEqual(60_000)
  })
})
