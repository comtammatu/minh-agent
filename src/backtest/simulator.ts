/**
 * Backtest trade simulator — mock execution with slippage + commission.
 *
 * Tracks open positions, checks SL/TP on each candle bar,
 * records completed trades. Pure logic, zero I/O.
 *
 * Design:
 *   - One position per coin (same as live agent rule)
 *   - Fill at signal.entryPrice ± slippage
 *   - SL/TP from signal (pipeline-computed)
 *   - Position size from exits.ts computePositionSize
 *   - Commission applied at entry + exit
 */

import type { Candle, ActiveSetup, SignalSide } from '../types.js'
import type { BacktestTrade } from './types.js'
import { computePositionSize } from '../agent/exits.js'
import { DEFAULT_RISK_PERCENT } from '../config.js'

// ─── Open Position ──────────────────────────────────────────────────────────

interface OpenPosition {
  coin: string
  setup: ActiveSetup
  side: SignalSide
  entryPrice: number
  slPrice: number
  tpPrice: number
  sizeUsd: number
  entryTime: number
  entryBarIndex: number
}

// ─── Simulator ──────────────────────────────────────────────────────────────

export class TradeSimulator {
  private positions = new Map<string, OpenPosition>()
  private trades: BacktestTrade[] = []
  private equity: number
  private slippagePct: number
  private commissionPct: number

  constructor(initialCapital: number, slippagePct: number, commissionPct: number) {
    this.equity = initialCapital
    this.slippagePct = slippagePct
    this.commissionPct = commissionPct
  }

  /** Try to open a position from a detected setup. Returns true if filled. */
  tryFill(setup: ActiveSetup, barIndex: number): boolean {
    // One position per coin
    if (this.positions.has(setup.coin)) return false

    const { side, entryPrice, slPrice, tpPrice } = setup

    // Apply slippage: long fills higher, short fills lower
    const slippage = entryPrice * this.slippagePct
    const fillPrice = side === 'long'
      ? entryPrice + slippage
      : entryPrice - slippage

    // Position sizing using exits.ts (same code path as live)
    const sizeCoins = computePositionSize(this.equity, DEFAULT_RISK_PERCENT, fillPrice, slPrice)
    const sizeUsd = sizeCoins * fillPrice
    if (sizeUsd <= 0) return false

    // Entry commission
    const entryCost = sizeUsd * this.commissionPct
    this.equity -= entryCost

    this.positions.set(setup.coin, {
      coin: setup.coin,
      setup,
      side,
      entryPrice: fillPrice,
      slPrice,
      tpPrice,
      sizeUsd,
      entryTime: setup.detectedAt,
      entryBarIndex: barIndex,
    })

    return true
  }

  /**
   * Check all open positions against a candle bar.
   * If SL or TP is hit, close the position and record the trade.
   *
   * Order of checks per bar (conservative — SL checked first):
   *   1. SL hit? → close at SL price (worst case)
   *   2. TP hit? → close at TP price
   */
  checkBar(coin: string, candle: Candle, barIndex: number): void {
    const pos = this.positions.get(coin)
    if (!pos) return

    // Check SL
    if (this.isSLHit(pos, candle)) {
      this.closePosition(pos, pos.slPrice, barIndex, candle.t, 'sl_hit')
      return
    }

    // Check TP
    if (this.isTPHit(pos, candle)) {
      this.closePosition(pos, pos.tpPrice, barIndex, candle.t, 'tp_hit')
      return
    }
  }

  /** Force-close all remaining positions (end of data). */
  closeAll(closePrice: number, barIndex: number, closeTime: number): void {
    for (const [_coin, pos] of this.positions) {
      this.closePosition(pos, closePrice, barIndex, closeTime, 'end_of_data')
    }
  }

  /** Close a specific coin position (invalidation). */
  closeByInvalidation(coin: string, closePrice: number, barIndex: number, closeTime: number): void {
    const pos = this.positions.get(coin)
    if (!pos) return
    this.closePosition(pos, closePrice, barIndex, closeTime, 'invalidated')
  }

  /** Check if a coin has an open position. */
  hasPosition(coin: string): boolean {
    return this.positions.has(coin)
  }

  /** Get current equity. */
  getEquity(): number {
    return this.equity
  }

  /** Get all completed trades. */
  getTrades(): BacktestTrade[] {
    return this.trades
  }

  /** Get count of open positions. */
  openPositionCount(): number {
    return this.positions.size
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private isSLHit(pos: OpenPosition, candle: Candle): boolean {
    if (pos.side === 'long') {
      return candle.l <= pos.slPrice
    }
    return candle.h >= pos.slPrice
  }

  private isTPHit(pos: OpenPosition, candle: Candle): boolean {
    if (pos.side === 'long') {
      return candle.h >= pos.tpPrice
    }
    return candle.l <= pos.tpPrice
  }

  private closePosition(
    pos: OpenPosition,
    exitPrice: number,
    barIndex: number,
    exitTime: number,
    exitReason: BacktestTrade['exitReason'],
  ): void {
    // Apply slippage on exit: long exit fills lower, short exit fills higher
    const slippage = exitPrice * this.slippagePct
    const fillExitPrice = pos.side === 'long'
      ? exitPrice - slippage
      : exitPrice + slippage

    // Compute PnL
    const priceChange = pos.side === 'long'
      ? fillExitPrice - pos.entryPrice
      : pos.entryPrice - fillExitPrice
    const rawPnl = (priceChange / pos.entryPrice) * pos.sizeUsd

    // Exit commission
    const exitCost = pos.sizeUsd * this.commissionPct
    const pnl = rawPnl - exitCost

    this.equity += pnl

    const holdingBars = barIndex - pos.entryBarIndex

    this.trades.push({
      coin: pos.coin,
      interval: pos.setup.interval,
      side: pos.side,
      patternType: pos.setup.type,
      confluenceGrade: pos.setup.confluenceGrade ?? null,
      entryPrice: pos.entryPrice,
      exitPrice: fillExitPrice,
      slPrice: pos.slPrice,
      tpPrice: pos.tpPrice,
      sizeUsd: pos.sizeUsd,
      entryTime: pos.entryTime,
      exitTime,
      holdingBars,
      pnl,
      pnlPct: pos.sizeUsd > 0 ? pnl / pos.sizeUsd : 0,
      exitReason,
    })

    this.positions.delete(pos.coin)
  }
}
