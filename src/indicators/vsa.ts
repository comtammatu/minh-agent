/**
 * VSA Indicators — Volume Spread Analysis.
 * 8 signals: stopping-volume, test, no-supply, climax-buy (bag holding),
 *            climax-sell (buying climax), thrust (upthrust), no-demand, effort-vs-result.
 * Pure functions. Zero I/O.
 */

import type { Candle, VSASignalType } from "../types.js";

export interface VSASignal {
  type: VSASignalType;
  direction: "bullish" | "bearish";
  strength: number; // 0–1
  index: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const spread = (c: Candle) => c.h - c.l;
const body = (c: Candle) => Math.abs(c.c - c.o);
const lowerWick = (c: Candle) => Math.min(c.o, c.c) - c.l;
const upperWick = (c: Candle) => c.h - Math.max(c.o, c.c);
const isBullish = (c: Candle) => c.c > c.o;
const isBearish = (c: Candle) => c.c < c.o;

function computeVsaInputs(
  candles: Candle[],
  idx: number,
  lookback: number,
): { volRatio: number; atrValue: number } {
  let atrSeed = 0;
  let atrValue = NaN;
  let previousVolumeSum = 0;
  const volumeStart = idx - lookback;

  for (let i = 1; i <= idx; i++) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    const tr = Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    );

    if (i <= lookback) {
      atrSeed += tr;
      if (i === lookback) atrValue = atrSeed / lookback;
    } else {
      atrValue = (atrValue * (lookback - 1) + tr) / lookback;
    }

    if (i >= volumeStart && i < idx) previousVolumeSum += current.v;
  }

  const avgVolume = previousVolumeSum / lookback;
  return {
    volRatio: avgVolume === 0 ? 0 : candles[idx]?.v / avgVolume,
    atrValue,
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect all VSA signals at idx.
 */
export function detectVSA(
  candles: Candle[],
  idx: number,
  params: { lookback?: number } = {},
): VSASignal[] {
  const lb = params.lookback ?? 20;
  if (idx < lb) return [];

  const c = candles[idx]!;
  const { volRatio: volR, atrValue: atrVal } = computeVsaInputs(
    candles,
    idx,
    lb,
  );

  if (Number.isNaN(volR) || Number.isNaN(atrVal) || atrVal === 0) return [];

  const spreadR = spread(c) / atrVal;
  const bodyR = body(c) / Math.max(spread(c), 0.0001);
  const trendChange = c.c - candles[idx - lb]?.c;
  const signals: VSASignal[] = [];

  // ── Bullish signals ────────────────────────────────────────────────────────

  // Stopping volume: ultra-high vol + wide-spread bearish at bottom (selling climax)
  if (volR > 2.5 && spreadR > 1.2 && isBearish(c) && trendChange < 0) {
    signals.push({
      type: "stopping-volume",
      direction: "bullish",
      strength: Math.min(volR / 4, 1),
      index: idx,
    });
  }

  // Test: low vol + narrow spread dipping into support (testing supply)
  if (
    volR < 0.5 &&
    spreadR < 0.6 &&
    lowerWick(c) > body(c) &&
    trendChange < 0
  ) {
    signals.push({
      type: "test",
      direction: "bullish",
      strength: Math.min((1 - volR) * 0.8, 1),
      index: idx,
    });
  }

  // No supply: low vol + narrow spread + bullish close after downtrend
  if (volR < 0.4 && spreadR < 0.5 && isBullish(c) && trendChange < 0) {
    signals.push({
      type: "no-supply",
      direction: "bullish",
      strength: Math.min((1 - volR) * 0.7, 1),
      index: idx,
    });
  }

  // Climax buy (bag holding): very high vol + wide spread + closes near high (absorption)
  if (volR > 3.0 && spreadR > 1.0 && isBullish(c) && bodyR > 0.6) {
    signals.push({
      type: "climax-buy",
      direction: "bullish",
      strength: Math.min(volR / 5, 1),
      index: idx,
    });
  }

  // ── Bearish signals ────────────────────────────────────────────────────────

  // Climax sell (buying climax): ultra-high vol + wide-spread bullish at top (distribution)
  if (volR > 2.5 && spreadR > 1.2 && isBullish(c) && trendChange > 0) {
    signals.push({
      type: "climax-sell",
      direction: "bearish",
      strength: Math.min(volR / 4, 1),
      index: idx,
    });
  }

  // Thrust (upthrust): high vol + wide spread + closes near low (false breakout)
  if (volR > 1.5 && upperWick(c) > body(c) * 2 && isBearish(c)) {
    signals.push({
      type: "thrust",
      direction: "bearish",
      strength: Math.min(volR / 3, 1),
      index: idx,
    });
  }

  // No demand: low vol + narrow spread + bearish close after uptrend
  if (volR < 0.4 && spreadR < 0.5 && isBearish(c) && trendChange > 0) {
    signals.push({
      type: "no-demand",
      direction: "bearish",
      strength: Math.min((1 - volR) * 0.7, 1),
      index: idx,
    });
  }

  // ── Neutral divergence ────────────────────────────────────────────────────

  // Effort vs result: high vol but small price move (absorption / indecision)
  if (volR > 2.0 && spreadR < 0.4) {
    const dir = trendChange > 0 ? "bearish" : "bullish";
    signals.push({
      type: "effort-vs-result",
      direction: dir,
      strength: Math.min(volR * (1 - spreadR), 1),
      index: idx,
    });
  }

  return signals;
}
