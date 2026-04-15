/**
 * Paper P&L Tracker — simulated balance for PAPER_TRADE mode.
 *
 * One canonical {@link PaperTracker} for the whole runtime.
 * Balance starts at {@link getPaperInitialBalance}.
 *
 * Enhanced with multi-TP exit system (P2 upgrade):
 *   - 3-tier partial close: TP1 (35%) → TP2 (25%) → TP3 trailing (40%)
 *   - SL moves to breakeven after TP1
 *   - ATR-based trailing stop per timeframe
 *   - MAX_HOLDING_BARS time-based force-close
 *   - Correlation guard via shouldBlockCorrelatedEntry()
 *
 * Logic mirrors backtest TradeSimulator.checkBar() exactly.
 *
 * Access: `getPaperTracker()` — returns the shared tracker.
 */

import type { Candle, CandleInterval } from '../types.js'
import {
  CANONICAL_STRATEGY_ID,
  PAPER_DEFAULT_BALANCE,
  PAPER_SLIPPAGE_PCT,
  getPaperInitialBalance,
  MULTI_TP_SPLIT,
  TRAIL_ACTIVATION_R,
  MAX_HOLDING_BARS,
  TIMEFRAME_MS,
} from '../config.js'
import { shouldBlockCorrelatedEntry, type CorrelationCheckResult } from './correlation-guard.js'
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
  exitReason?: string
  partialCloses?: PaperPartialClose[]
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

/** Paper wallet summary (TUI / metrics). */
export interface PaperWalletSummary {
  label: string
  balance: number
  tradeCount: number
  wins: number
  losses: number
  winRate: number
}

// ─── Enhanced Position Types ────────────────────────────────────────────────

export type PaperExitReason = 'tp1_zone' | 'tp2_swing' | 'tp3_trail' | 'sl_hit' | 'be_hit' | 'max_hold'

export interface PaperPartialClose {
  price: number
  sizePct: number
  reason: PaperExitReason
  closedAt: number
}

export interface PaperEntryParams {
  orderId: string
  coin: string
  side: 'long' | 'short'
  entryPrice: number
  size: number            // in coins
  interval: CandleInterval
  slPrice: number
  tp1Price: number
  tp2Price: number
  atrValue: number
  trailMultiplier: number
}

interface EnhancedOpenPosition {
  orderId: string
  coin: string
  side: 'long' | 'short'
  interval: CandleInterval
  entryPrice: number
  size: number            // in coins
  sizeUsd: number         // entryPrice × size
  slPrice: number         // original SL
  currentSlPrice: number  // may move to breakeven after TP1
  tp1Price: number        // zone-based TP
  tp2Price: number        // swing-based TP
  remainingSizePct: number // 1.0 → decreases on partial close
  tp1Hit: boolean
  tp2Hit: boolean
  partialCloses: PaperPartialClose[]
  // Trailing stop state
  trailingActive: boolean
  highWater: number
  trailStopPrice: number
  atrValue: number
  trailMultiplier: number
  entryTime: number       // ms timestamp
}

export interface PaperCheckResult {
  action: 'partial_close' | 'full_close' | 'hold'
  exitReason?: string
  closePrice?: number
  pnl?: number
}

// ─── PaperTracker Class ─────────────────────────────────────────────────────

export class PaperTracker {
  private balance: number
  private openPositions: Map<string, OpenPosition> = new Map()
  private enhancedPositions: Map<string, EnhancedOpenPosition> = new Map()
  private closedTrades: PaperTrade[] = []
  private equityCurve: EquityPoint[] = []

  constructor(initialBalance: number = PAPER_DEFAULT_BALANCE) {
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

  /** Get count of open positions (legacy + enhanced). */
  getOpenCount(): number {
    return this.openPositions.size + this.enhancedPositions.size
  }

  /** Check if coin has an enhanced (multi-TP) position open. */
  hasEnhancedPosition(coin: string): boolean {
    for (const pos of this.enhancedPositions.values()) {
      if (pos.coin === coin) return true
    }
    return false
  }

  /** Check correlation guard before entry. */
  canEnter(coin: string): CorrelationCheckResult {
    const openCoins: string[] = []
    for (const pos of this.openPositions.values()) openCoins.push(pos.coin)
    for (const pos of this.enhancedPositions.values()) openCoins.push(pos.coin)
    return shouldBlockCorrelatedEntry(coin, openCoins)
  }

  // ─── Legacy API (backward compat) ──────────────────────────────────────

  /**
   * Record a paper entry fill (legacy — single-price exit).
   * Called by OrderManager when paper order fills.
   */
  recordEntry(orderId: string, coin: string, side: 'long' | 'short', entryPrice: number, size: number): void {
    this.openPositions.set(orderId, {
      orderId, coin, side, entryPrice, size,
      openedAt: Date.now(),
    })
    log.info('paper', `Entry: ${coin} ${side} ${size.toFixed(4)} @ ${entryPrice.toFixed(2)} | balance=${this.balance.toFixed(2)}`)
  }

  /**
   * Record a paper exit and compute P&L (legacy — single-price).
   * Returns null if orderId not found.
   */
  recordExit(orderId: string, closePrice: number): PaperTrade | null {
    const pos = this.openPositions.get(orderId)
    if (!pos) {
      log.warn('paper', `Exit for unknown orderId=${orderId} — already closed or never tracked`)
      return null
    }

    const direction = pos.side === 'long' ? 1 : -1
    const pnl = (closePrice - pos.entryPrice) * pos.size * direction

    const trade: PaperTrade = {
      orderId: pos.orderId, coin: pos.coin, side: pos.side,
      entryPrice: pos.entryPrice, closePrice, size: pos.size, pnl,
      openedAt: pos.openedAt, closedAt: Date.now(),
    }

    this.balance += pnl
    this.closedTrades.push(trade)
    this.equityCurve.push({ ts: trade.closedAt, balance: this.balance })
    this.openPositions.delete(orderId)

    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
    log.info('paper', `Exit: ${pos.coin} ${pos.side} @ ${closePrice.toFixed(2)} | P&L=${pnlStr} | balance=${this.balance.toFixed(2)}`)
    return trade
  }

  // ─── Enhanced Multi-TP API ────────────────────────────────────────────

  /**
   * Record an enhanced entry with multi-TP tracking.
   * Called by OrderManager paper fill path with full signal data.
   */
  recordEntryEnhanced(params: PaperEntryParams): void {
    const pos: EnhancedOpenPosition = {
      orderId: params.orderId,
      coin: params.coin,
      side: params.side,
      interval: params.interval,
      entryPrice: params.entryPrice,
      size: params.size,
      sizeUsd: params.entryPrice * params.size,
      slPrice: params.slPrice,
      currentSlPrice: params.slPrice,
      tp1Price: params.tp1Price,
      tp2Price: params.tp2Price,
      remainingSizePct: 1.0,
      tp1Hit: false,
      tp2Hit: false,
      partialCloses: [],
      trailingActive: false,
      highWater: params.entryPrice,
      trailStopPrice: params.slPrice,
      atrValue: params.atrValue,
      trailMultiplier: params.trailMultiplier,
      entryTime: Date.now(),
    }

    this.enhancedPositions.set(params.orderId, pos)
    // Also register in legacy map for backward compat (getOpenCount, etc.)
    this.openPositions.set(params.orderId, {
      orderId: params.orderId, coin: params.coin, side: params.side,
      entryPrice: params.entryPrice, size: params.size, openedAt: pos.entryTime,
    })

    const slPct = (Math.abs(params.entryPrice - params.slPrice) / params.entryPrice * 100).toFixed(2)
    const tpPct = (Math.abs(params.tp1Price - params.entryPrice) / params.entryPrice * 100).toFixed(2)
    log.info('paper', `Enhanced Entry: ${params.coin} ${params.side} ${params.size.toFixed(4)} @ ${params.entryPrice.toFixed(2)} | SL:${slPct}% TP:${tpPct}% | ATR:${params.atrValue.toFixed(2)} | balance=${this.balance.toFixed(2)}`)
  }

  /**
   * Evaluate enhanced positions against a candle — mirrors backtest checkBar().
   * Called on every candle tick from orchestrator.
   * Only processes positions matching this coin.
   */
  checkCandle(coin: string, interval: CandleInterval, candle: Candle): PaperCheckResult | null {
    // Find enhanced position for this coin (any orderId)
    let pos: EnhancedOpenPosition | null = null
    for (const p of this.enhancedPositions.values()) {
      if (p.coin === coin) { pos = p; break }
    }
    if (!pos) return null

    const now = candle.t

    // ── 0. Max holding period (time-based) ──
    const maxBars = MAX_HOLDING_BARS[pos.interval] ?? 72
    const tfMs = TIMEFRAME_MS[pos.interval] ?? 3_600_000
    const elapsedMs = now - pos.entryTime
    if (elapsedMs >= maxBars * tfMs) {
      pos.partialCloses.push({
        price: candle.c, sizePct: pos.remainingSizePct,
        reason: 'max_hold', closedAt: now,
      })
      pos.remainingSizePct = 0
      return this.finalizeEnhanced(pos, now, 'max_hold')
    }

    // ── 1. SL check ──
    if (this.isSLHit(pos, candle)) {
      const reason: PaperExitReason = pos.tp1Hit ? 'be_hit' : 'sl_hit'
      pos.partialCloses.push({
        price: pos.currentSlPrice, sizePct: pos.remainingSizePct,
        reason, closedAt: now,
      })
      pos.remainingSizePct = 0
      return this.finalizeEnhanced(pos, now, pos.tp1Hit ? 'be_hit' : 'sl_hit')
    }

    // ── 2. TP1 (35% partial close at zone target) ──
    let hadPartial = false
    if (!pos.tp1Hit && this.isTPHit(pos, candle, pos.tp1Price)) {
      pos.tp1Hit = true
      const closePct = MULTI_TP_SPLIT[0]
      pos.partialCloses.push({
        price: pos.tp1Price, sizePct: closePct,
        reason: 'tp1_zone', closedAt: now,
      })
      pos.remainingSizePct -= closePct
      hadPartial = true

      // Move SL to breakeven
      const buffer = pos.entryPrice * 0.001
      pos.currentSlPrice = pos.side === 'long'
        ? pos.entryPrice + buffer
        : pos.entryPrice - buffer

      log.info('paper', `TP1 hit: ${pos.coin} ${pos.side} — ${(closePct * 100).toFixed(0)}% closed @ ${pos.tp1Price.toFixed(4)} | SL→BE`)
    }

    // ── 3. TP2 (25% partial close at swing target) ──
    if (pos.tp1Hit && !pos.tp2Hit && this.isTPHit(pos, candle, pos.tp2Price)) {
      pos.tp2Hit = true
      const closePct = MULTI_TP_SPLIT[1]
      pos.partialCloses.push({
        price: pos.tp2Price, sizePct: closePct,
        reason: 'tp2_swing', closedAt: now,
      })
      pos.remainingSizePct -= closePct
      hadPartial = true

      log.info('paper', `TP2 hit: ${pos.coin} ${pos.side} — ${(closePct * 100).toFixed(0)}% closed @ ${pos.tp2Price.toFixed(4)}`)
    }

    // ── 4. Trailing stop update + check (remaining 40%) ──
    if (pos.tp1Hit && pos.remainingSizePct > 0) {
      this.updateTrailing(pos, candle)

      if (pos.trailingActive && this.isTrailHit(pos, candle)) {
        pos.partialCloses.push({
          price: pos.trailStopPrice, sizePct: pos.remainingSizePct,
          reason: 'tp3_trail', closedAt: now,
        })
        pos.remainingSizePct = 0

        log.info('paper', `Trail stop hit: ${pos.coin} ${pos.side} — remainder closed @ ${pos.trailStopPrice.toFixed(4)}`)
        return this.finalizeEnhanced(pos, now, 'tp3_trail')
      }
    }

    // ── 5. All portions closed? ──
    if (pos.remainingSizePct <= 0.001) {
      return this.finalizeEnhanced(pos, now, 'tp_hit')
    }

    return hadPartial ? { action: 'partial_close' } : { action: 'hold' }
  }

  // ─── Private: Exit Helpers (ported from backtest simulator) ────────────

  private isSLHit(pos: EnhancedOpenPosition, candle: Candle): boolean {
    return pos.side === 'long'
      ? candle.l <= pos.currentSlPrice
      : candle.h >= pos.currentSlPrice
  }

  private isTPHit(pos: EnhancedOpenPosition, candle: Candle, tpPrice: number): boolean {
    return pos.side === 'long'
      ? candle.h >= tpPrice
      : candle.l <= tpPrice
  }

  private isTrailHit(pos: EnhancedOpenPosition, candle: Candle): boolean {
    return pos.side === 'long'
      ? candle.l <= pos.trailStopPrice
      : candle.h >= pos.trailStopPrice
  }

  private updateTrailing(pos: EnhancedOpenPosition, candle: Candle): void {
    const risk = Math.abs(pos.entryPrice - pos.slPrice)
    const currentPnl = pos.side === 'long'
      ? candle.c - pos.entryPrice
      : pos.entryPrice - candle.c

    // Activation gate: must be TRAIL_ACTIVATION_R × risk in profit
    if (!pos.trailingActive && currentPnl >= risk * TRAIL_ACTIVATION_R) {
      pos.trailingActive = true
      pos.highWater = pos.side === 'long' ? candle.h : candle.l
      const lockIn = risk * 0.5
      pos.trailStopPrice = pos.side === 'long'
        ? pos.entryPrice + lockIn
        : pos.entryPrice - lockIn
      return
    }

    if (!pos.trailingActive) return

    // Update high water mark
    if (pos.side === 'long' && candle.h > pos.highWater) pos.highWater = candle.h
    if (pos.side === 'short' && candle.l < pos.highWater) pos.highWater = candle.l

    // Compute trailing stop: high water ± ATR × multiplier
    const trailDist = pos.atrValue * pos.trailMultiplier
    const newStop = pos.side === 'long'
      ? pos.highWater - trailDist
      : pos.highWater + trailDist

    // Ratchet only — never loosen
    if (pos.side === 'long' && newStop > pos.trailStopPrice) pos.trailStopPrice = newStop
    if (pos.side === 'short' && newStop < pos.trailStopPrice) pos.trailStopPrice = newStop
  }

  /**
   * Finalize an enhanced position: weighted avg exit, PnL, record trade.
   */
  private finalizeEnhanced(pos: EnhancedOpenPosition, exitTime: number, exitReason: string): PaperCheckResult {
    // Weighted average exit price from all partial closes
    let weightedExit = 0
    let totalWeight = 0
    for (const pc of pos.partialCloses) {
      weightedExit += pc.price * pc.sizePct
      totalWeight += pc.sizePct
    }
    const avgExitPrice = totalWeight > 0 ? weightedExit / totalWeight : pos.entryPrice

    // Apply slippage
    const slippage = avgExitPrice * PAPER_SLIPPAGE_PCT
    const fillExitPrice = pos.side === 'long'
      ? avgExitPrice - slippage
      : avgExitPrice + slippage

    // PnL
    const priceChange = pos.side === 'long'
      ? fillExitPrice - pos.entryPrice
      : pos.entryPrice - fillExitPrice
    const pnl = (priceChange / pos.entryPrice) * pos.sizeUsd

    this.balance += pnl

    const trade: PaperTrade = {
      orderId: pos.orderId, coin: pos.coin, side: pos.side,
      entryPrice: pos.entryPrice, closePrice: fillExitPrice,
      size: pos.size, pnl,
      openedAt: pos.entryTime, closedAt: exitTime,
      exitReason,
      partialCloses: [...pos.partialCloses],
    }

    this.closedTrades.push(trade)
    this.equityCurve.push({ ts: exitTime, balance: this.balance })
    this.enhancedPositions.delete(pos.orderId)
    this.openPositions.delete(pos.orderId)

    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
    const partials = pos.partialCloses.map(pc => pc.reason).join('→')
    log.info('paper', `Exit: ${pos.coin} ${pos.side} | ${exitReason} (${partials}) | P&L=${pnlStr} | balance=${this.balance.toFixed(2)}`)

    return { action: 'full_close', exitReason, closePrice: fillExitPrice, pnl }
  }

  /** Reset all state (for tests). */
  reset(initialBalance: number = PAPER_DEFAULT_BALANCE): void {
    this.balance = initialBalance
    this.openPositions.clear()
    this.enhancedPositions.clear()
    this.closedTrades = []
    this.equityCurve = [{ ts: Date.now(), balance: this.balance }]
  }
}

let tracker: PaperTracker | null = null

/** Get the shared paper P&L tracker. */
export function getPaperTracker(): PaperTracker {
  if (tracker == null) {
    tracker = new PaperTracker(getPaperInitialBalance())
  }
  return tracker
}

/** Ensure the shared paper wallet exists before UI/metrics access. */
export function ensurePaperWalletsInitialized(): void {
  getPaperTracker()
}

/** Single-wallet summary for TUI and metrics. */
export function getPaperWalletSummaries(): PaperWalletSummary[] {
  const pt = getPaperTracker()
  const trades = pt.getTrades()
  const wins = trades.filter(t => t.pnl > 0).length
  const losses = trades.filter(t => t.pnl <= 0).length
  const total = trades.length
  return [{
    label: CANONICAL_STRATEGY_ID,
    balance: pt.getBalance(),
    tradeCount: total,
    wins,
    losses,
    winRate: total > 0 ? wins / total : 0,
  }]
}

/** Sum of balances across known paper wallets. */
export function getTotalPaperBalance(): number {
  return getPaperWalletSummaries().reduce((s, w) => s + w.balance, 0)
}

/** Reset all paper trackers (tests only). */
export function resetPaperTracker(): void {
  tracker = null
}
