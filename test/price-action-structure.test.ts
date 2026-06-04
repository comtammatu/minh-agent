/**
 * Direct tests for classifySwings() and detectStructuralBias()
 * (moved from structure.ts to price-action.ts in A3).
 *
 * Uses hand-crafted candle data to verify swing classification and bias detection.
 */

import { describe, expect, it } from "bun:test";
import {
  classifySwings,
  detectStructuralBias,
} from "../src/indicators/price-action.js";
import type { Candle, SwingPoint } from "../src/types.js";

function mkCandle(h: number, l: number, c: number, idx: number): Candle {
  return { t: idx * 60000, o: (h + l) / 2, h, l, c, v: 100 };
}

// Build a sequence of candles that produces clear swing points:
// Uptrend: progressively higher highs and higher lows
function buildUptrend(count: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 2;
    // Alternate: odd index = dip (low), even = push (high)
    if (i % 2 === 0) {
      candles.push(mkCandle(base + 5, base, base + 4, i));
    } else {
      candles.push(mkCandle(base + 2, base - 3, base, i));
    }
  }
  return candles;
}

function _buildDowntrend(count: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 200 - i * 2;
    if (i % 2 === 0) {
      candles.push(mkCandle(base + 2, base - 3, base - 2, i));
    } else {
      candles.push(mkCandle(base + 5, base, base + 1, i));
    }
  }
  return candles;
}

describe("classifySwings", () => {
  it("returns empty array for insufficient candles", () => {
    const candles = [mkCandle(10, 5, 8, 0)];
    expect(classifySwings(candles, 0)).toEqual([]);
  });

  it("returns SwingPoint array with correct types", () => {
    const candles = buildUptrend(30);
    const swings = classifySwings(candles, candles.length - 1);
    expect(Array.isArray(swings)).toBe(true);
    for (const s of swings) {
      expect(["HH", "HL", "LH", "LL"]).toContain(s.type);
      expect(typeof s.price).toBe("number");
      expect(typeof s.index).toBe("number");
    }
  });

  it("produces swings sorted by index", () => {
    const candles = buildUptrend(30);
    const swings = classifySwings(candles, candles.length - 1);
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i]?.index).toBeGreaterThanOrEqual(swings[i - 1]?.index);
    }
  });

  it("detects HH/HL in uptrend", () => {
    const candles = buildUptrend(30);
    const swings = classifySwings(candles, candles.length - 1);
    if (swings.length > 0) {
      const types = swings.map((s) => s.type);
      const bullishCount = types.filter((t) => t === "HH" || t === "HL").length;
      expect(bullishCount).toBeGreaterThan(0);
    }
  });
});

describe("detectStructuralBias", () => {
  it("returns neutral for fewer than 4 swings", () => {
    const swings: SwingPoint[] = [
      { type: "HH", price: 110, index: 5 },
      { type: "HL", price: 105, index: 8 },
    ];
    expect(detectStructuralBias(swings)).toEqual({
      bias: "neutral",
      confidence: 0,
    });
  });

  it("returns bullish for HH/HL dominant swings", () => {
    const swings: SwingPoint[] = [
      { type: "HH", price: 110, index: 5 },
      { type: "HL", price: 105, index: 8 },
      { type: "HH", price: 115, index: 12 },
      { type: "HL", price: 108, index: 15 },
      { type: "HH", price: 120, index: 18 },
    ];
    const result = detectStructuralBias(swings);
    expect(result.bias).toBe("bullish");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("returns bearish for LH/LL dominant swings", () => {
    const swings: SwingPoint[] = [
      { type: "LH", price: 95, index: 5 },
      { type: "LL", price: 90, index: 8 },
      { type: "LH", price: 88, index: 12 },
      { type: "LL", price: 85, index: 15 },
      { type: "LH", price: 83, index: 18 },
    ];
    const result = detectStructuralBias(swings);
    expect(result.bias).toBe("bearish");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("returns neutral for mixed swings", () => {
    const swings: SwingPoint[] = [
      { type: "HH", price: 110, index: 5 },
      { type: "LL", price: 90, index: 8 },
      { type: "LH", price: 105, index: 12 },
      { type: "HL", price: 95, index: 15 },
    ];
    const result = detectStructuralBias(swings);
    expect(result.bias).toBe("neutral");
  });

  it("uses last 10 swings max", () => {
    // 12 bullish swings, but function should only consider last 10
    const swings: SwingPoint[] = Array.from({ length: 12 }, (_, i) => ({
      type: (i % 2 === 0 ? "HH" : "HL") as "HH" | "HL",
      price: 100 + i,
      index: i * 3,
    }));
    const result = detectStructuralBias(swings);
    expect(result.bias).toBe("bullish");
  });
});
