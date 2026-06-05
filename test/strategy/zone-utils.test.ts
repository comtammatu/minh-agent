import { describe, expect, test } from "bun:test";
import { atr } from "../../src/indicators/core.js";
import { findPivots } from "../../src/indicators/smc.js";
import { computeStructureTargets } from "../../src/strategy/shared/zone-utils.js";
import type { Candle, KeyZone } from "../../src/types.js";

const STEP_1H_MS = 3_600_000;

function makeWaveCandles(
  count: number,
  startTs: number = Date.UTC(2024, 0, 1),
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const trend = 100 + i * 0.18;
    const wave = Math.sin(i / 4) * 4.5;
    const close = trend + wave;
    const open = trend + Math.sin((i - 1) / 4) * 4.2;
    const high = Math.max(open, close) + 1.2 + (i % 3) * 0.15;
    const low = Math.min(open, close) - 1.1 - (i % 4) * 0.1;
    return {
      t: startTs + i * STEP_1H_MS,
      o: open,
      h: high,
      l: low,
      c: close,
      v: 900 + i * 5,
    };
  });
}

describe("computeStructureTargets", () => {
  test("matches fallback behavior when caller provides long-side swing pivots", () => {
    const candles = makeWaveCandles(140);
    const idx = 120;
    const entry = candles[idx]?.c;
    const sl = entry - 4.5;
    const opposingZones: KeyZone[] = [
      {
        type: "supply",
        top: entry + 8,
        bottom: entry + 6.5,
        strength: 0.8,
        origin: "fvg",
        createdAtIdx: idx - 10,
      },
    ];

    const fallback = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "long",
      opposingZones,
    );
    const pivots = findPivots(candles, idx, 5);
    const injected = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "long",
      opposingZones,
      pivots,
    );

    expect(injected).toEqual(fallback);
  });

  test("matches fallback behavior when caller provides ATR explicitly", () => {
    const candles = makeWaveCandles(140);
    const idx = 120;
    const entry = candles[idx]?.c;
    const sl = entry - 4.5;
    const opposingZones: KeyZone[] = [
      {
        type: "supply",
        top: entry + 8,
        bottom: entry + 6.5,
        strength: 0.8,
        origin: "fvg",
        createdAtIdx: idx - 10,
      },
    ];

    const fallback = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "long",
      opposingZones,
    );
    const pivots = findPivots(candles, idx, 5);
    const injected = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "long",
      opposingZones,
      pivots,
      atr(candles, idx, 14),
    );

    expect(injected).toEqual(fallback);
  });

  test("matches fallback behavior when caller provides short-side swing pivots", () => {
    const candles = makeWaveCandles(140);
    const idx = 120;
    const entry = candles[idx]?.c;
    const sl = entry + 4.5;
    const opposingZones: KeyZone[] = [
      {
        type: "demand",
        top: entry - 6.5,
        bottom: entry - 8,
        strength: 0.8,
        origin: "swing",
        createdAtIdx: idx - 12,
      },
    ];

    const fallback = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "short",
      opposingZones,
    );
    const pivots = findPivots(candles, idx, 5);
    const injected = computeStructureTargets(
      candles,
      idx,
      entry,
      sl,
      "short",
      opposingZones,
      pivots,
    );

    expect(injected).toEqual(fallback);
  });
});
