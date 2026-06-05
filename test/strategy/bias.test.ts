import { describe, expect, test } from "bun:test";
import { atr } from "../../src/indicators/core.js";
import { detectStructureBreaks, findPivots } from "../../src/indicators/smc.js";
import { detectWyckoff } from "../../src/indicators/wyckoff.js";
import { determineBias } from "../../src/strategy/shared/bias.js";
import type { Candle, PivotPoint } from "../../src/types.js";

const HTF_ALIGN_BOOST = 0.15;
const SPRING_LOW_LOOKBACK = 50;

describe("determineBias", () => {
  test("matches the previous fallback behavior when caller provides cached pivots", () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 100 + i * 0.11;
      const wave = Math.sin(i / 4) * 3.2;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.25,
        h: base + wave + 1.15,
        l: base + wave - 1.05,
        c: base + Math.cos(i / 5) * 0.7,
        v: 900 + (i % 9) * 40,
      };
    });

    const htfCandles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 140 + i * 0.2;
      const wave = Math.cos(i / 5) * 4.0;
      return {
        t: i * 14_400_000,
        o: base + wave - 0.4,
        h: base + wave + 1.8,
        l: base + wave - 1.6,
        c: base + Math.sin(i / 6) * 1.1,
        v: 1500 + (i % 7) * 60,
      };
    });

    const idx = 100;
    const pivots = findPivots(candles, idx, 3);

    const naiveDetermineBias = (): ReturnType<typeof determineBias> => {
      const wyckoff = detectWyckoff(candles, idx);
      const breaks = detectStructureBreaks(candles, idx);
      let latestCHoCH: (typeof breaks)[number] | undefined;
      let latestBOS: (typeof breaks)[number] | undefined;
      for (
        let i = breaks.length - 1;
        i >= 0 && (latestCHoCH === undefined || latestBOS === undefined);
        i--
      ) {
        const br = breaks[i]!;
        if (latestCHoCH === undefined && br.kind === "choch") latestCHoCH = br;
        if (latestBOS === undefined && br.kind === "bos") latestBOS = br;
      }

      let bias: "long" | "short" | "neutral" = "neutral";
      let confidence = 0;
      let source = "none";

      if (wyckoff.phase === "accumulation") {
        if (latestCHoCH && latestCHoCH.direction === "bullish") {
          bias = "long";
          confidence = wyckoff.confidence;
          source = "wyckoff+smc";
        } else if (
          latestBOS &&
          latestBOS.direction === "bearish" &&
          !latestCHoCH
        ) {
          bias = "neutral";
          confidence = 0;
          source = "wyckoff+smc-conflict";
        } else {
          bias = "long";
          confidence = wyckoff.confidence * 0.7;
          source = "wyckoff-only";
        }
      } else if (wyckoff.phase === "distribution") {
        if (latestCHoCH && latestCHoCH.direction === "bearish") {
          bias = "short";
          confidence = wyckoff.confidence;
          source = "wyckoff+smc";
        } else if (
          latestBOS &&
          latestBOS.direction === "bullish" &&
          !latestCHoCH
        ) {
          bias = "neutral";
          confidence = 0;
          source = "wyckoff+smc-conflict";
        } else {
          bias = "short";
          confidence = wyckoff.confidence * 0.7;
          source = "wyckoff-only";
        }
      } else if (wyckoff.phase === "markup") {
        bias = "long";
        confidence = wyckoff.confidence;
        source =
          latestBOS?.direction === "bullish" ? "wyckoff+smc" : "wyckoff-only";
      } else if (wyckoff.phase === "markdown") {
        bias = "short";
        confidence = wyckoff.confidence;
        source =
          latestBOS?.direction === "bearish" ? "wyckoff+smc" : "wyckoff-only";
      } else if (latestCHoCH) {
        bias = latestCHoCH.direction === "bullish" ? "long" : "short";
        confidence = 0.5;
        source = "smc-only";
      }

      if (
        bias === "long" &&
        wyckoff.phase === "accumulation" &&
        wyckoff.event === "spring"
      ) {
        const atrVal = atr(candles, idx, 14);
        const springLow = (() => {
          const minIdx = idx - SPRING_LOW_LOOKBACK;
          let minPrice = Infinity;
          for (const p of pivots) {
            if (p.kind !== "low" || p.index > idx || p.index < minIdx) continue;
            if (p.price < minPrice) minPrice = p.price;
          }
          return minPrice === Infinity ? null : minPrice;
        })();

        if (
          springLow !== null &&
          !Number.isNaN(atrVal) &&
          candles[idx]?.c < springLow - atrVal * 1.5
        ) {
          bias = "short";
          confidence = 0.6;
          source = "spring-invalidation";
        }
      }

      if (bias === "neutral") return { bias: "neutral", confidence: 0, source };

      const computeHTFBiasNaive = (): "long" | "short" | "neutral" | null => {
        if (htfCandles.length < 50) return null;

        const htfIdx = htfCandles.length - 1;
        const htfWyckoff = detectWyckoff(htfCandles, htfIdx);
        const htfBreaks = detectStructureBreaks(htfCandles, htfIdx);
        let htfCHoCH: (typeof htfBreaks)[number] | undefined;
        for (let i = htfBreaks.length - 1; i >= 0; i--) {
          const br = htfBreaks[i]!;
          if (br.kind === "choch") {
            htfCHoCH = br;
            break;
          }
        }

        if (
          htfWyckoff.phase === "accumulation" ||
          htfWyckoff.phase === "markup"
        )
          return "long";
        if (
          htfWyckoff.phase === "distribution" ||
          htfWyckoff.phase === "markdown"
        )
          return "short";
        if (htfCHoCH)
          return htfCHoCH.direction === "bullish" ? "long" : "short";
        return "neutral";
      };

      const htfBias = computeHTFBiasNaive();
      if (htfBias && htfBias !== "neutral") {
        if (htfBias !== bias) {
          return {
            bias: "neutral",
            confidence: 0,
            source: "htf-oppose",
            htfBias,
          };
        }
        confidence = Math.min(confidence + HTF_ALIGN_BOOST, 1);
      }

      return { bias, confidence, source, htfBias: htfBias ?? undefined };
    };

    expect(
      determineBias(candles, idx, htfCandles, pivots as PivotPoint[]),
    ).toEqual(naiveDetermineBias());
  });

  test("matches fallback behavior when caller provides cached breaks and htfBreaks", () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 105 + i * 0.1;
      const wave = Math.cos(i / 4.5) * 3.0;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.2,
        h: base + wave + 1.2,
        l: base + wave - 1.0,
        c: base + Math.sin(i / 6) * 0.8,
        v: 950 + (i % 8) * 35,
      };
    });

    const htfCandles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 150 + i * 0.18;
      const wave = Math.sin(i / 5.5) * 3.8;
      return {
        t: i * 14_400_000,
        o: base + wave - 0.35,
        h: base + wave + 1.6,
        l: base + wave - 1.4,
        c: base + Math.cos(i / 7) * 1.0,
        v: 1400 + (i % 6) * 55,
      };
    });

    const idx = 100;
    const pivots = findPivots(candles, idx, 3);
    const breaks = detectStructureBreaks(candles, idx, { pivots });
    const htfBreaks = detectStructureBreaks(htfCandles, htfCandles.length - 1);

    const fallback = determineBias(
      candles,
      idx,
      htfCandles,
      pivots as PivotPoint[],
    );
    const injected = determineBias(
      candles,
      idx,
      htfCandles,
      pivots as PivotPoint[],
      { breaks, htfBreaks },
    );

    expect(injected).toEqual(fallback);
  });

  test("matches fallback behavior when caller provides cached Wyckoff snapshots", () => {
    const candles: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const base = 108 + i * 0.09;
      const wave = Math.sin(i / 4.2) * 2.7;
      return {
        t: i * 3_600_000,
        o: base + wave - 0.25,
        h: base + wave + 1.1,
        l: base + wave - 0.95,
        c: base + Math.cos(i / 6.5) * 0.7,
        v: 980 + (i % 10) * 30,
      };
    });

    const htfCandles: Candle[] = Array.from({ length: 90 }, (_, i) => {
      const base = 155 + i * 0.16;
      const wave = Math.cos(i / 5.1) * 3.4;
      return {
        t: i * 14_400_000,
        o: base + wave - 0.3,
        h: base + wave + 1.5,
        l: base + wave - 1.3,
        c: base + Math.sin(i / 7.2) * 0.9,
        v: 1450 + (i % 7) * 50,
      };
    });

    const idx = 100;
    const htfIdx = htfCandles.length - 1;
    const pivots = findPivots(candles, idx, 3);
    const breaks = detectStructureBreaks(candles, idx, { pivots });
    const htfBreaks = detectStructureBreaks(htfCandles, htfIdx);
    const wyckoff = detectWyckoff(candles, idx);
    const htfWyckoff = detectWyckoff(htfCandles, htfIdx);

    const fallback = determineBias(
      candles,
      idx,
      htfCandles,
      pivots as PivotPoint[],
      { breaks, htfBreaks },
    );
    const injected = determineBias(
      candles,
      idx,
      htfCandles,
      pivots as PivotPoint[],
      {
        breaks,
        htfBreaks,
        wyckoff,
        htfWyckoff,
      },
    );

    expect(injected).toEqual(fallback);
  });
});
