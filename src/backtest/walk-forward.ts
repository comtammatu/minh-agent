/**
 * Walk-forward validation — split data into rolling train+test windows,
 * run independent backtests, aggregate out-of-sample metrics.
 *
 * Purpose: detect overfitting. If in-sample >> out-of-sample, strategy
 * is curve-fitted to historical noise, not real edge.
 *
 * Pure orchestrator — calls runBacktest() per window, ZERO duplicate logic.
 * No I/O: candle data passed in, results returned.
 *
 * Sprint 3 S4.
 */

import {
  WF_BOOTSTRAP_ITERATIONS,
  WF_CONFIDENCE_LEVEL,
  WF_MIN_OOS_TRADES,
  WF_MIN_WINDOW_CONSISTENCY,
  WF_MIN_WINDOWS,
  WF_OVERFIT_THRESHOLD,
} from "../config.js";
import type { Candle } from "../types.js";
import { runBacktest } from "./engine.js";
import type {
  BacktestMetrics,
  BacktestTrade,
  ExpectancyCI,
  GateDetail,
  WalkForwardConfig,
  WalkForwardResult,
  WalkForwardWindow,
  WindowConsistency,
} from "./types.js";

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run walk-forward validation on historical candle data.
 *
 * @param candles   - Map of "COIN:INTERVAL" → sorted Candle[] (ascending by t)
 * @param wfConfig  - Walk-forward configuration (window sizes, step)
 * @returns WalkForwardResult with per-window + aggregated metrics
 */
export function walkForward(
  candles: Map<string, Candle[]>,
  wfConfig: WalkForwardConfig,
): WalkForwardResult {
  const { backtestConfig, trainWindowMs, testWindowMs, stepMs } = wfConfig;

  // Determine data time range from candles
  const { minTs, maxTs } = getDataRange(candles);
  if (minTs === Infinity || maxTs === -Infinity) {
    return emptyResult();
  }

  // Generate window boundaries
  const windowDefs = generateWindows(
    minTs,
    maxTs,
    trainWindowMs,
    testWindowMs,
    stepMs,
  );

  if (windowDefs.length < WF_MIN_WINDOWS) {
    return emptyResult();
  }

  // Run backtest for each window
  const windows: WalkForwardWindow[] = [];

  for (let i = 0; i < windowDefs.length; i++) {
    const def = windowDefs[i]!;

    // Slice candles for train period
    const trainCandles = sliceCandles(candles, def.trainStart, def.trainEnd);
    const trainResult = runBacktest(trainCandles, backtestConfig);

    // Slice candles for test period
    const testCandles = sliceCandles(candles, def.testStart, def.testEnd);
    const testResult = runBacktest(testCandles, backtestConfig);

    windows.push({
      index: i,
      trainStart: def.trainStart,
      trainEnd: def.trainEnd,
      testStart: def.testStart,
      testEnd: def.testEnd,
      trainMetrics: trainResult.metrics,
      testMetrics: testResult.metrics,
      testTrades: testResult.trades,
    });
  }

  // Aggregate metrics across all windows
  const isMetrics = aggregateMetrics(
    windows.map((w) => w.trainMetrics),
    backtestConfig.initialCapital,
  );
  const oosMetrics = aggregateMetrics(
    windows.map((w) => w.testMetrics),
    backtestConfig.initialCapital,
  );

  // Overfit detection
  const overfitRatio =
    oosMetrics.expectancy > 0
      ? isMetrics.expectancy / oosMetrics.expectancy
      : isMetrics.expectancy > 0
        ? Infinity
        : 0;

  // Collect all OOS trades for bootstrap CI (reads from saved testTrades)
  const oosTrades = collectOOSTrades(windows);
  const oosExpectancyCI = bootstrapExpectancyCI(
    oosTrades,
    WF_BOOTSTRAP_ITERATIONS,
    WF_CONFIDENCE_LEVEL,
  );
  const windowConsistency = perWindowConsistency(windows);

  // Statistical gate: ALL sub-gates must pass
  const gateDetail: GateDetail = {
    minTrades: oosMetrics.totalTrades >= WF_MIN_OOS_TRADES,
    positiveExpectancy: oosMetrics.expectancy > 0,
    ciLowerPositive: oosExpectancyCI.lower > 0,
    windowConsistent: windowConsistency.ratio >= WF_MIN_WINDOW_CONSISTENCY,
    notOverfit: overfitRatio <= WF_OVERFIT_THRESHOLD,
  };

  const passesGate =
    gateDetail.minTrades &&
    gateDetail.positiveExpectancy &&
    gateDetail.ciLowerPositive &&
    gateDetail.windowConsistent &&
    gateDetail.notOverfit;

  return {
    windows,
    oosMetrics,
    isMetrics,
    overfitRatio,
    passesGate,
    oosExpectancyCI,
    windowConsistency,
    gateDetail,
  };
}

// ─── Internal ──────────────────────────────────────────────────────────────

interface WindowDef {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

/** Find min/max timestamps across all candle series. */
function getDataRange(candles: Map<string, Candle[]>): {
  minTs: number;
  maxTs: number;
} {
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const [_key, series] of candles) {
    if (series.length === 0) continue;
    const first = series[0]?.t;
    const last = series[series.length - 1]?.t;
    if (first < minTs) minTs = first;
    if (last > maxTs) maxTs = last;
  }

  return { minTs, maxTs };
}

/**
 * Generate rolling train+test window definitions.
 * Each window: [trainStart, trainEnd] → [testStart, testEnd]
 * testStart = trainEnd, testEnd = testStart + testWindowMs
 * Next window starts at previous trainStart + stepMs.
 */
function generateWindows(
  dataStart: number,
  dataEnd: number,
  trainWindowMs: number,
  testWindowMs: number,
  stepMs: number,
): WindowDef[] {
  const windows: WindowDef[] = [];
  let trainStart = dataStart;

  while (true) {
    const trainEnd = trainStart + trainWindowMs;
    const testStart = trainEnd;
    const testEnd = testStart + testWindowMs;

    // Test window must fit within data range
    if (testEnd > dataEnd) break;

    windows.push({ trainStart, trainEnd, testStart, testEnd });
    trainStart += stepMs;
  }

  return windows;
}

/** Slice candle map to only include candles within [startMs, endMs). */
function sliceCandles(
  candles: Map<string, Candle[]>,
  startMs: number,
  endMs: number,
): Map<string, Candle[]> {
  const sliced = new Map<string, Candle[]>();

  for (const [key, series] of candles) {
    const filtered = series.filter((c) => c.t >= startMs && c.t < endMs);
    if (filtered.length > 0) {
      sliced.set(key, filtered);
    }
  }

  return sliced;
}

/**
 * Aggregate metrics from multiple windows using weighted average.
 * Weights by totalTrades (windows with more trades contribute more).
 */
function aggregateMetrics(
  metricsList: BacktestMetrics[],
  _initialCapital: number,
): BacktestMetrics {
  const nonEmpty = metricsList.filter((m) => m.totalTrades > 0);
  if (nonEmpty.length === 0) return zeroMetrics();

  const totalTrades = nonEmpty.reduce((s, m) => s + m.totalTrades, 0);
  const totalWins = nonEmpty.reduce((s, m) => s + m.wins, 0);
  const totalLosses = nonEmpty.reduce((s, m) => s + m.losses, 0);

  const grossProfit = nonEmpty.reduce((s, m) => s + m.grossProfit, 0);
  const grossLoss = nonEmpty.reduce((s, m) => s + m.grossLoss, 0);
  const netPnl = grossProfit + grossLoss;

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const profitFactor =
    grossLoss === 0
      ? grossProfit > 0
        ? Infinity
        : 0
      : grossProfit / Math.abs(grossLoss);

  const avgWin = totalWins > 0 ? grossProfit / totalWins : 0;
  const avgLoss = totalLosses > 0 ? Math.abs(grossLoss) / totalLosses : 0;
  const avgPnl = totalTrades > 0 ? netPnl / totalTrades : 0;

  const avgRR = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  const totalHoldingBars = nonEmpty.reduce(
    (s, m) => s + m.avgHoldingBars * m.totalTrades,
    0,
  );
  const avgHoldingBars = totalTrades > 0 ? totalHoldingBars / totalTrades : 0;

  const lossRate = 1 - winRate;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  // For aggregated drawdown/sharpe/sortino/calmar — use trade-weighted average
  const wAvg = (field: keyof BacktestMetrics) =>
    weightedAverage(nonEmpty, field);

  return {
    totalTrades,
    wins: totalWins,
    losses: totalLosses,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor,
    avgWin,
    avgLoss,
    avgPnl,
    avgRR,
    avgHoldingBars,
    expectancy,
    maxDrawdown: wAvg("maxDrawdown"),
    maxDrawdownDuration: Math.round(wAvg("maxDrawdownDuration")),
    sharpeRatio: wAvg("sharpeRatio"),
    sortinoRatio: wAvg("sortinoRatio"),
    calmarRatio: wAvg("calmarRatio"),
  };
}

/** Trade-weighted average of a metric field across windows. */
function weightedAverage(
  metricsList: BacktestMetrics[],
  field: keyof BacktestMetrics,
): number {
  const totalTrades = metricsList.reduce((s, m) => s + m.totalTrades, 0);
  if (totalTrades === 0) return 0;

  let weighted = 0;
  for (const m of metricsList) {
    const val = m[field];
    if (typeof val === "number" && Number.isFinite(val)) {
      weighted += val * m.totalTrades;
    }
  }

  return weighted / totalTrades;
}

function zeroMetrics(): BacktestMetrics {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    netPnl: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    avgPnl: 0,
    avgRR: 0,
    avgHoldingBars: 0,
    expectancy: 0,
    maxDrawdown: 0,
    maxDrawdownDuration: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
  };
}

function emptyResult(): WalkForwardResult {
  return {
    windows: [],
    oosMetrics: zeroMetrics(),
    isMetrics: zeroMetrics(),
    overfitRatio: 0,
    passesGate: false,
    oosExpectancyCI: { lower: 0, upper: 0, mean: 0 },
    windowConsistency: { consistentWindows: 0, totalWindows: 0, ratio: 0 },
    gateDetail: {
      minTrades: false,
      positiveExpectancy: false,
      ciLowerPositive: false,
      windowConsistent: false,
      notOverfit: false,
    },
  };
}

// ─── Statistical Validation ────────────────────────────────────────────────

/**
 * Bootstrap resampling to estimate confidence interval for expectancy.
 *
 * Method: sample N trades with replacement × iterations,
 * compute expectancy per sample, sort, take percentile bounds.
 *
 * Uses seeded PRNG for deterministic results in tests.
 */
export function bootstrapExpectancyCI(
  trades: BacktestTrade[],
  iterations: number = WF_BOOTSTRAP_ITERATIONS,
  confidenceLevel: number = WF_CONFIDENCE_LEVEL,
): ExpectancyCI {
  if (trades.length === 0) {
    return { lower: 0, upper: 0, mean: 0 };
  }

  const n = trades.length;
  const expectancies: number[] = [];

  // Simple seeded LCG for reproducibility
  let seed = 42;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let iter = 0; iter < iterations; iter++) {
    // Resample with replacement
    let _totalPnl = 0;
    let wins = 0;
    let winPnl = 0;
    let lossPnl = 0;

    for (let i = 0; i < n; i++) {
      const idx = Math.floor(nextRandom() * n);
      const trade = trades[idx]!;
      _totalPnl += trade.pnl;
      if (trade.pnl > 0) {
        wins++;
        winPnl += trade.pnl;
      } else {
        lossPnl += Math.abs(trade.pnl);
      }
    }

    const winRate = wins / n;
    const lossRate = 1 - winRate;
    const avgWin = wins > 0 ? winPnl / wins : 0;
    const avgLoss = n - wins > 0 ? lossPnl / (n - wins) : 0;
    const expectancy = winRate * avgWin - lossRate * avgLoss;
    expectancies.push(expectancy);
  }

  expectancies.sort((a, b) => a - b);

  const alpha = 1 - confidenceLevel;
  const lowerIdx = Math.floor((alpha / 2) * iterations);
  const upperIdx = Math.floor((1 - alpha / 2) * iterations);
  const mean = expectancies.reduce((s, e) => s + e, 0) / iterations;

  return {
    lower: expectancies[lowerIdx] ?? 0,
    upper: expectancies[Math.min(upperIdx, iterations - 1)] ?? 0,
    mean,
  };
}

/**
 * Check per-window OOS consistency.
 * Returns fraction of OOS windows (with at least 1 trade) that have positive expectancy.
 */
export function perWindowConsistency(
  windows: WalkForwardWindow[],
): WindowConsistency {
  const windowsWithTrades = windows.filter(
    (w) => w.testMetrics.totalTrades > 0,
  );
  if (windowsWithTrades.length === 0) {
    return { consistentWindows: 0, totalWindows: 0, ratio: 0 };
  }

  const consistent = windowsWithTrades.filter(
    (w) => w.testMetrics.expectancy > 0,
  ).length;

  return {
    consistentWindows: consistent,
    totalWindows: windowsWithTrades.length,
    ratio: consistent / windowsWithTrades.length,
  };
}

/**
 * Collect all OOS trades across windows from saved testTrades.
 * Reads from WalkForwardWindow.testTrades (populated during the main loop)
 * to avoid re-running backtest per window.
 */
function collectOOSTrades(windows: WalkForwardWindow[]): BacktestTrade[] {
  const allTrades: BacktestTrade[] = [];

  for (const w of windows) {
    if (w.testTrades) {
      allTrades.push(...w.testTrades);
    }
  }

  return allTrades;
}

/**
 * Format a human-readable gate report for console or API output.
 */
export function formatGateReport(result: WalkForwardResult): string {
  const {
    gateDetail,
    oosMetrics,
    oosExpectancyCI,
    windowConsistency,
    overfitRatio,
  } = result;
  const pass = (b: boolean) => (b ? "PASS" : "FAIL");

  const lines = [
    "=== WFA STATISTICAL GATE REPORT ===",
    `Overall: ${result.passesGate ? "PASS" : "FAIL"}`,
    "",
    `[${pass(gateDetail.minTrades)}] Min OOS trades: ${oosMetrics.totalTrades} (need >= ${WF_MIN_OOS_TRADES})`,
    `[${pass(gateDetail.positiveExpectancy)}] OOS expectancy: $${oosMetrics.expectancy.toFixed(2)} (need > 0)`,
    `[${pass(gateDetail.ciLowerPositive)}] Bootstrap 95% CI: [$${oosExpectancyCI.lower.toFixed(2)}, $${oosExpectancyCI.upper.toFixed(2)}] mean=$${oosExpectancyCI.mean.toFixed(2)} (need lower > 0)`,
    `[${pass(gateDetail.windowConsistent)}] Window consistency: ${windowConsistency.consistentWindows}/${windowConsistency.totalWindows} (${(windowConsistency.ratio * 100).toFixed(0)}%, need >= ${WF_MIN_WINDOW_CONSISTENCY * 100}%)`,
    `[${pass(gateDetail.notOverfit)}] Overfit ratio: ${Number.isFinite(overfitRatio) ? overfitRatio.toFixed(2) : "∞"} (need <= ${WF_OVERFIT_THRESHOLD})`,
    "===================================",
  ];
  return lines.join("\n");
}
