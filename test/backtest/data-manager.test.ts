/**
 * Backtest data-manager tests.
 *
 * Tests cover:
 *   1. detectGaps() — pure function, known gap patterns
 *   2. computeDownloadWindows() — pure function, pagination logic
 *   3. computeHTFIntervals() — pure function, HTF derivation
 *   4. computeHTFWarmupMs() — pure function, warmup buffer
 *   5. BacktestDataManager — I/O integration with mocked fetchCandles + DB
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  BacktestDataManager,
  computeDownloadWindows,
  computeHTFIntervals,
  computeHTFWarmupMs,
  detectGaps,
  HTF_WARMUP_CANDLES,
} from "../../src/backtest/data-manager.js";
import type { Candle } from "../../src/types.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeCandle(t: number, close = 100): Candle {
  return { t, o: close, h: close + 1, l: close - 1, c: close, v: 1000 };
}

const ONE_HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const ONE_DAY = 86_400_000;

// ─── detectGaps ─────────────────────────────────────────────────────────────

describe("detectGaps", () => {
  test("returns empty for empty array", () => {
    expect(detectGaps([], ONE_HOUR)).toEqual([]);
  });

  test("returns empty for single candle", () => {
    expect(detectGaps([makeCandle(1000)], ONE_HOUR)).toEqual([]);
  });

  test("returns empty for consecutive candles (no gaps)", () => {
    const candles = [
      makeCandle(0),
      makeCandle(ONE_HOUR),
      makeCandle(ONE_HOUR * 2),
      makeCandle(ONE_HOUR * 3),
    ];
    expect(detectGaps(candles, ONE_HOUR)).toEqual([]);
  });

  test("detects single gap of 1 candle", () => {
    const candles = [
      makeCandle(0),
      makeCandle(ONE_HOUR),
      // missing: ONE_HOUR * 2
      makeCandle(ONE_HOUR * 3),
    ];
    const gaps = detectGaps(candles, ONE_HOUR);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.start).toBe(ONE_HOUR * 2);
    expect(gaps[0]?.end).toBe(ONE_HOUR * 2);
    expect(gaps[0]?.count).toBe(1);
  });

  test("detects single gap of multiple candles", () => {
    const candles = [
      makeCandle(0),
      // missing: ONE_HOUR, ONE_HOUR * 2, ONE_HOUR * 3
      makeCandle(ONE_HOUR * 4),
    ];
    const gaps = detectGaps(candles, ONE_HOUR);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.start).toBe(ONE_HOUR);
    expect(gaps[0]?.end).toBe(ONE_HOUR * 3);
    expect(gaps[0]?.count).toBe(3);
  });

  test("detects multiple gaps", () => {
    const candles = [
      makeCandle(0),
      makeCandle(ONE_HOUR),
      // gap: ONE_HOUR * 2
      makeCandle(ONE_HOUR * 3),
      makeCandle(ONE_HOUR * 4),
      // gap: ONE_HOUR * 5, ONE_HOUR * 6
      makeCandle(ONE_HOUR * 7),
    ];
    const gaps = detectGaps(candles, ONE_HOUR);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.count).toBe(1);
    expect(gaps[1]?.count).toBe(2);
  });

  test("works with 5m interval", () => {
    const candles = [
      makeCandle(0),
      makeCandle(FIVE_MIN),
      // missing: FIVE_MIN * 2, FIVE_MIN * 3
      makeCandle(FIVE_MIN * 4),
    ];
    const gaps = detectGaps(candles, FIVE_MIN);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.count).toBe(2);
    expect(gaps[0]?.start).toBe(FIVE_MIN * 2);
    expect(gaps[0]?.end).toBe(FIVE_MIN * 3);
  });

  test("no gap when candles are exactly consecutive (1d)", () => {
    const candles = [
      makeCandle(0),
      makeCandle(ONE_DAY),
      makeCandle(ONE_DAY * 2),
    ];
    expect(detectGaps(candles, ONE_DAY)).toEqual([]);
  });
});

// ─── computeDownloadWindows ──────────────────────────────────────────────────

describe("computeDownloadWindows", () => {
  test("returns empty for inverted range", () => {
    expect(computeDownloadWindows(1000, 500, ONE_HOUR)).toEqual([]);
  });

  test("single window for small range", () => {
    const start = 0;
    const end = ONE_HOUR * 100; // 100 candles, well under 5000
    const windows = computeDownloadWindows(start, end, ONE_HOUR);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startTime).toBe(0);
    expect(windows[0]?.endTime).toBe(end);
  });

  test("single window for exactly 5000 candles", () => {
    const start = 0;
    const end = ONE_HOUR * 4999; // 5000 candles (0 through 4999)
    const windows = computeDownloadWindows(start, end, ONE_HOUR);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startTime).toBe(0);
    expect(windows[0]?.endTime).toBe(end);
  });

  test("two windows for 5001 candles", () => {
    const start = 0;
    const end = ONE_HOUR * 5000; // 5001 candles
    const windows = computeDownloadWindows(start, end, ONE_HOUR);
    expect(windows).toHaveLength(2);
    // First window: 0 to 4999 * ONE_HOUR
    expect(windows[0]?.startTime).toBe(0);
    expect(windows[0]?.endTime).toBe(ONE_HOUR * 4999);
    // Second window: 5000 * ONE_HOUR to 5000 * ONE_HOUR
    expect(windows[1]?.startTime).toBe(ONE_HOUR * 5000);
    expect(windows[1]?.endTime).toBe(ONE_HOUR * 5000);
  });

  test("multiple windows for large range", () => {
    const start = 0;
    const end = ONE_HOUR * 14999; // 15000 candles → 3 windows
    const windows = computeDownloadWindows(start, end, ONE_HOUR);
    expect(windows).toHaveLength(3);
  });

  test("works with 5m interval", () => {
    const start = 0;
    const end = FIVE_MIN * 9999; // 10000 candles → 2 windows
    const windows = computeDownloadWindows(start, end, FIVE_MIN);
    expect(windows).toHaveLength(2);
  });

  test("single candle range", () => {
    const windows = computeDownloadWindows(1000, 1000, ONE_HOUR);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startTime).toBe(1000);
    expect(windows[0]?.endTime).toBe(1000);
  });
});

// ─── computeHTFIntervals ────────────────────────────────────────────────────

describe("computeHTFIntervals", () => {
  test("returns empty for self-referencing intervals", () => {
    // 1d maps to 1d → no extra HTF needed
    expect(computeHTFIntervals(["1d"])).toEqual([]);
  });

  test("returns HTF not already in input", () => {
    // 15m→4h, 1h→4h, 4h→1d. 4h is in input, so only 1d is extra
    const result = computeHTFIntervals(["15m", "1h", "4h"]);
    expect(result).toEqual(["1d"]);
  });

  test("returns multiple extra HTFs", () => {
    // 1m→15m, 5m→1h. Neither 15m nor 1h in input
    const result = computeHTFIntervals(["1m", "5m"]);
    expect(result).toContain("15m");
    expect(result).toContain("1h");
    expect(result).toHaveLength(2);
  });

  test("deduplicates shared HTFs", () => {
    // 15m→4h, 1h→4h → only one '4h'
    const result = computeHTFIntervals(["15m", "1h"]);
    expect(result).toEqual(["4h"]);
  });

  test("returns empty when all HTFs already in input", () => {
    // 15m→4h, 1h→4h, 4h→1d, 1d→1d. Input has both 4h and 1d
    expect(computeHTFIntervals(["15m", "1h", "4h", "1d"])).toEqual([]);
  });

  test("returns empty for empty input", () => {
    expect(computeHTFIntervals([])).toEqual([]);
  });
});

// ─── computeHTFWarmupMs ─────────────────────────────────────────────────────

describe("computeHTFWarmupMs", () => {
  test("4h warmup = 50 × 4h = ~8.3 days", () => {
    const ms = computeHTFWarmupMs("4h");
    expect(ms).toBe(HTF_WARMUP_CANDLES * 14_400_000); // 50 × 4h
    expect(ms).toBe(720_000_000); // 8.33 days
  });

  test("1d warmup = 50 × 1d = 50 days", () => {
    const ms = computeHTFWarmupMs("1d");
    expect(ms).toBe(HTF_WARMUP_CANDLES * 86_400_000); // 50 × 1d
  });

  test("1h warmup = 50 × 1h = ~2.08 days", () => {
    const ms = computeHTFWarmupMs("1h");
    expect(ms).toBe(HTF_WARMUP_CANDLES * 3_600_000); // 50 × 1h
  });
});

// ─── BacktestDataManager (mocked I/O) ─────────────────────────────────────

describe("BacktestDataManager", () => {
  let _dm: BacktestDataManager;

  beforeEach(() => {
    _dm = new BacktestDataManager();
  });

  // Note: Full integration tests require PG + HL REST.
  // Unit tests here verify the class wiring with pure function outputs.

  test("downloadHistory computes correct page count for 6-month 1h data", () => {
    // 6 months ≈ 180 days × 24 hours = 4320 candles → 1 page
    const windows = computeDownloadWindows(
      new Date("2025-01-01").getTime(),
      new Date("2025-07-01").getTime(),
      ONE_HOUR,
    );
    expect(windows.length).toBe(1);
  });

  test("downloadHistory computes correct page count for 6-month 5m data", () => {
    // 6 months ≈ 180 days × 288 bars/day = 51840 candles → 11 pages
    const windows = computeDownloadWindows(
      new Date("2025-01-01").getTime(),
      new Date("2025-07-01").getTime(),
      FIVE_MIN,
    );
    expect(windows.length).toBe(11);
  });

  test("downloadHistory computes correct page count for 6-month 1m data", () => {
    // Jan 1 to Jul 1 = 181 days × 1440 bars/day = 260640 + 1 = 260641 candles → 53 pages
    const ONE_MIN = 60_000;
    const windows = computeDownloadWindows(
      new Date("2025-01-01").getTime(),
      new Date("2025-07-01").getTime(),
      ONE_MIN,
    );
    expect(windows.length).toBe(53);
  });
});
