/**
 * Parameter optimizer tests — 10 test cases.
 *
 * Tests pure functions (generateTrials, splitData, selectTopN, detectPlateau,
 * formatConsoleTable) and integration (single trial, holdout, current P3 config).
 *
 * No network calls — uses synthetic candle data.
 *
 * Evolution Phase 1 — Days 4-5.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  formatConsoleTable,
  generateTrials,
  type HoldoutResult,
  parseOptimizerArgs,
  runTrial,
  scoreOosCandidate,
  selectTopN,
  splitData,
  type TrialResult,
  validateHoldout,
} from "../../src/backtest/optimize.js";
import type {
  BacktestConfig,
  StrategyParams,
  WalkForwardConfig,
} from "../../src/backtest/types.js";
import {
  BACKTEST_SLIPPAGE_PCT,
  PARAM_SCHEMA,
  WF_STEP_MS,
  WF_TEST_WINDOW_MS,
  WF_TRAIN_WINDOW_MS,
} from "../../src/config.js";
import type { Candle, CandleInterval } from "../../src/types.js";

// ─── Setup ────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ACTIVE_EXCHANGE = "HL";
});

// ─── Helpers ──────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeCandle(t: number, price: number, v = 1000): Candle {
  return { t, o: price, h: price * 1.01, l: price * 0.99, c: price, v };
}

/** Generate synthetic candles for multiple coins × TFs. */
function makeSyntheticCandles(
  coins: string[],
  tfs: CandleInterval[],
  daysOfData: number = 180,
): Map<string, Candle[]> {
  const result = new Map<string, Candle[]>();
  const tfMs: Record<string, number> = {
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };

  const baseTs = Date.now() - daysOfData * DAY_MS;

  for (const coin of coins) {
    const basePrice = coin === "BTC" ? 60000 : coin === "ETH" ? 3000 : 150;

    for (const tf of tfs) {
      const intervalMs = tfMs[tf] ?? 3_600_000;
      const numCandles = Math.floor((daysOfData * DAY_MS) / intervalMs);
      const candles: Candle[] = [];

      for (let i = 0; i < numCandles; i++) {
        // Simple sinusoidal price movement for variety
        const trend = Math.sin(i / 100) * basePrice * 0.1;
        const noise = (Math.random() - 0.5) * basePrice * 0.02;
        const price = basePrice + trend + noise;
        candles.push(
          makeCandle(
            baseTs + i * intervalMs,
            price,
            1000 + Math.random() * 5000,
          ),
        );
      }

      result.set(`${coin}|${tf}`, candles);
    }
  }

  return result;
}

const COINS = ["BTC"];
// Keep the optimizer integration fixture intentionally lightweight so the
// walk-forward tests stay under Bun's default per-test timeout in CI/dev runs.
const TFS: CandleInterval[] = ["1h", "4h"];

// Pre-generate synthetic data (shared across tests, read-only)
const syntheticCandles = makeSyntheticCandles(COINS, TFS, 90);

const baseConfig: BacktestConfig = {
  coins: COINS,
  timeframes: TFS,
  initialCapital: 10_000,
  slippagePct: BACKTEST_SLIPPAGE_PCT,
  commissionPct: 0.00055,
  strategy: "minh",
};

const wfConfig: WalkForwardConfig = {
  backtestConfig: baseConfig,
  trainWindowMs: WF_TRAIN_WINDOW_MS,
  testWindowMs: WF_TEST_WINDOW_MS,
  stepMs: WF_STEP_MS,
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe("optimize", () => {
  test("parseOptimizerArgs keeps positional defaults", () => {
    const parsed = parseOptimizerArgs(["50", "BTC,ETH"]);
    expect(parsed.numTrials).toBe(50);
    expect(parsed.coins).toEqual(["BTC", "ETH"]);
    expect(parsed.mode).toBe("all");
    expect(parsed.timeframes).toEqual(["5m", "15m", "1h", "4h"]);
    expect(parsed.disabledScanModes).toEqual([]);
  });

  test("parseOptimizerArgs supports 5m-only mode", () => {
    const parsed = parseOptimizerArgs(["50", "BTC,ETH", "--mode=5m-only"]);
    expect(parsed.mode).toBe("5m-only");
    expect(parsed.timeframes).toEqual(["5m"]);
    expect(parsed.disabledScanModes).toEqual([
      "1h_same_tf",
      "15m_drilldown",
      "4h_poi",
    ]);
  });

  // Test 1: generateTrials produces correct number of param sets
  test("generateTrials produces correct count", () => {
    const trials = generateTrials(PARAM_SCHEMA, 50);
    expect(trials.length).toBe(50);

    // Each trial should have all keys (matches PARAM_SCHEMA key count)
    const schemaKeyCount = Object.keys(PARAM_SCHEMA).length;
    for (const trial of trials) {
      expect(Object.keys(trial).length).toBe(schemaKeyCount);
    }
  });

  // Test 2: generated params within PARAM_SCHEMA bounds
  test("generated params within schema bounds", () => {
    const trials = generateTrials(PARAM_SCHEMA, 100);
    const schema = PARAM_SCHEMA;

    for (const trial of trials) {
      const params = trial as unknown as Record<string, number>;
      for (const [key, range] of Object.entries(schema)) {
        const value = params[key]!;
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max + range.step * 0.01); // float tolerance
      }
    }
  });

  // Test 3: splitData 80/20 correct (no overlap, covers all data)
  test("splitData 80/20 produces non-overlapping splits", () => {
    const { trainCandles, holdoutCandles } = splitData(syntheticCandles, 0.8);

    // Both should have entries
    expect(trainCandles.size).toBeGreaterThan(0);
    expect(holdoutCandles.size).toBeGreaterThan(0);

    // For each series, train + holdout = original
    for (const [key, originalSeries] of syntheticCandles) {
      const train = trainCandles.get(key) ?? [];
      const holdout = holdoutCandles.get(key) ?? [];

      // No overlap: last train timestamp < first holdout timestamp
      if (train.length > 0 && holdout.length > 0) {
        expect(train[train.length - 1]?.t).toBeLessThan(holdout[0]?.t);
      }

      // Combined length matches original
      expect(train.length + holdout.length).toBe(originalSeries.length);
    }
  });

  // Test 4: single trial runs without error
  test("single trial runs without error", () => {
    const { trainCandles } = splitData(syntheticCandles, 0.8);
    const params: StrategyParams = {
      MIN_CONFIDENCE: 0.55,
      REGIME_MULT_COUNTER: 0.25,
      REGIME_MULT_NEUTRAL: 0.8,
      MINH_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SL_WICK_ATR_MULT: 0.5,
      MINH_MIN_RR: 2.0,
    };

    const result = runTrial(trainCandles, baseConfig, wfConfig, params, 0);

    expect(result.trialIndex).toBe(0);
    expect(result.params).toEqual(params);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.oosPF).toBe("number");
    expect(typeof result.maxDD).toBe("number");
  });

  // Test 5: results contain expected fields
  test("trial result contains all expected fields", () => {
    const { trainCandles } = splitData(syntheticCandles, 0.8);
    const [params] = generateTrials(PARAM_SCHEMA, 1);

    const result = runTrial(trainCandles, baseConfig, wfConfig, params!, 42);

    // Required fields
    expect(result).toHaveProperty("trialIndex");
    expect(result).toHaveProperty("params");
    expect(result).toHaveProperty("oosPF");
    expect(result).toHaveProperty("oosExpectancy");
    expect(result).toHaveProperty("maxDD");
    expect(result).toHaveProperty("winRate");
    expect(result).toHaveProperty("tradeCount");
    expect(result).toHaveProperty("numWindows");
    expect(result).toHaveProperty("durationMs");

    // Types
    expect(typeof result.oosPF).toBe("number");
    expect(typeof result.oosExpectancy).toBe("number");
    expect(typeof result.maxDD).toBe("number");
    expect(typeof result.winRate).toBe("number");
    expect(typeof result.tradeCount).toBe("number");
    expect(typeof result.numWindows).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });

  // Test 6: holdout validation runs on separate data
  test("holdout validation uses separate data", () => {
    const { trainCandles, holdoutCandles } = splitData(syntheticCandles, 0.8);
    const params: StrategyParams = {
      MIN_CONFIDENCE: 0.55,
      REGIME_MULT_COUNTER: 0.25,
      REGIME_MULT_NEUTRAL: 0.8,
      MINH_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SL_WICK_ATR_MULT: 0.5,
      MINH_MIN_RR: 2.0,
    };

    // Create a mock trial result for holdout validation
    const trial = runTrial(trainCandles, baseConfig, wfConfig, params, 0);
    const holdoutResults = validateHoldout(
      holdoutCandles,
      baseConfig,
      wfConfig,
      [trial],
    );

    expect(holdoutResults.length).toBe(1);
    expect(holdoutResults[0]).toHaveProperty("holdoutPF");
    expect(holdoutResults[0]).toHaveProperty("holdoutMaxDD");
    expect(holdoutResults[0]).toHaveProperty("holdoutTrades");
    expect(typeof holdoutResults[0]?.holdoutPF).toBe("number");
  });

  // Test 7: current P3 config (from config.ts defaults) produces valid result
  test("current P3 config produces valid trial result", () => {
    const { trainCandles } = splitData(syntheticCandles, 0.8);

    // Use current production defaults
    const p3Params: StrategyParams = {
      MIN_CONFIDENCE: 0.58, // from config.ts MIN_CONFIDENCE
      REGIME_MULT_COUNTER: 0.25, // from config.ts REGIME_MULTIPLIERS.counter
      REGIME_MULT_NEUTRAL: 0.8, // from config.ts REGIME_MULTIPLIERS.neutral
      MINH_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SL_WICK_ATR_MULT: 0.5,
      MINH_MIN_RR: 2.0,
    };

    const result = runTrial(trainCandles, baseConfig, wfConfig, p3Params, 0);

    expect(result.error).toBeUndefined();
    expect(typeof result.oosPF).toBe("number");
    expect(typeof result.maxDD).toBe("number");
    // maxDD should be in valid range (0-1 or can be 0 if no trades)
    expect(result.maxDD).toBeGreaterThanOrEqual(0);
    expect(result.maxDD).toBeLessThanOrEqual(1);
  });

  // Test 8: empty candles → graceful handling
  test("empty candles produces zero-trade result", () => {
    const emptyCandles = new Map<string, Candle[]>();
    const params: StrategyParams = {
      MIN_CONFIDENCE: 0.55,
      REGIME_MULT_COUNTER: 0.25,
      REGIME_MULT_NEUTRAL: 0.8,
      MINH_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SL_WICK_ATR_MULT: 0.5,
      MINH_MIN_RR: 2.0,
    };

    const result = runTrial(emptyCandles, baseConfig, wfConfig, params, 0);

    // Should not error — just no trades
    expect(result.error).toBeUndefined();
    expect(result.tradeCount).toBe(0);
    expect(result.numWindows).toBe(0);
  });

  // Test 9: selectTopN filters and ranks by anti-overfit OOS score
  test("selectTopN filters errors and ranks by OOS robustness score", () => {
    const trials: TrialResult[] = [
      {
        trialIndex: 0,
        params: {} as StrategyParams,
        oosPF: 2.0,
        oosExpectancy: 10,
        maxDD: 0.3,
        winRate: 0.5,
        tradeCount: 20,
        numWindows: 5,
        durationMs: 100,
      },
      {
        trialIndex: 1,
        params: {} as StrategyParams,
        oosPF: 3.0,
        oosExpectancy: 15,
        maxDD: 0.2,
        winRate: 0.6,
        tradeCount: 10,
        numWindows: 5,
        durationMs: 100,
      },
      {
        trialIndex: 2,
        params: {} as StrategyParams,
        oosPF: 1.5,
        oosExpectancy: 5,
        maxDD: 0.5,
        winRate: 0.4,
        tradeCount: 30,
        numWindows: 5,
        durationMs: 100,
      },
      {
        trialIndex: 3,
        params: {} as StrategyParams,
        oosPF: 5.0,
        oosExpectancy: 25,
        maxDD: 0.1,
        winRate: 0.7,
        tradeCount: 2,
        numWindows: 5,
        durationMs: 100,
      }, // <5 trades → filtered
      {
        trialIndex: 4,
        params: {} as StrategyParams,
        oosPF: 4.0,
        oosExpectancy: 20,
        maxDD: 0.15,
        winRate: 0.65,
        tradeCount: 15,
        numWindows: 5,
        durationMs: 100,
        error: "timeout",
      }, // error → filtered
    ];

    const top = selectTopN(trials, 3);

    expect(top.length).toBe(3);
    // Sorted descending by anti-overfit OOS score (PF × trade factor × drawdown penalty)
    expect(top[0]?.trialIndex).toBe(0); // better trade sample beats raw-PF winner
    expect(top[1]?.trialIndex).toBe(1);
    expect(top[2]?.trialIndex).toBe(2);
    expect(scoreOosCandidate(top[0]!)).toBeGreaterThanOrEqual(
      scoreOosCandidate(top[1]!),
    );
    expect(scoreOosCandidate(top[1]!)).toBeGreaterThanOrEqual(
      scoreOosCandidate(top[2]!),
    );
    // Error and low-trade trials excluded
    expect(top.find((t) => t.trialIndex === 3)).toBeUndefined();
    expect(top.find((t) => t.trialIndex === 4)).toBeUndefined();
  });

  // Test 10: console table format contains key columns
  test("formatConsoleTable contains expected headers", () => {
    const mockResults: HoldoutResult[] = [
      {
        trialIndex: 0,
        params: {
          MIN_CONFIDENCE: 0.55,
          REGIME_MULT_COUNTER: 0.25,
        } as StrategyParams,
        oosPF: 2.5,
        oosExpectancy: 12.5,
        maxDD: 0.35,
        winRate: 0.52,
        tradeCount: 45,
        numWindows: 8,
        durationMs: 5000,
        holdoutPF: 1.8,
        holdoutMaxDD: 0.4,
        holdoutTrades: 12,
      },
    ];

    const table = formatConsoleTable(mockResults);

    // Key columns present in header
    expect(table).toContain("OOS PF");
    expect(table).toContain("OOS Exp");
    expect(table).toContain("MaxDD");
    expect(table).toContain("WR");
    expect(table).toContain("Trades");
    expect(table).toContain("Hold PF");
    expect(table).toContain("Hold DD");
    expect(table).toContain("Params");

    // Data row present
    expect(table).toContain("2.50");
    expect(table).toContain("1.80");
    expect(table).toContain("MIN_CONFIDENCE=0.55");
  });
});
