import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearIndicatorCache,
  clearIndicatorCacheForCoin,
  getCachedBreakerBlocks50,
  getCachedHtfStructureBias,
  getCachedInversionFVGs,
  getCachedKeyZones,
  getCachedPivots,
  getCachedPivots3,
  getCachedStructureBreaks,
  getCachedVsa,
  getCachedWyckoff,
} from "../../src/strategy/shared/indicator-cache.js";
import type { Candle } from "../../src/types.js";

const STEP_1H_MS = 3_600_000;

function makeCandles(
  count: number,
  startTs: number = Date.UTC(2024, 0, 1),
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 0.2;
    return {
      t: startTs + i * STEP_1H_MS,
      o: base,
      h: base + 1.1,
      l: base - 0.9,
      c: base + (i % 2 === 0 ? 0.3 : -0.2),
      v: 900 + i * 3,
    };
  });
}

describe("indicator-cache", () => {
  beforeEach(() => {
    clearIndicatorCache();
  });

  test("reuses same pivots array for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedPivots3("BTC", "1h", candles, idx);
    const second = getCachedPivots3("BTC", "1h", candles, idx);

    expect(second).toBe(first);
  });

  test("reuses parameterized pivots for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedPivots("BTC", "1h", candles, idx, 5, 0.1);
    const second = getCachedPivots("BTC", "1h", candles, idx, 5, 0.1);

    expect(second).toBe(first);
  });

  test("keeps parameterized pivot caches isolated by params", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedPivots("BTC", "1h", candles, idx, 5, 0);
    const second = getCachedPivots("BTC", "1h", candles, idx, 3, 0);

    expect(second).not.toBe(first);
  });

  test("refreshes cache when bar index moves forward", () => {
    const candles = makeCandles(90);
    const first = getCachedPivots3("BTC", "1h", candles, 80);

    candles.push({
      t: candles[candles.length - 1]?.t + STEP_1H_MS,
      o: 140,
      h: 141,
      l: 139,
      c: 140.5,
      v: 1300,
    });

    const refreshed = getCachedPivots3("BTC", "1h", candles, 81);
    expect(refreshed).not.toBe(first);
  });

  test("clearIndicatorCacheForCoin only invalidates that coin", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const btcBefore = getCachedPivots3("BTC", "1h", candles, idx);
    const ethBefore = getCachedPivots3("ETH", "1h", candles, idx);

    clearIndicatorCacheForCoin("BTC");

    const btcAfter = getCachedPivots3("BTC", "1h", candles, idx);
    const ethAfter = getCachedPivots3("ETH", "1h", candles, idx);

    expect(btcAfter).not.toBe(btcBefore);
    expect(ethAfter).toBe(ethBefore);
  });

  test("reuses breaker blocks array for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedBreakerBlocks50("BTC", "1h", candles, idx);
    const second = getCachedBreakerBlocks50("BTC", "1h", candles, idx);

    expect(second).toBe(first);
  });

  test("reuses structure breaks array for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedStructureBreaks("BTC", "1h", candles, idx, {
      tolerance: 0.1,
    });
    const second = getCachedStructureBreaks("BTC", "1h", candles, idx, {
      tolerance: 0.1,
    });

    expect(second).toBe(first);
  });

  test("keeps structure break caches isolated by tolerance", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedStructureBreaks("BTC", "1h", candles, idx, {
      tolerance: 0,
    });
    const second = getCachedStructureBreaks("BTC", "1h", candles, idx, {
      tolerance: 0.25,
    });

    expect(second).not.toBe(first);
  });

  test("reuses key zone snapshot for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedKeyZones("BTC", "15m", candles, idx, 0.1);
    const second = getCachedKeyZones("BTC", "15m", candles, idx, 0.1);

    expect(second).toBe(first);
    expect(second.demandZones).toBe(first.demandZones);
    expect(second.supplyZones).toBe(first.supplyZones);
  });

  test("reuses HTF structure bias for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedHtfStructureBias("BTC", "4h", candles, idx, {
      swingLookback: 5,
      tolerance: 0.1,
    });
    const second = getCachedHtfStructureBias("BTC", "4h", candles, idx, {
      swingLookback: 5,
      tolerance: 0.1,
    });

    expect(second).toBe(first);
  });

  test("reuses VSA signals for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedVsa("BTC", "1h", candles, idx, 20);
    const second = getCachedVsa("BTC", "1h", candles, idx, 20);

    expect(second).toBe(first);
  });

  test("keeps VSA caches isolated by lookback", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedVsa("BTC", "1h", candles, idx, 20);
    const second = getCachedVsa("BTC", "1h", candles, idx, 10);

    expect(second).not.toBe(first);
  });

  test("reuses Wyckoff snapshot for identical coin/tf/bar snapshot", () => {
    const candles = makeCandles(140);
    const idx = 120;

    const first = getCachedWyckoff("BTC", "1h", candles, idx);
    const second = getCachedWyckoff("BTC", "1h", candles, idx);

    expect(second).toBe(first);
  });

  test("keeps Wyckoff caches isolated by params", () => {
    const candles = makeCandles(140);
    const idx = 120;

    const first = getCachedWyckoff("BTC", "1h", candles, idx, {
      rangePeriod: 20,
      trendPeriod: 50,
    });
    const second = getCachedWyckoff("BTC", "1h", candles, idx, {
      rangePeriod: 10,
      trendPeriod: 50,
    });

    expect(second).not.toBe(first);
  });

  test("keeps HTF structure bias caches isolated by params", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedHtfStructureBias("BTC", "4h", candles, idx, {
      swingLookback: 5,
      tolerance: 0,
    });
    const second = getCachedHtfStructureBias("BTC", "4h", candles, idx, {
      swingLookback: 3,
      tolerance: 0,
    });

    expect(second).not.toBe(first);
  });

  test("keeps key zone caches isolated by tolerance", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedKeyZones("BTC", "15m", candles, idx, 0);
    const second = getCachedKeyZones("BTC", "15m", candles, idx, 0.25);

    expect(second).not.toBe(first);
  });

  test("keeps inversion FVG caches isolated by tolerance", () => {
    const candles = makeCandles(90);
    const idx = 80;

    const first = getCachedInversionFVGs("BTC", "1h", candles, idx, 0);
    const second = getCachedInversionFVGs("BTC", "1h", candles, idx, 0.25);

    expect(second).not.toBe(first);
  });
});
