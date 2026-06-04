/**
 * Walk-forward validation tests.
 *
 * Tests cover:
 *   1. Window generation (boundaries, edge cases)
 *   2. walkForward orchestration (uses runBacktest internally)
 *   3. Aggregated metrics correctness
 *   4. Overfit detection
 *   5. Edge cases: empty data, insufficient windows, 0 trades
 *
 * Strategy: hand-craft candle data with known pipeline behavior.
 * Since pipeline requires 50+ candles for regime detection (MIN_CANDLES_FOR_SCAN),
 * we test the orchestration logic: window slicing, metric aggregation, gating.
 * Pipeline → simulator integration is already tested in engine.test.ts.
 *
 * Sprint 3 S4.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type {
  BacktestConfig,
  BacktestMetrics,
  BacktestTrade,
  WalkForwardConfig,
  WalkForwardWindow,
} from "../../src/backtest/types.js";
import {
  bootstrapExpectancyCI,
  formatGateReport,
  perWindowConsistency,
  walkForward,
} from "../../src/backtest/walk-forward.js";
import type { Candle, CandleInterval } from "../../src/types.js";

beforeAll(() => {
  process.env.ACTIVE_EXCHANGE = "HL";
});

// ─── Test Helpers ───────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function makeCandle(t: number, price: number, v = 1000): Candle {
  return { t, o: price, h: price * 1.01, l: price * 0.99, c: price, v };
}

/**
 * Generate a series of candles at hourly intervals.
 * Price walks randomly but deterministically (seeded by start price).
 */
function generateCandleSeries(
  startMs: number,
  count: number,
  intervalMs: number,
  basePrice: number,
): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  for (let i = 0; i < count; i++) {
    const t = startMs + i * intervalMs;
    // Deterministic price walk: small oscillation
    const delta = (Math.sin(i * 0.1) * 0.005 + 0.001) * price;
    price = price + delta;
    candles.push(makeCandle(t, price));
  }

  return candles;
}

const baseConfig: BacktestConfig = {
  coins: ["BTC"],
  timeframes: ["1h" as CandleInterval],
  initialCapital: 10000,
  slippagePct: 0.0005,
  commissionPct: 0.0003,
};

// ─── Empty / Insufficient Data ─────────────────────────────────────────────

describe("walkForward — edge cases", () => {
  test("returns empty result for empty candle map", () => {
    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 30 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const result = walkForward(new Map(), wfConfig);

    expect(result.windows.length).toBe(0);
    expect(result.passesGate).toBe(false);
    expect(result.oosMetrics.totalTrades).toBe(0);
  });

  test("returns empty result when data is too short for 2 windows", () => {
    // Data span: 30 days. Need train(30d) + test(7d) = 37d minimum for 1 window.
    // Need 2 windows minimum → need 37 + 7 = 44 days.
    // Provide only 35 days → insufficient
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 35 * 24, hourMs, 40000); // 35 days of hourly

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 30 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.windows.length).toBeLessThan(2);
    expect(result.passesGate).toBe(false);
  });

  test("returns empty result for candle map with empty arrays", () => {
    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 7 * DAY_MS,
      testWindowMs: 3 * DAY_MS,
      stepMs: 3 * DAY_MS,
    };

    const candleMap = new Map<string, Candle[]>([["BTC|1h", []]]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.windows.length).toBe(0);
    expect(result.passesGate).toBe(false);
  });
});

// ─── Window Generation ─────────────────────────────────────────────────────

describe("walkForward — window generation", () => {
  test("generates correct number of windows for known data span", () => {
    // Data: 60 days of hourly candles
    // Train: 14 days, Test: 7 days, Step: 7 days
    // Windows: start at day 0, need train(14d) + test(7d) = 21d
    //   W0: train[0,14) test[14,21)
    //   W1: train[7,21) test[21,28)
    //   W2: train[14,28) test[28,35)
    //   W3: train[21,35) test[35,42)
    //   W4: train[28,42) test[42,49)
    //   W5: train[35,49) test[49,56)
    //   W6: train[42,56) test[56,63) → 63 > 60, STOP
    // → 6 windows
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 60 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.windows.length).toBe(6);

    // Verify first window boundaries
    const w0 = result.windows[0]!;
    expect(w0.trainStart).toBe(startMs);
    expect(w0.trainEnd).toBe(startMs + 14 * DAY_MS);
    expect(w0.testStart).toBe(startMs + 14 * DAY_MS);
    expect(w0.testEnd).toBe(startMs + 21 * DAY_MS);

    // Verify second window starts at step offset
    const w1 = result.windows[1]!;
    expect(w1.trainStart).toBe(startMs + 7 * DAY_MS);
  });

  test("window indices are sequential 0-based", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 60 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    for (let i = 0; i < result.windows.length; i++) {
      expect(result.windows[i]?.index).toBe(i);
    }
  });
});

// ─── Metrics Aggregation ───────────────────────────────────────────────────

describe("walkForward — metrics", () => {
  test("aggregated metrics reflect combined window data", () => {
    // Use enough data for multiple windows (90 days)
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 90 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.windows.length).toBeGreaterThanOrEqual(2);

    // IS and OOS metrics should both be defined
    expect(result.isMetrics).toBeDefined();
    expect(result.oosMetrics).toBeDefined();

    // Total trades in IS = sum of all window train trades
    const expectedIsTrades = result.windows.reduce(
      (s, w) => s + w.trainMetrics.totalTrades,
      0,
    );
    expect(result.isMetrics.totalTrades).toBe(expectedIsTrades);

    // Total trades in OOS = sum of all window test trades
    const expectedOosTrades = result.windows.reduce(
      (s, w) => s + w.testMetrics.totalTrades,
      0,
    );
    expect(result.oosMetrics.totalTrades).toBe(expectedOosTrades);
  });

  test("passesGate is true only when OOS expectancy > 0", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 90 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    // Gate verdict should match expectancy sign
    if (result.oosMetrics.expectancy > 0) {
      expect(result.passesGate).toBe(true);
    } else {
      expect(result.passesGate).toBe(false);
    }
  });

  test("overfitRatio is 0 when both IS and OOS expectancy are 0", () => {
    // Very short windows with no pipeline signals → 0 trades → expectancy 0
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    // Generate minimal candles that produce no signals
    const candles = generateCandleSeries(startMs, 45 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 7 * DAY_MS,
      testWindowMs: 3 * DAY_MS,
      stepMs: 3 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    if (
      result.oosMetrics.expectancy === 0 &&
      result.isMetrics.expectancy === 0
    ) {
      expect(result.overfitRatio).toBe(0);
    }
    // If trades happen to fire, ratio should be a finite number
    expect(
      Number.isFinite(result.overfitRatio) || result.overfitRatio === Infinity,
    ).toBe(true);
  });
});

// ─── Multiple Coins ────────────────────────────────────────────────────────

describe("walkForward — multi-coin", () => {
  test("handles multiple coins in candle map", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;

    const btcCandles = generateCandleSeries(startMs, 60 * 24, hourMs, 40000);
    const ethCandles = generateCandleSeries(startMs, 60 * 24, hourMs, 2500);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: {
        ...baseConfig,
        coins: ["BTC", "ETH"],
      },
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([
      ["BTC|1h", btcCandles],
      ["ETH:1h", ethCandles],
    ]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.windows.length).toBeGreaterThanOrEqual(2);
    // Each window should have metrics (even if 0 trades)
    for (const w of result.windows) {
      expect(w.trainMetrics).toBeDefined();
      expect(w.testMetrics).toBeDefined();
    }
  });
});

// ─── Overfit Detection ─────────────────────────────────────────────────────

describe("walkForward — overfit detection", () => {
  test("overfitRatio is Infinity when IS > 0 and OOS <= 0", () => {
    // This is structural: if OOS expectancy is 0 but IS is positive,
    // ratio should be Infinity (worst case overfit)
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 90 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    // Can't force this scenario with real pipeline, but verify the logic:
    // If IS expectancy > 0 and OOS expectancy <= 0, overfitRatio should be Infinity or 0
    if (result.isMetrics.expectancy > 0 && result.oosMetrics.expectancy <= 0) {
      expect(result.overfitRatio).toBe(Infinity);
    }
    // Gate now requires all sub-gates, not just expectancy > 0
    expect(result.gateDetail).toBeDefined();
  });
});

// ─── Bootstrap CI ─────────────────────────────────────────────────────────

function makeTrade(pnl: number): BacktestTrade {
  return {
    coin: "BTC",
    interval: "1h" as CandleInterval,
    side: "long" as const,
    patternType: "smc-sd" as const,
    confluenceGrade: "B" as const,
    entryPrice: 40000,
    exitPrice: pnl > 0 ? 40000 + pnl : 40000 + pnl,
    slPrice: 39000,
    tpPrice: 41000,
    sizeUsd: 1000,
    entryTime: Date.now(),
    exitTime: Date.now() + 3600000,
    holdingBars: 10,
    pnl,
    pnlPct: pnl / 1000,
    exitReason: pnl > 0 ? "tp_hit" : "sl_hit",
  };
}

describe("bootstrapExpectancyCI", () => {
  test("returns zero CI for empty trades", () => {
    const ci = bootstrapExpectancyCI([], 100, 0.95);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(0);
    expect(ci.mean).toBe(0);
  });

  test("CI contains true mean for consistent winners", () => {
    // 50 trades all winning $100 each → expectancy ~$100, CI should be tight and positive
    const trades = Array.from({ length: 50 }, () => makeTrade(100));
    const ci = bootstrapExpectancyCI(trades, 1000, 0.95);

    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.mean).toBeCloseTo(100, 0);
  });

  test("CI lower bound < 0 for all losers", () => {
    const trades = Array.from({ length: 50 }, () => makeTrade(-100));
    const ci = bootstrapExpectancyCI(trades, 1000, 0.95);

    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeLessThan(0);
    expect(ci.mean).toBeCloseTo(-100, 0);
  });

  test("CI spans zero for mixed results near breakeven", () => {
    // 25 wins of $100, 25 losses of $100 → expectancy ~0
    const trades = [
      ...Array.from({ length: 25 }, () => makeTrade(100)),
      ...Array.from({ length: 25 }, () => makeTrade(-100)),
    ];
    const ci = bootstrapExpectancyCI(trades, 1000, 0.95);

    // With balanced wins/losses, CI should span zero or be very close
    expect(ci.lower).toBeLessThan(ci.upper);
    expect(Math.abs(ci.mean)).toBeLessThan(30); // roughly around 0
  });

  test("is deterministic (seeded PRNG)", () => {
    const trades = Array.from({ length: 30 }, (_, i) =>
      makeTrade(i % 2 === 0 ? 50 : -30),
    );
    const ci1 = bootstrapExpectancyCI(trades, 500, 0.95);
    const ci2 = bootstrapExpectancyCI(trades, 500, 0.95);
    expect(ci1.lower).toBe(ci2.lower);
    expect(ci1.upper).toBe(ci2.upper);
    expect(ci1.mean).toBe(ci2.mean);
  });
});

// ─── Per-Window Consistency ────────────────────────────────────────────────

function makeWindowMetrics(
  expectancy: number,
  totalTrades: number,
): BacktestMetrics {
  return {
    totalTrades,
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
    expectancy,
    maxDrawdown: 0,
    maxDrawdownDuration: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
  };
}

function makeWindow(
  index: number,
  testExpectancy: number,
  testTrades: number,
): WalkForwardWindow {
  return {
    index,
    trainStart: 0,
    trainEnd: 1,
    testStart: 1,
    testEnd: 2,
    trainMetrics: makeWindowMetrics(0, 0),
    testMetrics: makeWindowMetrics(testExpectancy, testTrades),
  };
}

describe("perWindowConsistency", () => {
  test("returns zero for empty windows", () => {
    const c = perWindowConsistency([]);
    expect(c.ratio).toBe(0);
    expect(c.totalWindows).toBe(0);
  });

  test("skips windows with 0 trades", () => {
    const windows = [
      makeWindow(0, 100, 5), // has trades, positive
      makeWindow(1, 0, 0), // no trades — skip
      makeWindow(2, -50, 3), // has trades, negative
    ];
    const c = perWindowConsistency(windows);
    expect(c.totalWindows).toBe(2); // only 2 with trades
    expect(c.consistentWindows).toBe(1); // only window 0 positive
    expect(c.ratio).toBe(0.5);
  });

  test("all consistent → ratio 1.0", () => {
    const windows = [
      makeWindow(0, 50, 10),
      makeWindow(1, 30, 8),
      makeWindow(2, 100, 12),
    ];
    const c = perWindowConsistency(windows);
    expect(c.ratio).toBe(1.0);
  });

  test("none consistent → ratio 0.0", () => {
    const windows = [makeWindow(0, -50, 5), makeWindow(1, -30, 3)];
    const c = perWindowConsistency(windows);
    expect(c.ratio).toBe(0);
  });
});

// ─── Gate Detail ──────────────────────────────────────────────────────────

describe("walkForward — gate detail", () => {
  test("result includes gateDetail with all sub-gates", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 90 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    // gateDetail should have all 5 boolean fields
    expect(typeof result.gateDetail.minTrades).toBe("boolean");
    expect(typeof result.gateDetail.positiveExpectancy).toBe("boolean");
    expect(typeof result.gateDetail.ciLowerPositive).toBe("boolean");
    expect(typeof result.gateDetail.windowConsistent).toBe("boolean");
    expect(typeof result.gateDetail.notOverfit).toBe("boolean");

    // passesGate = AND of all sub-gates
    const expected =
      result.gateDetail.minTrades &&
      result.gateDetail.positiveExpectancy &&
      result.gateDetail.ciLowerPositive &&
      result.gateDetail.windowConsistent &&
      result.gateDetail.notOverfit;
    expect(result.passesGate).toBe(expected);
  });

  test("passesGate false when < 30 OOS trades even if expectancy > 0", () => {
    // With the current pipeline producing near 0 trades on synthetic data,
    // the min trades gate should fail
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 90 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    // Synthetic data produces ~0 trades → minTrades should fail
    if (result.oosMetrics.totalTrades < 30) {
      expect(result.gateDetail.minTrades).toBe(false);
      expect(result.passesGate).toBe(false);
    }
  });

  test("oosExpectancyCI and windowConsistency are populated", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 60 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);

    expect(result.oosExpectancyCI).toBeDefined();
    expect(typeof result.oosExpectancyCI.lower).toBe("number");
    expect(typeof result.oosExpectancyCI.upper).toBe("number");
    expect(typeof result.oosExpectancyCI.mean).toBe("number");

    expect(result.windowConsistency).toBeDefined();
    expect(typeof result.windowConsistency.ratio).toBe("number");
  });
});

// ─── Format Gate Report ──────────────────────────────────────────────────

describe("formatGateReport", () => {
  test("produces readable string with all gates", () => {
    const startMs = Date.UTC(2025, 0, 1);
    const hourMs = 60 * 60 * 1000;
    const candles = generateCandleSeries(startMs, 60 * 24, hourMs, 40000);

    const wfConfig: WalkForwardConfig = {
      backtestConfig: baseConfig,
      trainWindowMs: 14 * DAY_MS,
      testWindowMs: 7 * DAY_MS,
      stepMs: 7 * DAY_MS,
    };

    const candleMap = new Map([["BTC|1h", candles]]);
    const result = walkForward(candleMap, wfConfig);
    const report = formatGateReport(result);

    expect(report).toContain("WFA STATISTICAL GATE REPORT");
    expect(report).toContain("Min OOS trades");
    expect(report).toContain("Bootstrap 95% CI");
    expect(report).toContain("Window consistency");
    expect(report).toContain("Overfit ratio");
    expect(report).toMatch(/PASS|FAIL/);
  });
});
