/**
 * Backtest trade simulator — multi-level exit with partial close + trailing stop.
 *
 * Exit strategy:
 *   - TP1 (40%): Nearest opposing zone — secure partial profit
 *   - TP2 (30%): Swing structure target — capture trend move
 *   - TP3 (30%): ATR-based trailing stop — let winner run
 *   - SL moves to breakeven after TP1 hit
 *
 * Design:
 *   - One position per coin (same as live agent rule)
 *   - Fill at signal.entryPrice ± slippage
 *   - Position size from exits.ts computePositionSize
 *   - Commission applied at entry + exit (proportional to partial size)
 *   - SL checked first on each bar (conservative)
 */

import type { Candle, ActiveSetup, SignalSide, CandleInterval } from '../types.js'
import type { BacktestTrade, PartialCloseDetail } from './types.js'
import { computePositionSize } from '../agent/exits.js'
import { DEFAULT_RISK_PERCENT, MULTI_TP_SPLIT, TRAIL_ACTIVATION_R } from '../config.js'

// ─── Open Position ──────────────────────────────────────────────────────────

interface OpenPosition {
  coin: string
  interval: CandleInterval
  setup: ActiveSetup
  side: SignalSide
  entryPrice: number
  slPrice: number          // original SL
  currentSlPrice: number   // may move to breakeven after TP1
  tp1Price: number         // zone-based TP
  tp2Price: number         // swing-based TP
  sizeUsd: number          // original full size
  entryTime: number
  entryBarIndex: number

  // Multi-exit tracking
  remainingSizePct: number // 1.0 → decreases on each partial
  tp1Hit: boolean
  tp2Hit: boolean
  partialCloses: PartialCloseDetail[]

  // Trailing stop state
  trailingActive: boolean
  highWater: number        // highest price (long) / lowest (short) since entry
  trailStopPrice: number   // current trailing stop level

  // ATR for trailing distance
  atrValue: number
  trailMultiplier: number  // per-TF multiplier
}

// ─── Simulator ──────────────────────────────────────────────────────────────

/** Pending fill — queued on signal bar, executed at next bar's open. */
interface PendingFill {
  setup: ActiveSetup
  signalBarIndex: number
  atrValue: number
  trailMult: number
}

export class TradeSimulator {
  private positions = new Map<string, OpenPosition>()
  private pendingFills = new Map<string, PendingFill>()
  private trades: BacktestTrade[] = []
  private equity: number
  private slippagePct: number
  private commissionPct: number

  constructor(initialCapital: number, slippagePct: number, commissionPct: number) {
    this.equity = initialCapital
    this.slippagePct = slippagePct
    this.commissionPct = commissionPct
  }

  /**
   * Queue a setup for fill on the next bar's open.
   * Signal fires at bar N close → fill at bar N+1 open (no look-ahead bias).
   */
  tryFill(setup: ActiveSetup, barIndex: number, atrValue: number = 0, trailMult: number = 2.0): boolean {
    if (this.positions.has(setup.coin)) return false
    if (this.pendingFills.has(setup.coin)) return false

    this.pendingFills.set(setup.coin, { setup, signalBarIndex: barIndex, atrValue, trailMult })
    return true
  }

  /**
   * Execute a pending fill at the given candle's open price.
   * Called from checkBar when a pending fill exists for this coin.
   */
  private executePendingFill(pending: PendingFill, candle: Candle, barIndex: number): void {
    const { setup, atrValue, trailMult } = pending
    const { side, slPrice, tpPrice } = setup

    // Fill at THIS bar's open + slippage (realistic: next bar open after signal)
    const fillPrice = side === 'long'
      ? candle.o + candle.o * this.slippagePct
      : candle.o - candle.o * this.slippagePct

    // Position sizing using fill price
    const sizeCoins = computePositionSize(this.equity, DEFAULT_RISK_PERCENT, fillPrice, slPrice)
    const sizeUsd = sizeCoins * fillPrice
    if (sizeUsd <= 0) return

    // Entry commission
    this.equity -= sizeUsd * this.commissionPct

    // TP2 from patternData (set by computeStructureTargets in trigger.ts)
    const tp2 = (setup.patternData['tp2Price'] as number | undefined) ?? tpPrice

    this.positions.set(setup.coin, {
      coin: setup.coin,
      interval: setup.interval,
      setup,
      side,
      entryPrice: fillPrice,
      slPrice,
      currentSlPrice: slPrice,
      tp1Price: tpPrice,   // signal.tpPrice = TP1 (zone-based)
      tp2Price: tp2,
      sizeUsd,
      entryTime: candle.t,
      entryBarIndex: barIndex,
      remainingSizePct: 1.0,
      tp1Hit: false,
      tp2Hit: false,
      partialCloses: [],
      trailingActive: false,
      highWater: fillPrice,
      trailStopPrice: slPrice,
      atrValue,
      trailMultiplier: trailMult,
    })
  }

  /**
   * Check a coin against a candle bar.
   * 1. Execute pending fills at this bar's open (next-bar-open entry)
   * 2. Multi-level exit: SL → TP1 (40%) → TP2 (30%) → Trailing (30%)
   */
  checkBar(coin: string, candle: Candle, barIndex: number): void {
    // Execute pending fills at this bar's open
    const pending = this.pendingFills.get(coin)
    if (pending) {
      this.pendingFills.delete(coin)
      this.executePendingFill(pending, candle, barIndex)
      // Don't check SL/TP on the fill bar — trade just opened
      return
    }

    const pos = this.positions.get(coin)
    if (!pos) return

    const holdBars = barIndex - pos.entryBarIndex

    // ── 1. SL check (against current SL — may have moved to breakeven) ──
    if (this.isSLHit(pos, candle)) {
      // Close ALL remaining position at SL
      pos.partialCloses.push({
        price: pos.currentSlPrice,
        sizePct: pos.remainingSizePct,
        bar: holdBars,
        reason: pos.tp1Hit ? 'be_hit' : 'sl_hit',
      })
      pos.remainingSizePct = 0
      this.finalizePosition(pos, barIndex, candle.t, pos.tp1Hit ? 'trail_stop' : 'sl_hit')
      return
    }

    // ── 2. TP1 check (40% partial close at zone target) ──
    if (!pos.tp1Hit && this.isTPHit(pos, candle, pos.tp1Price)) {
      pos.tp1Hit = true
      const closePct = MULTI_TP_SPLIT[0]
      pos.partialCloses.push({
        price: pos.tp1Price,
        sizePct: closePct,
        bar: holdBars,
        reason: 'tp1_zone',
      })
      pos.remainingSizePct -= closePct

      // Move SL to breakeven (+ tiny buffer for slippage)
      const buffer = pos.entryPrice * 0.001
      pos.currentSlPrice = pos.side === 'long'
        ? pos.entryPrice + buffer
        : pos.entryPrice - buffer
    }

    // ── 3. TP2 check (30% partial close at swing target) ──
    if (pos.tp1Hit && !pos.tp2Hit && this.isTPHit(pos, candle, pos.tp2Price)) {
      pos.tp2Hit = true
      const closePct = MULTI_TP_SPLIT[1]
      pos.partialCloses.push({
        price: pos.tp2Price,
        sizePct: closePct,
        bar: holdBars,
        reason: 'tp2_swing',
      })
      pos.remainingSizePct -= closePct
    }

    // ── 4. Trailing stop update + check (remaining portion) ──
    if (pos.tp1Hit && pos.remainingSizePct > 0) {
      this.updateTrailing(pos, candle)

      if (pos.trailingActive && this.isTrailHit(pos, candle)) {
        pos.partialCloses.push({
          price: pos.trailStopPrice,
          sizePct: pos.remainingSizePct,
          bar: holdBars,
          reason: 'tp3_trail',
        })
        pos.remainingSizePct = 0
        this.finalizePosition(pos, barIndex, candle.t, 'trail_stop')
        return
      }
    }

    // ── 5. All portions closed? ──
    if (pos.remainingSizePct <= 0.001) {
      this.finalizePosition(pos, barIndex, candle.t, 'tp_hit')
    }
  }

  /** Force-close all remaining positions (end of data). */
  closeAll(closePrice: number, barIndex: number, closeTime: number): void {
    for (const [_coin, pos] of this.positions) {
      if (pos.remainingSizePct > 0) {
        pos.partialCloses.push({
          price: closePrice,
          sizePct: pos.remainingSizePct,
          bar: barIndex - pos.entryBarIndex,
          reason: 'end_of_data',
        })
        pos.remainingSizePct = 0
      }
      this.finalizePosition(pos, barIndex, closeTime, 'end_of_data')
    }
  }

  /** Close a specific coin position (invalidation). */
  closeByInvalidation(coin: string, closePrice: number, barIndex: number, closeTime: number): void {
    const pos = this.positions.get(coin)
    if (!pos) return
    if (pos.remainingSizePct > 0) {
      pos.partialCloses.push({
        price: closePrice,
        sizePct: pos.remainingSizePct,
        bar: barIndex - pos.entryBarIndex,
        reason: 'sl_hit',
      })
      pos.remainingSizePct = 0
    }
    this.finalizePosition(pos, barIndex, closeTime, 'invalidated')
  }

  hasPosition(coin: string): boolean { return this.positions.has(coin) }
  getEquity(): number { return this.equity }
  getTrades(): BacktestTrade[] { return this.trades }
  openPositionCount(): number { return this.positions.size }

  // ─── Private ────────────────────────────────────────────────────────────

  private isSLHit(pos: OpenPosition, candle: Candle): boolean {
    return pos.side === 'long'
      ? candle.l <= pos.currentSlPrice
      : candle.h >= pos.currentSlPrice
  }

  private isTPHit(pos: OpenPosition, candle: Candle, tpPrice: number): boolean {
    return pos.side === 'long'
      ? candle.h >= tpPrice
      : candle.l <= tpPrice
  }

  private isTrailHit(pos: OpenPosition, candle: Candle): boolean {
    return pos.side === 'long'
      ? candle.l <= pos.trailStopPrice
      : candle.h >= pos.trailStopPrice
  }

  private updateTrailing(pos: OpenPosition, candle: Candle): void {
    const risk = Math.abs(pos.entryPrice - pos.slPrice)
    const currentPnl = pos.side === 'long'
      ? candle.c - pos.entryPrice
      : pos.entryPrice - candle.c

    // Activation gate: must be TRAIL_ACTIVATION_R × risk in profit
    if (!pos.trailingActive && currentPnl >= risk * TRAIL_ACTIVATION_R) {
      pos.trailingActive = true
      pos.highWater = pos.side === 'long' ? candle.h : candle.l
      // Initial trail stop: lock in small profit (entry + 0.5R)
      const lockIn = risk * 0.5
      pos.trailStopPrice = pos.side === 'long'
        ? pos.entryPrice + lockIn
        : pos.entryPrice - lockIn
      return
    }

    if (!pos.trailingActive) return

    // Update high water mark
    if (pos.side === 'long' && candle.h > pos.highWater) {
      pos.highWater = candle.h
    }
    if (pos.side === 'short' && candle.l < pos.highWater) {
      pos.highWater = candle.l
    }

    // Compute new trailing stop: high water - ATR × multiplier
    const trailDist = pos.atrValue * pos.trailMultiplier
    const newStop = pos.side === 'long'
      ? pos.highWater - trailDist
      : pos.highWater + trailDist

    // Ratchet only — never loosen the stop
    if (pos.side === 'long' && newStop > pos.trailStopPrice) {
      pos.trailStopPrice = newStop
    }
    if (pos.side === 'short' && newStop < pos.trailStopPrice) {
      pos.trailStopPrice = newStop
    }
  }

  /**
   * Finalize a position: compute weighted average exit, PnL, record trade.
   */
  private finalizePosition(
    pos: OpenPosition,
    barIndex: number,
    exitTime: number,
    exitReason: BacktestTrade['exitReason'],
  ): void {
    if (!this.positions.has(pos.coin)) return  // already finalized

    // Weighted average exit price from all partial closes
    let weightedExit = 0
    let totalWeight = 0
    for (const pc of pos.partialCloses) {
      weightedExit += pc.price * pc.sizePct
      totalWeight += pc.sizePct
    }
    const avgExitPrice = totalWeight > 0 ? weightedExit / totalWeight : pos.entryPrice

    // Apply slippage on weighted exit
    const slippage = avgExitPrice * this.slippagePct
    const fillExitPrice = pos.side === 'long'
      ? avgExitPrice - slippage
      : avgExitPrice + slippage

    // PnL
    const priceChange = pos.side === 'long'
      ? fillExitPrice - pos.entryPrice
      : pos.entryPrice - fillExitPrice
    const rawPnl = (priceChange / pos.entryPrice) * pos.sizeUsd

    // Exit commission (on full size — conservative)
    const exitCost = pos.sizeUsd * this.commissionPct
    const pnl = rawPnl - exitCost

    this.equity += pnl

    this.trades.push({
      coin: pos.coin,
      interval: pos.interval,
      side: pos.side,
      patternType: pos.setup.type,
      confluenceGrade: pos.setup.confluenceGrade ?? null,
      entryPrice: pos.entryPrice,
      exitPrice: fillExitPrice,
      slPrice: pos.slPrice,
      tpPrice: pos.tp1Price,
      tp2Price: pos.tp2Price,
      sizeUsd: pos.sizeUsd,
      entryTime: pos.entryTime,
      exitTime,
      holdingBars: barIndex - pos.entryBarIndex,
      pnl,
      pnlPct: pos.sizeUsd > 0 ? pnl / pos.sizeUsd : 0,
      exitReason,
      partialCloses: pos.partialCloses.length > 0 ? [...pos.partialCloses] : undefined,
    })

    this.positions.delete(pos.coin)
  }
}
