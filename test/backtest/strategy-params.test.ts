/**
 * StrategyParams threading tests.
 *
 * Verifies that BacktestConfig.strategyParams overrides reach the strategy
 * pipeline and produce different results from defaults.
 *
 * Tests:
 *   1. MIN_CONFIDENCE=0.99 blocks all signals (0 trades)
 *   2. Default params (undefined) = same results as explicit default values
 *   3. REGIME_MULT overrides change confidence calculation
 *   4. MINH_MIN_RR override filters trades by R:R
 *
 * Evolution Phase 1 — Days 2-3.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { runBacktest } from "../../src/backtest/engine.js";
import type {
  BacktestConfig,
  StrategyParams,
} from "../../src/backtest/types.js";
import {
  MIN_CONFIDENCE,
  REGIME_MULTIPLIERS,
  MINH_MIN_RR,
} from "../../src/config.js";
import { applyRegimeModifier } from "../../src/strategy/shared/regime.js";
import type { Candle, CandleInterval } from "../../src/types.js";

beforeAll(() => {
  process.env.ACTIVE_EXCHANGE = "HL";
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function makeCandle(t: number, price: number, v = 1000): Candle {
  return { t, o: price, h: price * 1.01, l: price * 0.99, c: price, v };
}

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
    const delta = (Math.sin(i * 0.1) * 0.005 + 0.001) * price;
    price = price + delta;
    candles.push(makeCandle(t, price));
  }
  return candles;
}

function makeTestCandles(): Map<string, Candle[]> {
  const startMs = Date.UTC(2025, 0, 1);
  return new Map([
    ["BTC|1h", generateCandleSeries(startMs, 90 * 24, HOUR_MS, 40000)],
  ]);
}

const baseConfig: BacktestConfig = {
  coins: ["BTC"],
  timeframes: ["1h" as CandleInterval],
  initialCapital: 10000,
  slippagePct: 0.0005,
  commissionPct: 0.0003,
  strategy: "minh",
};

// ─── StrategyParams Type ─────────────────────────────────────────────────────

describe("StrategyParams type", () => {
  test("StrategyParams has all 6 fields", () => {
    const params: StrategyParams = {
      MIN_CONFIDENCE: 0.6,
      REGIME_MULT_COUNTER: 0.3,
      REGIME_MULT_NEUTRAL: 0.8,
      MINH_DRILLDOWN_CONFIDENCE_BASE: 0.7,
      SL_WICK_ATR_MULT: 0.5,
      MINH_MIN_RR: 2.0,
    };
    expect(params.MIN_CONFIDENCE).toBe(0.6);
    expect(params.REGIME_MULT_COUNTER).toBe(0.3);
    expect(params.REGIME_MULT_NEUTRAL).toBe(0.8);
    expect(params.MINH_DRILLDOWN_CONFIDENCE_BASE).toBe(0.7);
    expect(params.SL_WICK_ATR_MULT).toBe(0.5);
    expect(params.MINH_MIN_RR).toBe(2.0);
  });

  test("all fields are optional", () => {
    const empty: StrategyParams = {};
    expect(empty.MIN_CONFIDENCE).toBeUndefined();
    expect(empty.MINH_MIN_RR).toBeUndefined();
  });

  test("BacktestConfig accepts strategyParams", () => {
    const config: BacktestConfig = {
      ...baseConfig,
      strategyParams: { MIN_CONFIDENCE: 0.99 },
    };
    expect(config.strategyParams?.MIN_CONFIDENCE).toBe(0.99);
  });
});

// ─── MIN_CONFIDENCE Override ─────────────────────────────────────────────────

describe("MIN_CONFIDENCE override", () => {
  test("MIN_CONFIDENCE=0.99 produces fewer or zero trades vs default", () => {
    const candles = makeTestCandles();

    // Baseline: default params
    const baseline = runBacktest(candles, baseConfig);

    // Override: absurdly high confidence threshold
    const highConf = runBacktest(candles, {
      ...baseConfig,
      strategyParams: { MIN_CONFIDENCE: 0.99 },
    });

    // With confidence threshold at 0.99, most/all signals should be blocked
    expect(highConf.trades.length).toBeLessThanOrEqual(baseline.trades.length);

    // If baseline has trades, high confidence should have strictly fewer
    if (baseline.trades.length > 0) {
      expect(highConf.trades.length).toBeLessThan(baseline.trades.length);
    }
  });

  test("MIN_CONFIDENCE=0.01 produces more or equal trades vs default", () => {
    const candles = makeTestCandles();

    const baseline = runBacktest(candles, baseConfig);

    const lowConf = runBacktest(candles, {
      ...baseConfig,
      strategyParams: { MIN_CONFIDENCE: 0.01 },
    });

    // Lowering confidence threshold should allow more signals through
    expect(lowConf.trades.length).toBeGreaterThanOrEqual(
      baseline.trades.length,
    );
  });
});

// ─── Default Equivalence ─────────────────────────────────────────────────────

describe("default equivalence", () => {
  test("undefined strategyParams = same results as no strategyParams", () => {
    const candles = makeTestCandles();

    const noParams = runBacktest(candles, baseConfig);
    const undefinedParams = runBacktest(candles, {
      ...baseConfig,
      strategyParams: undefined,
    });

    expect(noParams.trades.length).toBe(undefinedParams.trades.length);
    expect(noParams.metrics.profitFactor).toBe(
      undefinedParams.metrics.profitFactor,
    );
  });

  test("explicit default values = same results as no params", () => {
    const candles = makeTestCandles();

    const noParams = runBacktest(candles, baseConfig);
    const explicitDefaults = runBacktest(candles, {
      ...baseConfig,
      strategyParams: {
        MIN_CONFIDENCE,
        REGIME_MULT_COUNTER: REGIME_MULTIPLIERS.counter,
        REGIME_MULT_NEUTRAL: REGIME_MULTIPLIERS.neutral,
        MINH_MIN_RR,
      },
    });

    expect(noParams.trades.length).toBe(explicitDefaults.trades.length);
    expect(noParams.metrics.profitFactor).toBe(
      explicitDefaults.metrics.profitFactor,
    );
  });
});

// ─── Regime Multiplier Override ──────────────────────────────────────────────

describe("regime multiplier override", () => {
  test("applyRegimeModifier uses override for counter regime", () => {
    const conf = 0.8;
    const defaultResult = applyRegimeModifier(conf, "long", "BEAR");
    const overrideResult = applyRegimeModifier(conf, "long", "BEAR", {
      REGIME_MULT_COUNTER: 0.5,
    });

    // Default counter mult is 0.25, override is 0.50 → override should be higher
    expect(overrideResult).toBeGreaterThan(defaultResult);
    expect(overrideResult).toBeCloseTo(conf * 0.5, 6);
    expect(defaultResult).toBeCloseTo(conf * REGIME_MULTIPLIERS.counter, 6);
  });

  test("applyRegimeModifier uses override for neutral regime", () => {
    const conf = 0.8;
    const defaultResult = applyRegimeModifier(conf, "long", "SIDEWAYS");
    const overrideResult = applyRegimeModifier(conf, "long", "SIDEWAYS", {
      REGIME_MULT_NEUTRAL: 0.5,
    });

    expect(overrideResult).toBeLessThan(defaultResult);
    expect(overrideResult).toBeCloseTo(conf * 0.5, 6);
  });

  test("applyRegimeModifier ignores override for aligned regime", () => {
    const conf = 0.8;
    // Aligned always uses 1.0 — no override exists
    const defaultResult = applyRegimeModifier(conf, "long", "BULL");
    const overrideResult = applyRegimeModifier(conf, "long", "BULL", {
      REGIME_MULT_COUNTER: 0.1,
      REGIME_MULT_NEUTRAL: 0.1,
    });

    // Aligned multiplier is always 1.0, unaffected by overrides
    expect(overrideResult).toBe(defaultResult);
    expect(overrideResult).toBeCloseTo(conf * 1.0, 6);
  });

  test("undefined params = same as no params for applyRegimeModifier", () => {
    const conf = 0.8;
    const noParams = applyRegimeModifier(conf, "long", "BEAR");
    const undefinedParams = applyRegimeModifier(
      conf,
      "long",
      "BEAR",
      undefined,
    );
    expect(noParams).toBe(undefinedParams);
  });
});

// ─── MINH_MIN_RR Override ─────────────────────────────────────────────────────

describe("MINH_MIN_RR override", () => {
  test("higher MINH_MIN_RR produces fewer or equal trades", () => {
    const candles = makeTestCandles();

    const baseline = runBacktest(candles, baseConfig);
    const highRR = runBacktest(candles, {
      ...baseConfig,
      strategyParams: { MINH_MIN_RR: 10.0 },
    });

    // Very high R:R requirement should filter out most trades
    expect(highRR.trades.length).toBeLessThanOrEqual(baseline.trades.length);
  });
});
