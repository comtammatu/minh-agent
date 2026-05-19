import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  DMS_DEADLINE_MS,
  DMS_REFRESH_MS,
  isDmsEnabled,
  isPaperMode,
} from '../../src/config.js'

/**
 * HL dead-man-switch gating + operational-budget invariants.
 *
 * These are policy tests: they don't boot the runtime. They lock in the
 * config-level contract that runtime/app.ts depends on so the arming logic
 * stays inside HL's published limits (≥5s schedule minimum, ≤10 ops/day).
 */
describe('DMS arming policy', () => {
  let origExchange: string | undefined
  let origPaper: string | undefined

  beforeEach(() => {
    origExchange = process.env['ACTIVE_EXCHANGE']
    origPaper = process.env['PAPER_TRADE']
  })

  afterEach(() => {
    if (origExchange === undefined) delete process.env['ACTIVE_EXCHANGE']
    else process.env['ACTIVE_EXCHANGE'] = origExchange
    if (origPaper === undefined) delete process.env['PAPER_TRADE']
    else process.env['PAPER_TRADE'] = origPaper
  })

  describe('isPaperMode', () => {
    it('defaults to true when PAPER_TRADE is unset', () => {
      delete process.env['PAPER_TRADE']
      expect(isPaperMode()).toBe(true)
    })

    it('returns true for PAPER_TRADE=true', () => {
      process.env['PAPER_TRADE'] = 'true'
      expect(isPaperMode()).toBe(true)
    })

    it('returns false only for the exact string "false"', () => {
      process.env['PAPER_TRADE'] = 'false'
      expect(isPaperMode()).toBe(false)
    })

    it('treats any other value as paper (safe default)', () => {
      process.env['PAPER_TRADE'] = 'no'
      expect(isPaperMode()).toBe(true)
      process.env['PAPER_TRADE'] = '0'
      expect(isPaperMode()).toBe(true)
      process.env['PAPER_TRADE'] = ''
      expect(isPaperMode()).toBe(true)
    })
  })

  describe('isDmsEnabled', () => {
    it('true when HL + PAPER_TRADE=false', () => {
      process.env['ACTIVE_EXCHANGE'] = 'HL'
      process.env['PAPER_TRADE'] = 'false'
      expect(isDmsEnabled()).toBe(true)
    })

    it('false when HL + paper (safe default)', () => {
      process.env['ACTIVE_EXCHANGE'] = 'HL'
      delete process.env['PAPER_TRADE']
      expect(isDmsEnabled()).toBe(false)
    })

    it('false when BB even if PAPER_TRADE=false (no HL DMS for Bybit)', () => {
      process.env['ACTIVE_EXCHANGE'] = 'BB'
      process.env['PAPER_TRADE'] = 'false'
      expect(isDmsEnabled()).toBe(false)
    })

    it('false when ACTIVE_EXCHANGE is unset', () => {
      delete process.env['ACTIVE_EXCHANGE']
      process.env['PAPER_TRADE'] = 'false'
      expect(isDmsEnabled()).toBe(false)
    })
  })

  describe('cadence invariants', () => {
    it('deadline exceeds HL\'s 5s minimum by a wide margin', () => {
      expect(DMS_DEADLINE_MS).toBeGreaterThan(5_000)
    })

    it('refresh fires before the deadline expires', () => {
      expect(DMS_REFRESH_MS).toBeLessThan(DMS_DEADLINE_MS)
    })

    it('refresh leaves slack ≥ HL\'s 5s schedule minimum before the deadline', () => {
      expect(DMS_DEADLINE_MS - DMS_REFRESH_MS).toBeGreaterThanOrEqual(5_000)
    })

    it('daily refresh budget stays under HL\'s 10 ops/day cap', () => {
      const opsPerDay = (24 * 60 * 60 * 1000) / DMS_REFRESH_MS
      expect(opsPerDay).toBeLessThanOrEqual(10)
    })
  })
})
