/**
 * Bias determination — Wyckoff phase + SMC BOS/CHoCH + HTF cross-reference.
 *
 * Extracted from the former layered/layers/bias.ts.
 * Pure function. Zero I/O.
 */

import { atr } from "../../indicators/core.js";
import { detectStructureBreaks } from "../../indicators/smc.js";
import type { WyckoffResult } from "../../indicators/wyckoff.js";
import { detectWyckoff } from "../../indicators/wyckoff.js";
import type { Candle, PivotPoint, StructureBreak } from "../../types.js";

export interface BiasResult {
  bias: "long" | "short" | "neutral";
  confidence: number;
  source: string;
  htfBias?: "long" | "short" | "neutral";
}

/** HTF confidence boost when HTF bias aligns with LTF bias. */
const HTF_ALIGN_BOOST = 0.15;

export function determineBias(
  candles: Candle[],
  idx: number,
  htfCandles: Candle[],
  pivots: PivotPoint[],
  precomputed: {
    breaks?: StructureBreak[];
    htfBreaks?: StructureBreak[];
    wyckoff?: WyckoffResult;
    htfWyckoff?: WyckoffResult;
  } = {},
): BiasResult | null {
  if (idx < 50) return null;

  const wyckoff = precomputed.wyckoff ?? detectWyckoff(candles, idx);
  const breaks =
    precomputed.breaks ?? detectStructureBreaks(candles, idx, { pivots });

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
    } else if (latestBOS && latestBOS.direction === "bearish" && !latestCHoCH) {
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
    } else if (latestBOS && latestBOS.direction === "bullish" && !latestCHoCH) {
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
  } else {
    if (latestCHoCH) {
      bias = latestCHoCH.direction === "bullish" ? "long" : "short";
      confidence = 0.5;
      source = "smc-only";
    }
  }

  // Spring invalidation
  if (
    bias === "long" &&
    wyckoff.phase === "accumulation" &&
    wyckoff.event === "spring"
  ) {
    const atrVal = atr(candles, idx, 14);
    const springLow = findSpringLow(candles, idx, pivots);
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

  // HTF cross-reference
  const htfBias = computeHTFBias(
    htfCandles,
    precomputed.htfBreaks,
    precomputed.htfWyckoff,
  );

  if (htfBias && htfBias !== "neutral") {
    if (htfBias !== bias) {
      return { bias: "neutral", confidence: 0, source: "htf-oppose", htfBias };
    }
    confidence = Math.min(confidence + HTF_ALIGN_BOOST, 1);
  }

  return htfBias === null
    ? { bias, confidence, source }
    : { bias, confidence, source, htfBias };
}

function computeHTFBias(
  htfCandles: Candle[],
  htfBreaks?: StructureBreak[],
  htfWyckoff?: WyckoffResult,
): "long" | "short" | "neutral" | null {
  if (htfCandles.length < 50) return null;

  const htfIdx = htfCandles.length - 1;
  const wyckoff = htfWyckoff ?? detectWyckoff(htfCandles, htfIdx);
  const breaks = htfBreaks ?? detectStructureBreaks(htfCandles, htfIdx);
  let htfCHoCH: (typeof breaks)[number] | undefined;
  for (let i = breaks.length - 1; i >= 0; i--) {
    const br = breaks[i]!;
    if (br.kind === "choch") {
      htfCHoCH = br;
      break;
    }
  }

  if (wyckoff.phase === "accumulation" || wyckoff.phase === "markup")
    return "long";
  if (wyckoff.phase === "distribution" || wyckoff.phase === "markdown")
    return "short";

  if (htfCHoCH) return htfCHoCH.direction === "bullish" ? "long" : "short";

  return "neutral";
}

const SPRING_LOW_LOOKBACK = 50;

function findSpringLow(
  _candles: Candle[],
  idx: number,
  pivots: PivotPoint[],
): number | null {
  const minIdx = idx - SPRING_LOW_LOOKBACK;
  let minPrice = Infinity;
  for (const p of pivots) {
    if (p.kind !== "low" || p.index > idx || p.index < minIdx) continue;
    if (p.price < minPrice) minPrice = p.price;
  }
  return minPrice === Infinity ? null : minPrice;
}
