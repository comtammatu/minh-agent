/**
 * Golden tests — compare Minh indicator output against fixture snapshots.
 * Run `bun run scripts/gen-fixtures.ts` first to generate test/fixtures/*.json.
 *
 * If fixtures don't exist, tests are skipped (graceful degradation).
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  adx,
  atr,
  detectRegime,
  ema,
  rsi,
  sma,
  volumeRatio,
  volumeTrend,
} from "../src/indicators/core.js";
import { buildVolumeProfile } from "../src/indicators/order-flow.js";
import {
  compileKeyZones,
  detectBreakerBlocks,
  detectFVG,
  detectInversionFVGs,
  detectJudasSwing,
  detectLiquiditySweep,
  detectOrderBlocks,
  detectSessionRange,
  detectStructureBreaks,
  findConfirmingBreak,
  findLiquidityPools,
  findPivots,
  htfStructureBias,
  scanFVGs,
} from "../src/indicators/smc.js";
import { detectVSA } from "../src/indicators/vsa.js";
import { detectWyckoff } from "../src/indicators/wyckoff.js";
import type { Candle } from "../src/types.js";

const fixtureDir = join(import.meta.dir, "fixtures");
const fixturesExist = existsSync(fixtureDir);

function loadFixture<T>(name: string): T | null {
  const path = join(fixtureDir, name);
  if (!existsSync(path)) return null;
  return JSON.parse(require("node:fs").readFileSync(path, "utf8")) as T;
}

// ── Core indicators ──────────────────────────────────────────────────────────

describe("core indicators", () => {
  if (!fixturesExist) {
    it.skip("fixtures not generated — run bun run scripts/gen-fixtures.ts", () => {});
    return;
  }

  const fixture = loadFixture<{
    candles: Candle[];
    sma7: number;
    sma30: number;
    ema14: number;
    atr14: number;
    rsi14: number;
    adx14: number;
    volRatio20: number;
    regime: string;
    sma7Series: number[];
    atr14Series: number[];
  }>("core.json");

  if (!fixture) {
    it.skip("core.json not found", () => {});
    return;
  }

  const { candles } = fixture;
  const idx = candles.length - 1;

  it("sma7 matches golden reference", () => {
    const result = sma(candles, idx, 7);
    expect(result).toBeCloseTo(fixture.sma7, 4);
  });

  it("sma30 matches golden reference", () => {
    const result = sma(candles, idx, 30);
    expect(result).toBeCloseTo(fixture.sma30, 4);
  });

  it("ema14 matches golden reference", () => {
    const result = ema(candles, idx, 14);
    expect(result).toBeCloseTo(fixture.ema14, 2);
  });

  it("atr14 matches golden reference", () => {
    const result = atr(candles, idx, 14);
    expect(result).toBeCloseTo(fixture.atr14, 2);
  });

  it("rsi14 matches golden reference", () => {
    const result = rsi(candles, idx, 14);
    expect(result).toBeCloseTo(fixture.rsi14, 1);
  });

  it("adx14 matches golden reference", () => {
    const result = adx(candles, idx, 14);
    expect(result).toBeCloseTo(fixture.adx14, 1);
  });

  it("volumeRatio20 matches golden reference", () => {
    const result = volumeRatio(candles, idx, 20);
    expect(result).toBeCloseTo(fixture.volRatio20, 3);
  });

  it("regime matches golden reference", () => {
    const result = detectRegime(candles, idx);
    expect(result).toBe(fixture.regime);
  });

  it("sma7 series matches over last 30 bars", () => {
    for (let i = 0; i < fixture.sma7Series.length; i++) {
      const barIdx = idx - 29 + i;
      const result = sma(candles, barIdx, 7);
      expect(result).toBeCloseTo(fixture.sma7Series[i]!, 4);
    }
  });

  it("atr14 series matches over last 30 bars", () => {
    for (let i = 0; i < fixture.atr14Series.length; i++) {
      const barIdx = idx - 29 + i;
      const result = atr(candles, barIdx, 14);
      expect(result).toBeCloseTo(fixture.atr14Series[i]!, 2);
    }
  });
});

// ── SMC indicators ───────────────────────────────────────────────────────────

describe("smc indicators", () => {
  if (!fixturesExist) {
    it.skip("fixtures not generated", () => {});
    return;
  }

  const fixture = loadFixture<{
    candles: Candle[];
    fvgAtIdx: unknown;
    activeFVGs: unknown[];
    orderBlocks: unknown[];
    swingPoints: unknown[];
  }>("smc.json");

  if (!fixture) {
    it.skip("smc.json not found", () => {});
    return;
  }

  const { candles } = fixture;
  const idx = candles.length - 1;

  it("detectFVG returns FVG | null matching fixture", () => {
    const result = detectFVG(candles, idx);
    const expected = fixture.fvgAtIdx;
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      // Check structure fields present
      expect(typeof result?.top).toBe("number");
      expect(typeof result?.bottom).toBe("number");
      expect(typeof result?.midpoint).toBe("number");
      expect(typeof result?.bullish).toBe("boolean");
    }
  });

  it("scanFVGs returns array", () => {
    const result = scanFVGs(candles, idx);
    expect(Array.isArray(result)).toBe(true);
  });

  it("orderBlocks: count within reasonable range of fixture", () => {
    const result = detectOrderBlocks(candles, idx, { lookback: 50 });
    const fixtureCount = (fixture.orderBlocks as unknown[]).length;
    // Allow ±3 due to implementation differences in tested status
    expect(Math.abs(result.length - fixtureCount)).toBeLessThanOrEqual(3);
  });

  it("detectLiquiditySweep finds bullish sweep when wick breaks recent low and closes back inside", () => {
    const sweepCandles: Candle[] = [
      { t: 1, o: 100, h: 102, l: 99, c: 101, v: 1_000 },
      { t: 2, o: 101, h: 103, l: 100, c: 102, v: 1_000 },
      { t: 3, o: 102, h: 104, l: 101, c: 103, v: 1_000 },
      { t: 4, o: 103, h: 105, l: 102, c: 104, v: 1_000 },
      { t: 5, o: 101, h: 103, l: 96, c: 100.5, v: 1_000 },
    ];

    expect(
      detectLiquiditySweep(sweepCandles, 4, { lookback: 4, wickRatio: 0.4 }),
    ).toEqual({
      direction: "bullish",
      level: 99,
    });
  });

  it("detectLiquiditySweep returns null when neither wick can satisfy the configured ratio", () => {
    const noSweepCandles: Candle[] = [
      { t: 1, o: 100, h: 102, l: 99, c: 101, v: 1_000 },
      { t: 2, o: 101, h: 103, l: 100, c: 102, v: 1_000 },
      { t: 3, o: 102, h: 104, l: 101, c: 103, v: 1_000 },
      { t: 4, o: 103, h: 105, l: 102, c: 104, v: 1_000 },
      { t: 5, o: 99.2, h: 100.4, l: 98.8, c: 100.1, v: 1_000 },
    ];

    expect(
      detectLiquiditySweep(noSweepCandles, 4, { lookback: 4, wickRatio: 0.4 }),
    ).toBeNull();
  });

  it("detectSessionRange collects only the current UTC-day window for non-overnight sessions", () => {
    const candles: Candle[] = [
      { t: Date.UTC(2024, 0, 1, 22), o: 100, h: 101, l: 99, c: 100, v: 1_000 },
      { t: Date.UTC(2024, 0, 2, 0), o: 101, h: 103, l: 100, c: 102, v: 1_000 },
      { t: Date.UTC(2024, 0, 2, 1), o: 102, h: 104, l: 101, c: 103, v: 1_000 },
      { t: Date.UTC(2024, 0, 2, 6), o: 103, h: 106, l: 98, c: 104, v: 1_000 },
      { t: Date.UTC(2024, 0, 2, 7), o: 104, h: 108, l: 103, c: 107, v: 1_000 },
    ];

    expect(detectSessionRange(candles, 4, 0, 7)).toEqual({
      high: 106,
      low: 98,
      startIdx: 1,
      endIdx: 3,
      barCount: 3,
    });
  });

  it("detectJudasSwing preserves bullish-first priority when both sweep directions exist", () => {
    const candles: Candle[] = [
      { t: 0, o: 100, h: 102, l: 99, c: 101, v: 1_000 },
      { t: 1, o: 101, h: 103, l: 100, c: 102, v: 1_000 },
      { t: 2, o: 102, h: 104, l: 101, c: 103, v: 1_000 },
      { t: 3, o: 98, h: 104, l: 96, c: 101, v: 1_000 }, // bullish sweep + reversal
      { t: 4, o: 103, h: 108, l: 102, c: 101, v: 1_000 }, // bearish sweep + reversal
    ];
    const range = { high: 104, low: 99, startIdx: 0, endIdx: 2, barCount: 3 };

    expect(detectJudasSwing(candles, 4, range, 0)).toEqual({
      direction: "bullish",
      sweepLevel: 96,
      sweepIdx: 3,
      reversalIdx: 3,
      rangeHigh: 104,
      rangeLow: 99,
    });
  });

  it("detectWyckoff matches the previous naive implementation across default and custom params", () => {
    const candles: Candle[] = Array.from({ length: 180 }, (_, i) => {
      const base = 100 + i * 0.12;
      const wave = Math.sin(i / 5.5) * 3.6;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.25,
        h: base + wave + 1.35,
        l: base + wave - 1.15,
        c: base + Math.cos(i / 7) * 0.95,
        v: 1_000 + (i % 11) * 45,
      };
    });

    const naiveDetectWyckoff = (
      series: Candle[],
      idx: number,
      params: { rangePeriod?: number; trendPeriod?: number } = {},
    ): ReturnType<typeof detectWyckoff> => {
      const rp = params.rangePeriod ?? 20;
      const tp = params.trendPeriod ?? 50;

      if (idx < tp * 2) return { phase: null, confidence: 0, event: null };

      const atrShort = atr(series, idx, rp);
      const atrLong = atr(series, idx, tp);
      if (Number.isNaN(atrShort) || Number.isNaN(atrLong) || atrLong === 0)
        return { phase: null, confidence: 0, event: null };

      const atrRatio = atrShort / atrLong;
      const smaLong = sma(series, idx, tp);
      const smaPrev = sma(series, idx - rp, tp);
      if (Number.isNaN(smaLong) || Number.isNaN(smaPrev) || smaPrev === 0)
        return { phase: null, confidence: 0, event: null };
      const trendSlope = (smaLong - smaPrev) / smaPrev;

      const smaPriorEnd = sma(series, idx - rp, tp);
      const smaPriorStart = sma(series, idx - rp * 2, tp);
      const priorSlope =
        !Number.isNaN(smaPriorEnd) &&
        !Number.isNaN(smaPriorStart) &&
        smaPriorStart !== 0
          ? (smaPriorEnd - smaPriorStart) / smaPriorStart
          : 0;

      const volR = volumeRatio(series, idx, rp);
      const volDecreasing = !Number.isNaN(volR) && volR < 0.8;
      const volSpike = !Number.isNaN(volR) && volR > 2.0;

      let phase: ReturnType<typeof detectWyckoff>["phase"] = null;
      let confidence = 0;
      let event: ReturnType<typeof detectWyckoff>["event"] = null;

      if (atrRatio < 0.7) {
        const isFlat = Math.abs(trendSlope) < 0.02;
        if (isFlat && priorSlope < -0.02) {
          phase = "accumulation";
          confidence = 0.6;
          if (volDecreasing) confidence += 0.15;
          if (
            (() => {
              if (idx < rp + 1) return false;
              let rangeLow = Infinity;
              for (let i = idx - rp; i < idx; i++) {
                const l = series[i]?.l;
                if (l < rangeLow) rangeLow = l;
              }
              const c = series[idx]!;
              return c.l < rangeLow && c.c > rangeLow;
            })()
          ) {
            confidence += 0.2;
            event = "spring";
          }
        } else if (isFlat && priorSlope > 0.02) {
          phase = "distribution";
          confidence = 0.6;
          if (volDecreasing) confidence += 0.15;
          if (
            (() => {
              if (idx < rp + 1) return false;
              let rangeHigh = -Infinity;
              for (let i = idx - rp; i < idx; i++) {
                const h = series[i]?.h;
                if (h > rangeHigh) rangeHigh = h;
              }
              const c = series[idx]!;
              return c.h > rangeHigh && c.c < rangeHigh;
            })()
          ) {
            confidence += 0.2;
            event = "utad";
          }
        }
      } else if (atrRatio > 1.2) {
        if (trendSlope > 0.02) {
          phase = "markup";
          confidence = 0.7;
          if (volSpike) confidence += 0.15;
        } else if (trendSlope < -0.02) {
          phase = "markdown";
          confidence = 0.7;
          if (volSpike) confidence += 0.15;
        }
      }

      return { phase, confidence: Math.min(confidence, 1), event };
    };

    for (let idx = 100; idx < candles.length; idx += 7) {
      expect(detectWyckoff(candles, idx)).toEqual(
        naiveDetectWyckoff(candles, idx),
      );
      expect(
        detectWyckoff(candles, idx, { rangePeriod: 12, trendPeriod: 40 }),
      ).toEqual(
        naiveDetectWyckoff(candles, idx, { rangePeriod: 12, trendPeriod: 40 }),
      );
    }
  });

  it("detectVSA matches the previous naive implementation across default and custom lookbacks", () => {
    const candles: Candle[] = Array.from({ length: 180 }, (_, i) => {
      const base = 100 + i * 0.06;
      const wave = Math.sin(i / 5) * 3.6;
      const bodyShift = Math.cos(i / 7) * 0.9;
      return {
        t: i * 3_600_000,
        o: base + wave - bodyShift * 0.35,
        h: base + wave + 1.35 + (i % 4) * 0.08,
        l: base + wave - 1.15 - (i % 3) * 0.06,
        c: base + wave + bodyShift * 0.45,
        v: 850 + (i % 9) * 90 + (i % 5 === 0 ? 400 : 0),
      };
    });

    const naiveDetectVsa = (
      series: Candle[],
      idx: number,
      lookback: number,
    ) => {
      if (idx < lookback) return [];

      const current = series[idx]!;
      const volR = volumeRatio(series, idx, lookback);
      const atrVal = atr(series, idx, lookback);
      if (Number.isNaN(volR) || Number.isNaN(atrVal) || atrVal === 0) return [];

      const spread = current.h - current.l;
      const body = Math.abs(current.c - current.o);
      const lowerWick = Math.min(current.o, current.c) - current.l;
      const upperWick = current.h - Math.max(current.o, current.c);
      const spreadR = spread / atrVal;
      const bodyR = body / Math.max(spread, 0.0001);
      const trendChange = current.c - series[idx - lookback]?.c;
      const signals: ReturnType<typeof detectVSA> = [];

      if (
        volR > 2.5 &&
        spreadR > 1.2 &&
        current.c < current.o &&
        trendChange < 0
      ) {
        signals.push({
          type: "stopping-volume",
          direction: "bullish",
          strength: Math.min(volR / 4, 1),
          index: idx,
        });
      }
      if (volR < 0.5 && spreadR < 0.6 && lowerWick > body && trendChange < 0) {
        signals.push({
          type: "test",
          direction: "bullish",
          strength: Math.min((1 - volR) * 0.8, 1),
          index: idx,
        });
      }
      if (
        volR < 0.4 &&
        spreadR < 0.5 &&
        current.c > current.o &&
        trendChange < 0
      ) {
        signals.push({
          type: "no-supply",
          direction: "bullish",
          strength: Math.min((1 - volR) * 0.7, 1),
          index: idx,
        });
      }
      if (volR > 3.0 && spreadR > 1.0 && current.c > current.o && bodyR > 0.6) {
        signals.push({
          type: "climax-buy",
          direction: "bullish",
          strength: Math.min(volR / 5, 1),
          index: idx,
        });
      }
      if (
        volR > 2.5 &&
        spreadR > 1.2 &&
        current.c > current.o &&
        trendChange > 0
      ) {
        signals.push({
          type: "climax-sell",
          direction: "bearish",
          strength: Math.min(volR / 4, 1),
          index: idx,
        });
      }
      if (volR > 1.5 && upperWick > body * 2 && current.c < current.o) {
        signals.push({
          type: "thrust",
          direction: "bearish",
          strength: Math.min(volR / 3, 1),
          index: idx,
        });
      }
      if (
        volR < 0.4 &&
        spreadR < 0.5 &&
        current.c < current.o &&
        trendChange > 0
      ) {
        signals.push({
          type: "no-demand",
          direction: "bearish",
          strength: Math.min((1 - volR) * 0.7, 1),
          index: idx,
        });
      }
      if (volR > 2.0 && spreadR < 0.4) {
        signals.push({
          type: "effort-vs-result",
          direction: trendChange > 0 ? "bearish" : "bullish",
          strength: Math.min(volR * (1 - spreadR), 1),
          index: idx,
        });
      }

      return signals;
    };

    for (const lookback of [12, 20, 30]) {
      for (let idx = lookback; idx < candles.length; idx += 7) {
        expect(detectVSA(candles, idx, { lookback })).toEqual(
          naiveDetectVsa(candles, idx, lookback),
        );
      }
    }
  });

  it("findConfirmingBreak matches the previous naive implementation for bullish direction", () => {
    const sample: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const base = 100 + i * 0.18;
      const wave = Math.sin(i / 3) * 2.2;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.25,
        h: base + wave + 1.2,
        l: base + wave - 1.1,
        c: base + Math.cos(i / 4) * 0.9,
        v: 900 + (i % 7) * 30,
      };
    });

    const naiveFindConfirmingBreak = (): ReturnType<
      typeof findConfirmingBreak
    > => {
      let bestBreak: ReturnType<typeof findConfirmingBreak> = null;
      for (let i = Math.max(0, 55 - 12); i <= 55; i++) {
        const breaks = detectStructureBreaks(sample, i, { tolerance: 0.1 });
        for (const b of breaks) {
          if (b.direction !== "bullish") continue;
          if (
            !bestBreak ||
            b.kind === "choch" ||
            (bestBreak.kind !== "choch" && b.index > bestBreak.index)
          ) {
            bestBreak = b;
          }
        }
      }
      return bestBreak;
    };

    expect(findConfirmingBreak(sample, 55, 12, "bullish", 0.1)).toEqual(
      naiveFindConfirmingBreak(),
    );
  });

  it("findConfirmingBreak matches the previous naive implementation for bearish direction", () => {
    const sample: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const base = 130 - i * 0.16;
      const wave = Math.cos(i / 3) * 2.4;
      return {
        t: i * 3_600_000,
        o: base + wave + 0.2,
        h: base + wave + 1.1,
        l: base + wave - 1.3,
        c: base + Math.sin(i / 4) * 0.8,
        v: 950 + (i % 5) * 40,
      };
    });

    const naiveFindConfirmingBreak = (): ReturnType<
      typeof findConfirmingBreak
    > => {
      let bestBreak: ReturnType<typeof findConfirmingBreak> = null;
      for (let i = Math.max(0, 55 - 12); i <= 55; i++) {
        const breaks = detectStructureBreaks(sample, i, { tolerance: 0.1 });
        for (const b of breaks) {
          if (b.direction !== "bearish") continue;
          if (
            !bestBreak ||
            b.kind === "choch" ||
            (bestBreak.kind !== "choch" && b.index > bestBreak.index)
          ) {
            bestBreak = b;
          }
        }
      }
      return bestBreak;
    };

    expect(findConfirmingBreak(sample, 55, 12, "bearish", 0.1)).toEqual(
      naiveFindConfirmingBreak(),
    );
  });

  it("detectStructureBreaks matches the previous clustered-pivot implementation", () => {
    const sample: Candle[] = Array.from({ length: 80 }, (_, i) => {
      const base = 100 + i * 0.12;
      const wave = Math.sin(i / 2.7) * 3.1;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.2,
        h: base + wave + 1.0,
        l: base + wave - 1.1,
        c: base + Math.cos(i / 3.3) * 0.8,
        v: 1000 + (i % 9) * 20,
      };
    });

    const naiveDetectStructureBreaks = (): ReturnType<
      typeof detectStructureBreaks
    > => {
      const tol = 0.1;
      const minSpacing = 5;
      const pivots = findPivots(sample, 70, 3, tol);
      const breaks: ReturnType<typeof detectStructureBreaks> = [];

      const filterClustered = (pts: typeof pivots): typeof pivots => {
        if (pts.length <= 1) return pts;
        const result = [pts[0]!];
        for (let i = 1; i < pts.length; i++) {
          const prev = result[result.length - 1]!;
          const cur = pts[i]!;
          if (cur.index - prev.index >= minSpacing) {
            result.push(cur);
          } else if (
            (cur.kind === "high" && cur.price > prev.price) ||
            (cur.kind === "low" && cur.price < prev.price)
          ) {
            result[result.length - 1] = cur;
          }
        }
        return result;
      };

      const highs = filterClustered(pivots.filter((p) => p.kind === "high"));
      const lows = filterClustered(pivots.filter((p) => p.kind === "low"));
      if (highs.length < 2 || lows.length < 2) return breaks;

      const curAtr = atr(sample, 70, 14);
      const minPriceDist = !Number.isNaN(curAtr) ? curAtr * 0.5 : 0;

      const c = sample[70]!;
      const prevHigh = highs[highs.length - 2]!;
      const prevLow = lows[lows.length - 2]!;
      const lastHigh = highs[highs.length - 1]!;
      const lastLow = lows[lows.length - 1]!;

      if (
        c.c > prevHigh.price - tol &&
        Math.abs(c.c - prevHigh.price) >= minPriceDist * 0.3
      ) {
        const isCHoCH =
          lastLow.price < lows[Math.max(0, lows.length - 3)]?.price;
        breaks.push({
          kind: isCHoCH ? "choch" : "bos",
          direction: "bullish",
          level: prevHigh.price,
          index: 70,
        });
      }
      if (
        c.c < prevLow.price + tol &&
        Math.abs(c.c - prevLow.price) >= minPriceDist * 0.3
      ) {
        const isCHoCH =
          lastHigh.price > highs[Math.max(0, highs.length - 3)]?.price;
        breaks.push({
          kind: isCHoCH ? "choch" : "bos",
          direction: "bearish",
          level: prevLow.price,
          index: 70,
        });
      }
      return breaks;
    };

    expect(detectStructureBreaks(sample, 70, { tolerance: 0.1 })).toEqual(
      naiveDetectStructureBreaks(),
    );
  });

  it("findPivots matches the previous naive implementation", () => {
    const sample: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 100 + Math.sin(i / 6) * 4 + i * 0.05;
      return {
        t: i * 3_600_000,
        o: base - 0.35,
        h: base + (i % 5 === 0 ? 1.8 : 1.1),
        l: base - (i % 7 === 0 ? 1.7 : 1.0),
        c: base + Math.cos(i / 4) * 0.45,
        v: 950 + (i % 11) * 25,
      };
    });

    const naiveFindPivots = (): ReturnType<typeof findPivots> => {
      const pivots: ReturnType<typeof findPivots> = [];
      const upToIdx = 70;
      const lookback = 5;
      const tolerance = 0.1;

      for (let i = lookback; i <= upToIdx - lookback; i++) {
        const c = sample[i]!;
        let isHigh = true;
        let isLow = true;

        for (let j = 1; j <= lookback; j++) {
          if (
            c.h < sample[i - j]?.h - tolerance ||
            c.h < sample[i + j]?.h - tolerance
          )
            isHigh = false;
          if (
            c.l > sample[i - j]?.l + tolerance ||
            c.l > sample[i + j]?.l + tolerance
          )
            isLow = false;
        }

        if (isHigh) pivots.push({ kind: "high", price: c.h, index: i });
        if (isLow) pivots.push({ kind: "low", price: c.l, index: i });
      }

      return pivots;
    };

    expect(findPivots(sample, 70, 5, 0.1)).toEqual(naiveFindPivots());
  });

  it("detectOrderBlocks matches the previous naive implementation including tested flags", () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 100 + i * 0.09;
      const impulse =
        i % 8 === 0 ? 2.4 : i % 6 === 0 ? -1.9 : Math.sin(i / 4.8) * 0.85;
      return {
        t: i * 3_600_000,
        o: base + impulse * 0.18,
        h: base + impulse + 1.05,
        l: base + impulse - 0.95,
        c: base + impulse * 0.72,
        v: 900 + (i % 10) * 28,
      };
    });

    const naiveDetectOrderBlocks = (
      series: Candle[],
      upToIdx: number,
      params: { impulseMultiplier?: number; lookback?: number } = {},
    ): ReturnType<typeof detectOrderBlocks> => {
      const mult = params.impulseMultiplier ?? 1.5;
      const lb = params.lookback ?? 50;
      const start = Math.max(1, upToIdx - lb);
      const blocks: ReturnType<typeof detectOrderBlocks> = [];

      for (let i = start; i < upToIdx; i++) {
        const cur = series[i]!;
        const nxt = series[i + 1];
        if (!nxt) continue;

        const curBody = Math.abs(cur.c - cur.o);
        const nxtBody = Math.abs(nxt.c - nxt.o);
        if (nxtBody < curBody * mult) continue;

        if (cur.c < cur.o && nxt.c > nxt.o) {
          blocks.push({
            top: cur.o,
            bottom: cur.l,
            bullish: true,
            index: i,
            tested: false,
          });
        } else if (cur.c > cur.o && nxt.c < nxt.o) {
          blocks.push({
            top: cur.h,
            bottom: cur.o,
            bullish: false,
            index: i,
            tested: false,
          });
        }
      }

      for (const ob of blocks) {
        for (let i = ob.index + 2; i <= upToIdx; i++) {
          const candle = series[i]!;
          if (ob.bullish && candle.l <= ob.top && candle.l >= ob.bottom) {
            ob.tested = true;
            break;
          }
          if (!ob.bullish && candle.h >= ob.bottom && candle.h <= ob.top) {
            ob.tested = true;
            break;
          }
        }
      }

      return blocks;
    };

    const upToIdx = candles.length - 1;
    expect(detectOrderBlocks(candles, upToIdx, { lookback: 50 })).toEqual(
      naiveDetectOrderBlocks(candles, upToIdx, { lookback: 50 }),
    );
  });

  it("htfStructureBias matches fallback behavior when caller provides pivots", () => {
    const sample: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 120 + i * 0.09;
      const wave = Math.sin(i / 5) * 3.4;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.25,
        h: base + wave + 1.15,
        l: base + wave - 1.05,
        c: base + Math.cos(i / 4) * 0.7,
        v: 1000 + (i % 9) * 35,
      };
    });

    const upToIdx = 80;
    const swingLookback = 5;
    const tolerance = 0.1;
    const pivots = findPivots(sample, upToIdx, swingLookback, tolerance);

    const fallback = htfStructureBias(sample, upToIdx, {
      swingLookback,
      tolerance,
    });
    const injected = htfStructureBias(sample, upToIdx, {
      swingLookback,
      tolerance,
      pivots,
    });

    expect(injected).toEqual(fallback);
  });

  it("compileKeyZones matches fallback behavior when caller provides pivots and FVGs", () => {
    const sample: Candle[] = Array.from({ length: 95 }, (_, i) => {
      const base = 130 + i * 0.11;
      const wave = Math.sin(i / 4.5) * 4.1;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.35,
        h: base + wave + 1.4,
        l: base + wave - 1.25,
        c: base + Math.cos(i / 6) * 0.9,
        v: 1050 + (i % 13) * 40,
      };
    });

    const upToIdx = 88;
    const tolerance = 0.1;
    const pivots = findPivots(sample, upToIdx, 3, tolerance);
    const fvgs = scanFVGs(sample, upToIdx, tolerance);

    const fallback = compileKeyZones(sample, upToIdx, tolerance);
    const injected = compileKeyZones(sample, upToIdx, tolerance, {
      pivots,
      fvgs,
    });

    expect(injected).toEqual(fallback);
  });
});

// ── Structure tests removed — analyzeStructure deleted in A6 ──────────────────
// classifySwings + detectStructuralBias now tested in test/price-action-structure.test.ts

// ── Smoke tests (no fixtures needed) ─────────────────────────────────────────

describe("core smoke tests", () => {
  function buildTrendCandles(n: number): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      t: i * 3600_000,
      o: 100 + i,
      h: 103 + i,
      l: 98 + i,
      c: 102 + i,
      v: 1000 + i * 10,
    }));
  }

  it("sma returns finite positive value", () => {
    const candles = buildTrendCandles(30);
    const result = sma(candles, 29, 7);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it("atr returns finite positive value", () => {
    const candles = buildTrendCandles(30);
    const result = atr(candles, 29, 14);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("atr matches the previous naive implementation", () => {
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      const base = 100 + i * 0.08;
      const wave = Math.sin(i / 5.5) * 2.8;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.18,
        h: base + wave + 1.15,
        l: base + wave - 0.95,
        c: base + Math.cos(i / 6.5) * 0.82,
        v: 880 + (i % 11) * 33,
      };
    });

    const naiveAtr = (
      series: Candle[],
      idx: number,
      period: number,
    ): number => {
      if (idx < period) return NaN;

      let val = 0;
      for (let i = 1; i <= period; i++) {
        const current = series[i]!;
        const previous = series[i - 1]!;
        val += Math.max(
          current.h - current.l,
          Math.abs(current.h - previous.c),
          Math.abs(current.l - previous.c),
        );
      }
      val /= period;

      for (let i = period + 1; i <= idx; i++) {
        const current = series[i]!;
        const previous = series[i - 1]!;
        const tr = Math.max(
          current.h - current.l,
          Math.abs(current.h - previous.c),
          Math.abs(current.l - previous.c),
        );
        val = (val * (period - 1) + tr) / period;
      }

      return val;
    };

    for (const period of [7, 14, 21, 30]) {
      for (let idx = period; idx < candles.length; idx += 5) {
        expect(atr(candles, idx, period)).toBeCloseTo(
          naiveAtr(candles, idx, period),
          10,
        );
      }
    }
  });

  it("rsi is bounded 0-100", () => {
    const candles = buildTrendCandles(30);
    const result = rsi(candles, 29, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("detectRegime returns valid enum value", () => {
    const candles = buildTrendCandles(100);
    const result = detectRegime(candles, 99);
    expect(["BULL", "BEAR", "SIDEWAYS", "VOLATILE"]).toContain(result);
  });

  it("detectRegime matches the previous naive implementation", () => {
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      const base = 100 + i * 0.09;
      const wave = Math.sin(i / 6) * 3.1;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.2,
        h: base + wave + 1.2,
        l: base + wave - 1.0,
        c: base + Math.cos(i / 7) * 0.85,
        v: 900 + (i % 13) * 35,
      };
    });

    const naiveDetectRegime = (series: Candle[], idx: number) => {
      if (idx < 49) return "SIDEWAYS";

      const s7 = sma(series, idx, 7);
      const s30 = sma(series, idx, 30);
      if (Number.isNaN(s7) || Number.isNaN(s30) || s30 === 0) return "SIDEWAYS";
      const smaRatio = s7 / s30;

      const atr7 = atr(series, idx, 7);
      const atr30 = atr(series, idx, 30);
      if (Number.isNaN(atr7) || Number.isNaN(atr30)) return "SIDEWAYS";
      const atrRatio = atr30 > 0 ? atr7 / atr30 : 1;

      if (atrRatio > 2.0) return "VOLATILE";

      const adxVal = adx(series, idx, 14);
      if (!Number.isNaN(adxVal) && adxVal < 15) return "SIDEWAYS";

      const volTrend = volumeTrend(series, idx, 10);

      if (smaRatio > 1.005) {
        if (
          (!Number.isNaN(adxVal) && adxVal > 20) ||
          smaRatio > 1.015 ||
          volTrend > 0.1
        )
          return "BULL";
        return "SIDEWAYS";
      }
      if (smaRatio < 0.995) {
        if (
          (!Number.isNaN(adxVal) && adxVal > 20) ||
          smaRatio < 0.985 ||
          volTrend > 0.1
        )
          return "BEAR";
        return "SIDEWAYS";
      }
      return "SIDEWAYS";
    };

    for (let idx = 49; idx < candles.length; idx += 5) {
      expect(detectRegime(candles, idx)).toBe(naiveDetectRegime(candles, idx));
    }
  });

  it("adx matches the previous naive implementation without dx array reuse", () => {
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      const base = 100 + i * 0.11;
      const wave = Math.sin(i / 4.5) * 3.4;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.22,
        h: base + wave + 1.25,
        l: base + wave - 1.05,
        c: base + Math.cos(i / 6) * 0.9,
        v: 920 + (i % 9) * 40,
      };
    });

    const naiveAdx = (
      series: Candle[],
      idx: number,
      period: number = 14,
    ): number => {
      if (idx < period * 2) return NaN;

      let pDM = 0,
        mDM = 0,
        tr14 = 0;
      for (let i = 1; i <= period; i++) {
        const c = series[i]!,
          p = series[i - 1]!;
        const up = c.h - p.h,
          dn = p.l - c.l;
        pDM += up > dn && up > 0 ? up : 0;
        mDM += dn > up && dn > 0 ? dn : 0;
        tr14 += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
      }

      const dxArr: number[] = [];
      for (let i = period + 1; i <= idx; i++) {
        const c = series[i]!,
          p = series[i - 1]!;
        const up = c.h - p.h,
          dn = p.l - c.l;
        pDM = pDM - pDM / period + (up > dn && up > 0 ? up : 0);
        mDM = mDM - mDM / period + (dn > up && dn > 0 ? dn : 0);
        tr14 =
          tr14 -
          tr14 / period +
          Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));

        if (tr14 === 0) {
          dxArr.push(0);
          continue;
        }
        const pdi = (pDM / tr14) * 100;
        const mdi = (mDM / tr14) * 100;
        const sum = pdi + mdi;
        dxArr.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
      }

      if (dxArr.length < period) return NaN;

      let adxVal = 0;
      for (let i = 0; i < period; i++) adxVal += dxArr[i]!;
      adxVal /= period;
      for (let i = period; i < dxArr.length; i++) {
        adxVal = (adxVal * (period - 1) + dxArr[i]!) / period;
      }
      return adxVal;
    };

    for (let idx = 28; idx < candles.length; idx += 5) {
      expect(adx(candles, idx, 14)).toBeCloseTo(naiveAdx(candles, idx, 14), 10);
    }
  });

  it("buildVolumeProfile returns valid profile", () => {
    const candles = buildTrendCandles(210);
    const result = buildVolumeProfile(candles, 0, 199);
    expect(result).not.toBeNull();
    expect(result?.poc).toBeGreaterThan(0);
    expect(result?.vah).toBeGreaterThan(result?.val);
  });
});

describe("smc pure behavior", () => {
  it("scanFVGs excludes filled gaps and preserves chronological order", () => {
    const candles: Candle[] = [
      { t: 0, o: 100, h: 101, l: 99, c: 100, v: 1000 },
      { t: 1, o: 100.5, h: 101.5, l: 100, c: 101, v: 1000 },
      { t: 2, o: 104, h: 106, l: 104, c: 105, v: 1000 }, // bullish FVG vs candle 0
      { t: 3, o: 103, h: 104, l: 102, c: 103, v: 1000 }, // fills first FVG midpoint
      { t: 4, o: 110, h: 112, l: 110, c: 111, v: 1000 }, // bullish FVG vs candle 2
      { t: 5, o: 109.5, h: 111, l: 109, c: 110.5, v: 1000 },
    ];

    const result = scanFVGs(candles, 5);

    const indices = result.map((fvg) => fvg.index);

    expect(indices.includes(2)).toBe(false);
    expect(indices.includes(4)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("findLiquidityPools matches the reference naive implementation", () => {
    const candles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 100 + i * 0.12;
      const wave = Math.sin(i / 3) * 2.5;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.2,
        h: base + wave + 1.1,
        l: base + wave - 1.0,
        c: base + Math.cos(i / 4) * 0.7,
        v: 1000 + (i % 7) * 40,
      };
    });

    const upToIdx = candles.length - 1;
    const tolerance = 0.15;
    const minCluster = 2;
    const pivots = findPivots(candles, upToIdx, 3, tolerance);
    const curAtr = atr(candles, upToIdx, 14);
    const clusterTol = curAtr * 0.15;

    const naive = (kind: "high" | "low", type: "bsl" | "ssl") => {
      const points = pivots.filter((pivot) => pivot.kind === kind);
      const pools: Array<{
        level: number;
        type: "bsl" | "ssl";
        count: number;
        index: number;
      }> = [];
      for (let i = 0; i < points.length; i++) {
        let count = 1;
        let maxIdx = points[i]?.index;
        for (let j = i + 1; j < points.length; j++) {
          if (Math.abs(points[j]?.price - points[i]?.price) <= clusterTol) {
            count++;
            maxIdx = Math.max(maxIdx, points[j]?.index);
          }
        }
        if (count >= minCluster) {
          pools.push({ level: points[i]?.price, type, count, index: maxIdx });
        }
      }
      return pools;
    };

    const expected = [...naive("high", "bsl"), ...naive("low", "ssl")];
    const actual = findLiquidityPools(candles, upToIdx, {
      tolerance,
      minCluster,
    });

    expect(actual).toEqual(expected);
  });

  it("findLiquidityPools matches fallback behavior when ATR is provided explicitly", () => {
    const candles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 100 + i * 0.12;
      const wave = Math.sin(i / 3) * 2.5;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.2,
        h: base + wave + 1.1,
        l: base + wave - 1.0,
        c: base + Math.cos(i / 4) * 0.7,
        v: 1000 + (i % 7) * 40,
      };
    });

    const upToIdx = candles.length - 1;
    const tolerance = 0.15;
    const minCluster = 2;
    const atrValue = atr(candles, upToIdx, 14);

    const fallback = findLiquidityPools(candles, upToIdx, {
      tolerance,
      minCluster,
    });
    const injected = findLiquidityPools(candles, upToIdx, {
      tolerance,
      minCluster,
      atrValue,
    });

    expect(injected).toEqual(fallback);
  });

  it("detectBreakerBlocks matches the reference naive implementation", () => {
    const candles: Candle[] = Array.from({ length: 100 }, (_, i) => {
      const base = 100 + i * 0.08;
      const impulse =
        i % 9 === 0 ? 2.2 : i % 7 === 0 ? -1.8 : Math.sin(i / 5) * 0.9;
      return {
        t: i * 3_600_000,
        o: base + impulse * 0.2,
        h: base + impulse + 1.0,
        l: base + impulse - 1.0,
        c: base + impulse * 0.7,
        v: 1000 + (i % 11) * 30,
      };
    });

    const upToIdx = candles.length - 1;
    const obs = detectOrderBlocks(candles, upToIdx, { lookback: 50 });
    const expected: ReturnType<typeof detectBreakerBlocks> = [];

    for (const ob of obs) {
      let breaker: ReturnType<typeof detectBreakerBlocks>[number] | null = null;
      for (let i = ob.index + 2; i <= upToIdx; i++) {
        const c = candles[i]!;
        if (ob.bullish ? c.c < ob.bottom : c.c > ob.top) {
          breaker = {
            top: ob.top,
            bottom: ob.bottom,
            type: ob.bullish ? "supply" : "demand",
            index: i,
            originalOBIndex: ob.index,
          };
          break;
        }
      }
      if (!breaker) continue;

      let stillValid = true;
      for (let i = breaker.index + 1; i <= upToIdx; i++) {
        const c = candles[i]!;
        if (breaker.type === "demand" && c.c < breaker.bottom) {
          stillValid = false;
          break;
        }
        if (breaker.type === "supply" && c.c > breaker.top) {
          stillValid = false;
          break;
        }
      }
      if (stillValid) expected.push(breaker);
    }

    expect(detectBreakerBlocks(candles, upToIdx, { lookback: 50 })).toEqual(
      expected,
    );
  });

  it("detectInversionFVGs matches the reference naive implementation", () => {
    const candles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 100 + i * 0.05;
      const jump =
        i % 10 === 2 ? 4.0 : i % 10 === 5 ? -3.5 : Math.sin(i / 4) * 0.6;
      return {
        t: i * 3_600_000,
        o: base + jump * 0.15,
        h: base + jump + 1.2,
        l: base + jump - 1.1,
        c: base + jump * 0.8,
        v: 900 + (i % 5) * 50,
      };
    });

    const upToIdx = candles.length - 1;
    const tolerance = 0.1;
    const expected: ReturnType<typeof detectInversionFVGs> = [];

    for (let i = 2; i <= upToIdx; i++) {
      const fvg = detectFVG(candles, i, tolerance);
      if (!fvg) continue;

      let inversion: ReturnType<typeof detectInversionFVGs>[number] | null =
        null;
      for (let j = i + 1; j <= upToIdx; j++) {
        const c = candles[j]!;
        if (fvg.bullish ? c.c < fvg.bottom : c.c > fvg.top) {
          inversion = {
            top: fvg.top,
            bottom: fvg.bottom,
            midpoint: fvg.midpoint,
            type: fvg.bullish ? "supply" : "demand",
            index: j,
            originalFVGIndex: fvg.index,
          };
          break;
        }
      }
      if (!inversion) continue;

      let stillValid = true;
      for (let j = inversion.index + 1; j <= upToIdx; j++) {
        const c = candles[j]!;
        if (inversion.type === "demand" && c.c < inversion.bottom) {
          stillValid = false;
          break;
        }
        if (inversion.type === "supply" && c.c > inversion.top) {
          stillValid = false;
          break;
        }
      }
      if (stillValid) expected.push(inversion);
    }

    expect(detectInversionFVGs(candles, upToIdx, tolerance)).toEqual(expected);
  });
});
