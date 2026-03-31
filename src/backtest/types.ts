/**
 * Backtest type definitions — config, results, metrics, trades.
 *
 * All types are pure data — no I/O, no side effects.
 * Used by engine.ts, simulator.ts, metrics.ts.
 */

import type { CandleInterval, PatternType, ConfluenceGrade, SignalSide } from '../types.js'
import type { PipelineStats } from '../scanner/pipeline.js'

// ─── Config ─────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  /** Coins to replay. */
  coins: string[]
  /** Timeframes to replay (pipeline scans each). */
  timeframes: CandleInterval[]
  /** Initial account capital (USD). */
  initialCapital: number
  /** Slippage as fraction (0.0005 = 0.05%). Applied to fills. */
  slippagePct: number
  /** Commission as fraction per trade (0.0003 = 0.03%). Applied to entry + exit. */
  commissionPct: number
}

// ─── Partial Close Detail ──────────────────────────────────────────────────

export interface PartialCloseDetail {
  price: number
  sizePct: number    // fraction of original size (e.g. 0.4, 0.3, 0.3)
  bar: number        // bar index relative to entry
  reason: 'tp1_zone' | 'tp2_swing' | 'tp3_trail' | 'sl_hit' | 'be_hit' | 'end_of_data'
}

// ─── Trade Record ───────────────────────────────────────────────────────────

export interface BacktestTrade {
  coin: string
  interval: CandleInterval
  side: SignalSide
  patternType: PatternType
  confluenceGrade: ConfluenceGrade | null

  entryPrice: number
  exitPrice: number       // weighted average across all partial closes
  slPrice: number
  tpPrice: number         // TP1 (zone-based)
  tp2Price?: number       // TP2 (swing-based)
  sizeUsd: number

  entryTime: number   // ms timestamp
  exitTime: number    // ms timestamp
  holdingBars: number

  pnl: number         // realized PnL after slippage + commission
  pnlPct: number      // PnL as fraction of entry notional
  exitReason: 'sl_hit' | 'tp_hit' | 'trail_stop' | 'invalidated' | 'end_of_data'

  /** Partial close breakdown (empty for single-exit trades). */
  partialCloses?: PartialCloseDetail[]
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export interface BacktestMetrics {
  totalTrades: number
  wins: number
  losses: number
  winRate: number             // 0–1

  grossProfit: number
  grossLoss: number
  netPnl: number
  profitFactor: number        // grossProfit / |grossLoss|  (Infinity if no losses)

  avgWin: number
  avgLoss: number
  avgPnl: number
  avgRR: number               // avg realized R:R
  avgHoldingBars: number

  expectancy: number          // (winRate × avgWin) - (lossRate × avgLoss)

  maxDrawdown: number         // peak-to-trough fraction (0–1)
  maxDrawdownDuration: number // bars in drawdown

  sharpeRatio: number         // annualized (daily returns, 365 trading days)
  sortinoRatio: number        // downside-only volatility

  calmarRatio: number         // annual return / max drawdown
}

// ─── Equity Point ───────────────────────────────────────────────────────────

export interface EquityPoint {
  ts: number      // ms timestamp
  equity: number  // account value at this point
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface BacktestResult {
  config: BacktestConfig
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: EquityPoint[]
  /** Pipeline diagnostic stats from this backtest run. */
  pipelineStats?: PipelineStats
}

// ─── Walk-Forward ──────────────────────────────────────────────────────────

export interface WalkForwardConfig {
  /** Base backtest config (coins, timeframes, capital, etc.). */
  backtestConfig: BacktestConfig
  /** Training window size in milliseconds. */
  trainWindowMs: number
  /** Test (out-of-sample) window size in milliseconds. */
  testWindowMs: number
  /** Step size in milliseconds (how far to advance each window). */
  stepMs: number
}

/** A single train+test window result. */
export interface WalkForwardWindow {
  /** 0-based window index. */
  index: number
  /** Training period start (ms timestamp). */
  trainStart: number
  /** Training period end (ms timestamp). */
  trainEnd: number
  /** Test period start (ms timestamp). */
  testStart: number
  /** Test period end (ms timestamp). */
  testEnd: number
  /** Metrics from training period. */
  trainMetrics: BacktestMetrics
  /** Metrics from test (out-of-sample) period. */
  testMetrics: BacktestMetrics
}

export interface WalkForwardResult {
  /** All window results. */
  windows: WalkForwardWindow[]
  /** Aggregated OOS (out-of-sample) metrics across all test windows. */
  oosMetrics: BacktestMetrics
  /** Aggregated in-sample metrics across all training windows. */
  isMetrics: BacktestMetrics
  /** Overfitting ratio: IS expectancy / OOS expectancy. >2 = flag. */
  overfitRatio: number
  /** Whether strategy passes minimum viability (OOS expectancy > 0). */
  passesGate: boolean
}
