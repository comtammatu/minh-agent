/**
 * Paper P&L Tracker — simulated balance for PAPER_TRADE mode.
 *
 * Tracks entry/exit of paper trades, computes P&L, updates balance.
 * Balance starts at SIMULATED_ACCOUNT and changes after each closed trade.
 * Equity curve stored in-memory (no DB needed for paper mode).
 *
 * Singleton — accessed via getPaperTracker().
 */

import { SIMULATED_ACCOUNT, PAPER_SLIPPAGE_PCT } from '../config.js'
import { log } from '../lib/logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PaperTrade {
  orderId: string
  coin: string
  side: 'long' | 'short'
  entryPrice: number
  closePrice: number
  size: number       // in coins
  pnl: number        // USD
  openedAt: number
  closedAt: number
}

interface OpenPosition {
  orderId: string
  coin: string
  side: 'long' | 'short'
  entryPrice: number
  size: number
  openedAt: number
}

export interface EquityPoint {
  ts: number
  balance: number
}

// ─── PaperTracker Class ─────────────────────────────────────────────────────

export class PaperTracker {
  private balance: number
  private openPositions: Map<string, OpenPosition> = new Map()
  private closedTrades: PaperTrade[] = []
  private equityCurve: EquityPoint[] = []

  constructor(initialBalance: number = SIMULATED_ACCOUNT) {
    this.balance = initialBalance
    this.equityCurve.push({ ts: Date.now(), balance: this.balance })
  }

  /** Get current simulated balance. */
  getBalance(): number {
    return this.balance
  }

  /** Get all closed trades. */
  getTrades(): readonly PaperTrade[] {
    return this.closedTrades
  }

  /** Get equity curve. */
  getEquityCurve(): readonly EquityPoint[] {
    return this.equityCurve
  }

  /** Get count of open positions. */
  getOpenCount(): number {
    return this.openPositions.size
  }

  /**
   * Record a paper entry fill.
   * Called by OrderManager when paper order fills.
   */
  recordEntry(orderId: string, coin: string, side: 'long' | 'short', entryPrice: number, size: number): void {
    this.openPositions.set(orderId, {
      orderId,
      coin,
      side,
      entryPrice,
      size,
      openedAt: Date.now(),
    })
    log.info('paper-tracker', `Entry: ${coin} ${side} ${size.toFixed(4)} @ ${entryPrice.toFixed(2)} | balance=${this.balance.toFixed(2)}`)
  }

  /**
   * Record a paper exit and compute P&L.
   * Returns the closed trade with P&L. Updates balance.
   * Returns null if orderId not found (already closed or never opened).
   */
  recordExit(orderId: string, closePrice: number): PaperTrade | null {
    const pos = this.openPositions.get(orderId)
    if (!pos) {
      log.warn('paper-tracker', `Exit for unknown orderId=${orderId} — already closed or never tracked`)
      return null
    }

    const direction = pos.side === 'long' ? 1 : -1
    const pnl = (closePrice - pos.entryPrice) * pos.size * direction

    const trade: PaperTrade = {
      orderId: pos.orderId,
      coin: pos.coin,
      side: pos.side,
      entryPrice: pos.entryPrice,
      closePrice,
      size: pos.size,
      pnl,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
    }

    this.balance += pnl
    this.closedTrades.push(trade)
    this.equityCurve.push({ ts: trade.closedAt, balance: this.balance })
    this.openPositions.delete(orderId)

    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
    log.info('paper-tracker', `Exit: ${pos.coin} ${pos.side} @ ${closePrice.toFixed(2)} | P&L=${pnlStr} | balance=${this.balance.toFixed(2)}`)

    return trade
  }

  /** Reset all state (for tests). */
  reset(initialBalance: number = SIMULATED_ACCOUNT): void {
    this.balance = initialBalance
    this.openPositions.clear()
    this.closedTrades = []
    this.equityCurve = [{ ts: Date.now(), balance: this.balance }]
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: PaperTracker | null = null

export function getPaperTracker(): PaperTracker {
  if (!instance) {
    instance = new PaperTracker()
  }
  return instance
}

/** Reset singleton (tests only). */
export function resetPaperTracker(): void {
  instance = null
}
