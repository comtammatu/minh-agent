/**
 * Paper P&L Tracker — simulated balance for PAPER_TRADE mode.
 *
 * One {@link PaperTracker} per strategy (mirrors multi-wallet ExchangePool in live mode).
 * Balances start at {@link getPaperInitialBalance} per strategy (env overrides).
 *
 * Access: `getPaperTracker(strategyId)` — lazy-creates the tracker for that wallet.
 */

import {
  PAPER_DEFAULT_BALANCE_PER_WALLET,
  PAPER_WALLET_STRATEGY_IDS,
  getPaperInitialBalance,
} from '../config.js'
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

/** Per-strategy paper wallet summary (TUI / metrics). */
export interface PaperWalletSummary {
  strategyId: string
  balance: number
  tradeCount: number
  wins: number
  losses: number
  winRate: number
}

// ─── PaperTracker Class ─────────────────────────────────────────────────────

export class PaperTracker {
  private balance: number
  private openPositions: Map<string, OpenPosition> = new Map()
  private closedTrades: PaperTrade[] = []
  private equityCurve: EquityPoint[] = []

  constructor(initialBalance: number = PAPER_DEFAULT_BALANCE_PER_WALLET) {
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
  reset(initialBalance: number = PAPER_DEFAULT_BALANCE_PER_WALLET): void {
    this.balance = initialBalance
    this.openPositions.clear()
    this.closedTrades = []
    this.equityCurve = [{ ts: Date.now(), balance: this.balance }]
  }
}

// ─── Per-strategy registry (mirrors 3-wallet live) ──────────────────────────

const trackers = new Map<string, PaperTracker>()

/**
 * Get the paper P&L tracker for a strategy wallet (lazy init).
 * Unknown `strategyId` still gets a tracker using {@link getPaperInitialBalance}.
 */
export function getPaperTracker(strategyId: string): PaperTracker {
  let t = trackers.get(strategyId)
  if (!t) {
    t = new PaperTracker(getPaperInitialBalance(strategyId))
    trackers.set(strategyId, t)
  }
  return t
}

/** Eager-init trackers for all configured paper wallets (optional UI/metrics). */
export function ensurePaperWalletsInitialized(): void {
  for (const id of PAPER_WALLET_STRATEGY_IDS) {
    getPaperTracker(id)
  }
}

/**
 * Summaries for each known paper wallet + aggregates (TUI).
 */
export function getPaperWalletSummaries(): PaperWalletSummary[] {
  const out: PaperWalletSummary[] = []
  for (const id of PAPER_WALLET_STRATEGY_IDS) {
    const pt = getPaperTracker(id)
    const trades = pt.getTrades()
    const wins = trades.filter(t => t.pnl > 0).length
    const losses = trades.filter(t => t.pnl <= 0).length
    const total = trades.length
    out.push({
      strategyId: id,
      balance: pt.getBalance(),
      tradeCount: total,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
    })
  }
  return out
}

/** Sum of balances across known paper wallets. */
export function getTotalPaperBalance(): number {
  return getPaperWalletSummaries().reduce((s, w) => s + w.balance, 0)
}

/** Reset all paper trackers (tests only). */
export function resetPaperTracker(): void {
  trackers.clear()
}
