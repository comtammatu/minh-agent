/**
 * Paper P&L Tracker tests.
 *
 * Verifies: balance tracking, P&L computation, equity curve,
 * long/short directions, multiple trades, edge cases.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { PaperTracker, getPaperTracker, resetPaperTracker } from './paper-tracker.js'

describe('PaperTracker', () => {
  let tracker: PaperTracker

  beforeEach(() => {
    tracker = new PaperTracker(10_000)
  })

  // ── Basic ────────────────────────────────────────────────────────────────

  it('starts with initial balance', () => {
    expect(tracker.getBalance()).toBe(10_000)
    expect(tracker.getTrades()).toHaveLength(0)
    expect(tracker.getOpenCount()).toBe(0)
  })

  it('equity curve has initial point', () => {
    expect(tracker.getEquityCurve()).toHaveLength(1)
    expect(tracker.getEquityCurve()[0]!.balance).toBe(10_000)
  })

  // ── Long trade ───────────────────────────────────────────────────────────

  it('computes positive P&L for winning long', () => {
    tracker.recordEntry('order-1', 'BTC', 'long', 50_000, 0.1)
    expect(tracker.getOpenCount()).toBe(1)

    const trade = tracker.recordExit('order-1', 51_000)
    expect(trade).not.toBeNull()
    // P&L = (51000 - 50000) × 0.1 × 1 = +100
    expect(trade!.pnl).toBeCloseTo(100, 2)
    expect(tracker.getBalance()).toBeCloseTo(10_100, 2)
    expect(tracker.getOpenCount()).toBe(0)
  })

  it('computes negative P&L for losing long', () => {
    tracker.recordEntry('order-1', 'ETH', 'long', 3_000, 1)
    const trade = tracker.recordExit('order-1', 2_900)
    // P&L = (2900 - 3000) × 1 × 1 = -100
    expect(trade!.pnl).toBeCloseTo(-100, 2)
    expect(tracker.getBalance()).toBeCloseTo(9_900, 2)
  })

  // ── Short trade ──────────────────────────────────────────────────────────

  it('computes positive P&L for winning short', () => {
    tracker.recordEntry('order-1', 'BTC', 'short', 50_000, 0.1)
    const trade = tracker.recordExit('order-1', 49_000)
    // P&L = (49000 - 50000) × 0.1 × (-1) = +100
    expect(trade!.pnl).toBeCloseTo(100, 2)
    expect(tracker.getBalance()).toBeCloseTo(10_100, 2)
  })

  it('computes negative P&L for losing short', () => {
    tracker.recordEntry('order-1', 'SOL', 'short', 100, 10)
    const trade = tracker.recordExit('order-1', 105)
    // P&L = (105 - 100) × 10 × (-1) = -50
    expect(trade!.pnl).toBeCloseTo(-50, 2)
    expect(tracker.getBalance()).toBeCloseTo(9_950, 2)
  })

  // ── Multiple trades ──────────────────────────────────────────────────────

  it('accumulates balance across multiple trades', () => {
    // Trade 1: long BTC, win +100
    tracker.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    tracker.recordExit('o1', 51_000)

    // Trade 2: short ETH, win +200
    tracker.recordEntry('o2', 'ETH', 'short', 3_000, 1)
    tracker.recordExit('o2', 2_800)

    // Trade 3: long SOL, lose -50
    tracker.recordEntry('o3', 'SOL', 'long', 100, 10)
    tracker.recordExit('o3', 95)

    expect(tracker.getBalance()).toBeCloseTo(10_250, 2) // 10000 + 100 + 200 - 50
    expect(tracker.getTrades()).toHaveLength(3)
    expect(tracker.getEquityCurve()).toHaveLength(4) // initial + 3 exits
  })

  it('handles concurrent open positions', () => {
    tracker.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    tracker.recordEntry('o2', 'ETH', 'short', 3_000, 1)
    expect(tracker.getOpenCount()).toBe(2)

    tracker.recordExit('o2', 2_900) // ETH win +100
    expect(tracker.getOpenCount()).toBe(1)
    expect(tracker.getBalance()).toBeCloseTo(10_100, 2)

    tracker.recordExit('o1', 49_000) // BTC loss -100
    expect(tracker.getOpenCount()).toBe(0)
    expect(tracker.getBalance()).toBeCloseTo(10_000, 2)
  })

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('returns null for unknown orderId on exit', () => {
    const result = tracker.recordExit('nonexistent', 50_000)
    expect(result).toBeNull()
    expect(tracker.getBalance()).toBe(10_000)
  })

  it('returns null for double exit (already closed)', () => {
    tracker.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    tracker.recordExit('o1', 51_000)
    const second = tracker.recordExit('o1', 52_000)
    expect(second).toBeNull()
    // Balance should only reflect first exit
    expect(tracker.getBalance()).toBeCloseTo(10_100, 2)
  })

  it('reset clears all state', () => {
    tracker.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    tracker.recordExit('o1', 51_000)

    tracker.reset(5_000)
    expect(tracker.getBalance()).toBe(5_000)
    expect(tracker.getTrades()).toHaveLength(0)
    expect(tracker.getOpenCount()).toBe(0)
    expect(tracker.getEquityCurve()).toHaveLength(1)
    expect(tracker.getEquityCurve()[0]!.balance).toBe(5_000)
  })

  it('trade object has correct fields', () => {
    tracker.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    const trade = tracker.recordExit('o1', 51_000)!

    expect(trade.orderId).toBe('o1')
    expect(trade.coin).toBe('BTC')
    expect(trade.side).toBe('long')
    expect(trade.entryPrice).toBe(50_000)
    expect(trade.closePrice).toBe(51_000)
    expect(trade.size).toBe(0.1)
    expect(trade.openedAt).toBeGreaterThan(0)
    expect(trade.closedAt).toBeGreaterThanOrEqual(trade.openedAt)
  })
})

// ── Per-strategy registry ───────────────────────────────────────────────────

describe('getPaperTracker (per strategy)', () => {
  beforeEach(() => {
    resetPaperTracker()
  })

  it('isolates balances per strategyId', () => {
    const layered = getPaperTracker('smc-sd')
    const quant = getPaperTracker('alpha')
    layered.recordEntry('o1', 'BTC', 'long', 50_000, 0.1)
    layered.recordExit('o1', 51_000)
    expect(layered.getBalance()).not.toBe(quant.getBalance())
    expect(quant.getTrades()).toHaveLength(0)
  })

  it('returns same instance for same strategyId', () => {
    expect(getPaperTracker('smc-sd')).toBe(getPaperTracker('smc-sd'))
  })
})
