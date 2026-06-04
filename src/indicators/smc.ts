/**
 * SMC Indicators — Fair Value Gaps, Order Blocks, BOS/CHoCH, Liquidity Sweeps.
 * Pure functions. Zero I/O.
 */

import type {
  Candle,
  FVG,
  KeyZone,
  OrderBlock,
  PivotPoint,
  StructureBreak,
} from "../types.js";
import { atr } from "./core.js";

// Re-export types for backward compatibility (canonical location: types.ts)
export type { PivotPoint, StructureBreak } from "../types.js";

export interface LiquiditySweep {
  direction: "bullish" | "bearish";
  level: number;
}

// ─── Fair Value Gap ────────────────────────────────────────────────────────────

/**
 * Detect FVG at idx.
 * Bullish: candles[idx-2].high < candles[idx].low
 * Bearish: candles[idx-2].low  > candles[idx].high
 */
export function detectFVG(
  candles: Candle[],
  idx: number,
  tolerance: number = 0,
): FVG | null {
  if (idx < 2) return null;
  const left = candles[idx - 2]!;
  const right = candles[idx]!;

  if (right.l > left.h - tolerance) {
    const bottom = left.h,
      top = right.l;
    return {
      top,
      bottom,
      midpoint: (top + bottom) / 2,
      bullish: true,
      index: idx,
    };
  }
  if (right.h < left.l + tolerance) {
    const top = left.l,
      bottom = right.h;
    return {
      top,
      bottom,
      midpoint: (top + bottom) / 2,
      bullish: false,
      index: idx,
    };
  }
  return null;
}

/**
 * Scan for all active (unfilled) FVGs up to upToIdx.
 * Filled = price retraces through midpoint (Consequent Encroachment).
 */
export function scanFVGs(
  candles: Candle[],
  upToIdx: number,
  tolerance: number = 0,
): FVG[] {
  if (upToIdx < 2) return [];

  const active: FVG[] = [];
  let futureMinLow = Infinity;
  let futureMaxHigh = -Infinity;

  for (let i = upToIdx; i >= 2; i--) {
    if (i < upToIdx) {
      const future = candles[i + 1]!;
      if (future.l < futureMinLow) futureMinLow = future.l;
      if (future.h > futureMaxHigh) futureMaxHigh = future.h;
    }

    const fvg = detectFVG(candles, i, tolerance);
    if (!fvg) continue;

    const filled = fvg.bullish
      ? futureMinLow <= fvg.midpoint
      : futureMaxHigh >= fvg.midpoint;
    if (!filled) active.push(fvg);
  }

  active.reverse();
  return active;
}

// ─── Order Blocks ──────────────────────────────────────────────────────────────

/**
 * Detect OBs up to upToIdx.
 * Bullish OB: bearish candle before 1.5× bullish impulse.
 * Bearish OB: bullish candle before 1.5× bearish impulse.
 */
function collectOrderBlockCandidates(
  candles: Candle[],
  upToIdx: number,
  params: { impulseMultiplier?: number; lookback?: number } = {},
): OrderBlock[] {
  const mult = params.impulseMultiplier ?? 1.5;
  const lb = params.lookback ?? 50;
  const start = Math.max(1, upToIdx - lb);
  const blocks: OrderBlock[] = [];

  for (let i = start; i < upToIdx; i++) {
    const cur = candles[i]!;
    const nxt = candles[i + 1];
    if (!nxt) continue;

    const curBody = Math.abs(cur.c - cur.o);
    const nxtBody = Math.abs(nxt.c - nxt.o);
    if (nxtBody < curBody * mult) continue;

    if (cur.c < cur.o && nxt.c > nxt.o) {
      // Bullish OB: bearish candle before bullish impulse
      blocks.push({
        top: cur.o,
        bottom: cur.l,
        bullish: true,
        index: i,
        tested: false,
      });
    } else if (cur.c > cur.o && nxt.c < nxt.o) {
      // Bearish OB: bullish candle before bearish impulse
      blocks.push({
        top: cur.h,
        bottom: cur.o,
        bullish: false,
        index: i,
        tested: false,
      });
    }
  }

  return blocks;
}

function markOrderBlocksTested(
  candles: Candle[],
  upToIdx: number,
  blocks: OrderBlock[],
): void {
  for (const ob of blocks) {
    for (let i = ob.index + 2; i <= upToIdx; i++) {
      const c = candles[i]!;
      if (ob.bullish && c.l <= ob.top && c.l >= ob.bottom) {
        ob.tested = true;
        break;
      }
      if (!ob.bullish && c.h >= ob.bottom && c.h <= ob.top) {
        ob.tested = true;
        break;
      }
    }
  }
}

export function detectOrderBlocks(
  candles: Candle[],
  upToIdx: number,
  params: { impulseMultiplier?: number; lookback?: number } = {},
): OrderBlock[] {
  const blocks = collectOrderBlockCandidates(candles, upToIdx, params);

  // Mark tested (price revisited zone)
  markOrderBlocksTested(candles, upToIdx, blocks);
  return blocks;
}

// ─── Pivot swing points ────────────────────────────────────────────────────────

/**
 * Find raw pivot highs/lows. A pivot high at i requires i to have the highest high
 * among [i-lookback .. i+lookback].
 */
export function findPivots(
  candles: Candle[],
  upToIdx: number,
  lookback: number = 3,
  tolerance: number = 0,
): PivotPoint[] {
  const pts: PivotPoint[] = [];
  const endIdx = upToIdx - lookback;
  if (endIdx < lookback) return pts;

  for (let i = lookback; i <= endIdx; i++) {
    const c = candles[i]!;
    const high = c.h;
    const low = c.l;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      const left = candles[i - j]!;
      const right = candles[i + j]!;

      if (isHigh && (high < left.h - tolerance || high < right.h - tolerance)) {
        isHigh = false;
      }
      if (isLow && (low > left.l + tolerance || low > right.l + tolerance)) {
        isLow = false;
      }
      if (!isHigh && !isLow) break;
    }

    if (isHigh) pts.push({ kind: "high", price: high, index: i });
    if (isLow) pts.push({ kind: "low", price: low, index: i });
  }

  // Points are emitted in ascending index order because `i` increments monotonically.
  return pts;
}

// ─── BOS / CHoCH ──────────────────────────────────────────────────────────────

/**
 * Detect Break of Structure (BOS) or Change of Character (CHoCH) at upToIdx.
 * BOS = continuation; CHoCH = reversal signal.
 */
export function detectStructureBreaks(
  candles: Candle[],
  upToIdx: number,
  params: {
    swingLookback?: number;
    tolerance?: number;
    minPivotSpacing?: number;
    pivots?: PivotPoint[];
  } = {},
): StructureBreak[] {
  const swingLookback = params.swingLookback ?? 3;
  const tol = params.tolerance ?? 0;
  const minSpacing = params.minPivotSpacing ?? 5;
  if (upToIdx < swingLookback * 2) return [];
  const pivots =
    params.pivots ?? findPivots(candles, upToIdx, swingLookback, tol);
  const breaks: StructureBreak[] = [];

  // We only need the latest 3 clustered pivots per side. Reverse scan lets us
  // stop once we have enough recent clusters instead of processing the full history.
  const collectRecentClusteredPivots = (kind: "high" | "low"): PivotPoint[] => {
    const clustered: PivotPoint[] = [];
    let clusterBest: PivotPoint | null = null;

    for (let i = pivots.length - 1; i >= 0; i--) {
      const pivot = pivots[i]!;
      if (pivot.kind !== kind) continue;

      if (clusterBest === null) {
        clusterBest = pivot;
        continue;
      }

      if (clusterBest.index - pivot.index >= minSpacing) {
        clustered.push(clusterBest);
        if (clustered.length === 3) break;
        clusterBest = pivot;
      } else if (
        (kind === "high" && pivot.price > clusterBest.price) ||
        (kind === "low" && pivot.price < clusterBest.price)
      ) {
        clusterBest = pivot;
      }
    }

    if (clusterBest !== null && clustered.length < 3)
      clustered.push(clusterBest);
    clustered.reverse();
    return clustered;
  };
  const highs = collectRecentClusteredPivots("high");
  const lows = collectRecentClusteredPivots("low");
  if (highs.length < 2 || lows.length < 2) return breaks;

  // Require minimum price distance between pivots (0.5 ATR) to avoid noise breaks
  const curAtr = atr(candles, upToIdx, 14);
  const minPriceDist = !Number.isNaN(curAtr) ? curAtr * 0.5 : 0;

  const c = candles[upToIdx]!;
  const prevHigh = highs[highs.length - 2]!;
  const prevLow = lows[lows.length - 2]!;
  const lastHigh = highs[highs.length - 1]!;
  const lastLow = lows[lows.length - 1]!;

  // Bullish BOS: close > prev swing high (with tolerance)
  if (
    c.c > prevHigh.price - tol &&
    Math.abs(c.c - prevHigh.price) >= minPriceDist * 0.3
  ) {
    const isCHoCH = lastLow.price < lows[Math.max(0, lows.length - 3)]?.price;
    breaks.push({
      kind: isCHoCH ? "choch" : "bos",
      direction: "bullish",
      level: prevHigh.price,
      index: upToIdx,
    });
  }

  // Bearish BOS: close < prev swing low (with tolerance)
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
      index: upToIdx,
    });
  }

  return breaks;
}

// ─── Liquidity sweep ──────────────────────────────────────────────────────────

/**
 * Detect liquidity sweep at idx: wick pierces recent high/low then closes back inside.
 * wickRatio = wick must be > ratio of total candle range.
 */
export function detectLiquiditySweep(
  candles: Candle[],
  idx: number,
  params: { lookback?: number; wickRatio?: number } = {},
): LiquiditySweep | null {
  const lb = params.lookback ?? 20;
  const wr = params.wickRatio ?? 0.6;
  if (idx < lb) return null;

  const c = candles[idx]!;
  const range = c.h - c.l;
  if (range === 0) return null;

  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  // If neither wick can satisfy the minimum ratio, the lookback scan cannot change the outcome.
  if (lowerWick / range <= wr && upperWick / range <= wr) return null;

  let recentLow = Infinity,
    recentHigh = -Infinity;
  for (let i = idx - lb; i < idx; i++) {
    const x = candles[i]!;
    if (x.l < recentLow) recentLow = x.l;
    if (x.h > recentHigh) recentHigh = x.h;
  }

  if (c.l < recentLow && c.c > recentLow && lowerWick / range > wr) {
    return { direction: "bullish", level: recentLow };
  }

  if (c.h > recentHigh && c.c < recentHigh && upperWick / range > wr) {
    return { direction: "bearish", level: recentHigh };
  }

  return null;
}

// ─── Key zone compilation ─────────────────────────────────────────────────────

interface RawZone {
  top: number;
  bottom: number;
  kind: "demand" | "supply";
  origin: string;
  sourceIdx: number;
}

function appendOrderBlockRawZones(
  candles: Candle[],
  upToIdx: number,
  demandRaw: RawZone[],
  supplyRaw: RawZone[],
  params: { impulseMultiplier?: number; lookback?: number } = {},
): void {
  const mult = params.impulseMultiplier ?? 1.5;
  const lb = params.lookback ?? 50;
  const start = Math.max(1, upToIdx - lb);

  for (let i = start; i < upToIdx; i++) {
    const cur = candles[i]!;
    const nxt = candles[i + 1];
    if (!nxt) continue;

    const curBody = Math.abs(cur.c - cur.o);
    const nxtBody = Math.abs(nxt.c - nxt.o);
    if (nxtBody < curBody * mult) continue;

    if (cur.c < cur.o && nxt.c > nxt.o) {
      demandRaw.push({
        top: cur.o,
        bottom: cur.l,
        kind: "demand",
        origin: "order-block",
        sourceIdx: i,
      });
    } else if (cur.c > cur.o && nxt.c < nxt.o) {
      supplyRaw.push({
        top: cur.h,
        bottom: cur.o,
        kind: "supply",
        origin: "order-block",
        sourceIdx: i,
      });
    }
  }
}

function mergeAndRank(
  raw: RawZone[],
  kind: "demand" | "supply",
  candles: Candle[],
  upToIdx: number,
  mergeGap: number,
  max: number,
): KeyZone[] {
  if (raw.length === 0) return [];
  raw.sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);

  interface MergedZone {
    top: number;
    bottom: number;
    origin: string;
    originCount: number;
    latestSourceIdx: number;
  }

  const merged: MergedZone[] = [];
  let cur: MergedZone = {
    top: raw[0]?.top,
    bottom: raw[0]?.bottom,
    origin: raw[0]?.origin,
    originCount: 1,
    latestSourceIdx: raw[0]?.sourceIdx,
  };

  for (let i = 1; i < raw.length; i++) {
    const z = raw[i]!;
    const curMid = (cur.top + cur.bottom) / 2;
    const zMid = (z.top + z.bottom) / 2;

    if (Math.abs(curMid - zMid) <= mergeGap) {
      cur.top = Math.max(cur.top, z.top);
      cur.bottom = Math.min(cur.bottom, z.bottom);
      cur.originCount++;
      cur.latestSourceIdx = Math.max(cur.latestSourceIdx, z.sourceIdx);
    } else {
      merged.push(cur);
      cur = {
        top: z.top,
        bottom: z.bottom,
        origin: z.origin,
        originCount: 1,
        latestSourceIdx: z.sourceIdx,
      };
    }
  }
  merged.push(cur);

  const zones: KeyZone[] = [];
  const pushTopZone = (zone: KeyZone): void => {
    let insertAt = zones.length;
    while (insertAt > 0 && zones[insertAt - 1]?.strength < zone.strength)
      insertAt--;
    zones.splice(insertAt, 0, zone);
    if (zones.length > max) zones.length = max;
  };

  for (const zone of merged) {
    let touches = 0;
    let broken = false;

    for (let i = zone.latestSourceIdx + 1; i <= upToIdx; i++) {
      const c = candles[i]!;
      if (kind === "demand") {
        if (c.c < zone.bottom) {
          broken = true;
          break;
        }
        if (c.l <= zone.top && c.l >= zone.bottom) touches++;
      } else {
        if (c.c > zone.top) {
          broken = true;
          break;
        }
        if (c.h >= zone.bottom && c.h <= zone.top) touches++;
      }
    }

    if (broken) continue;

    const sourceScore = Math.min(zone.originCount / 2, 1); // easier to reach 1.0 (2 sources = max)
    const recency = Math.min((zone.latestSourceIdx + 1) / (upToIdx + 1), 1); // more recent creation = higher
    // Fresh untested zones are STRONGER (institutional zones — first touch is the reaction)
    // Multi-tested zones are weaker (diminishing returns each retest)
    const touchScore = touches === 0 ? 1.0 : touches === 1 ? 0.7 : 0.4;
    const strength = Math.min(
      sourceScore * 0.35 + recency * 0.3 + touchScore * 0.35,
      1,
    );
    pushTopZone({
      type: kind,
      top: zone.top,
      bottom: zone.bottom,
      strength,
      origin: zone.origin,
      createdAtIdx: zone.latestSourceIdx,
    });
  }

  return zones;
}

export function compileKeyZones(
  candles: Candle[],
  upToIdx: number,
  tolerance: number = 0,
  params: { pivots?: PivotPoint[]; fvgs?: FVG[] } = {},
): { demandZones: KeyZone[]; supplyZones: KeyZone[] } {
  if (upToIdx < 30) return { demandZones: [], supplyZones: [] };

  const curATR = atr(candles, upToIdx, 14);
  if (Number.isNaN(curATR) || curATR === 0)
    return { demandZones: [], supplyZones: [] };

  const thick = curATR * 0.3;
  const mergeGap = curATR * 0.5;
  const MAX_ZONES = 8;

  const demandRaw: RawZone[] = [];
  const supplyRaw: RawZone[] = [];

  appendOrderBlockRawZones(candles, upToIdx, demandRaw, supplyRaw, {
    lookback: 50,
  });

  const pivots = params.pivots ?? findPivots(candles, upToIdx, 3, tolerance);
  for (const p of pivots) {
    if (p.kind === "low") {
      demandRaw.push({
        top: p.price + thick,
        bottom: p.price,
        kind: "demand",
        origin: "swing",
        sourceIdx: p.index,
      });
    } else {
      supplyRaw.push({
        top: p.price,
        bottom: p.price - thick,
        kind: "supply",
        origin: "swing",
        sourceIdx: p.index,
      });
    }
  }

  const fvgs = params.fvgs ?? scanFVGs(candles, upToIdx, tolerance);
  for (const fvg of fvgs) {
    if (fvg.bullish) {
      demandRaw.push({
        top: fvg.top,
        bottom: fvg.bottom,
        kind: "demand",
        origin: "fvg",
        sourceIdx: fvg.index,
      });
    } else {
      supplyRaw.push({
        top: fvg.top,
        bottom: fvg.bottom,
        kind: "supply",
        origin: "fvg",
        sourceIdx: fvg.index,
      });
    }
  }

  const demandZones = mergeAndRank(
    demandRaw,
    "demand",
    candles,
    upToIdx,
    mergeGap,
    MAX_ZONES,
  );
  const supplyZones = mergeAndRank(
    supplyRaw,
    "supply",
    candles,
    upToIdx,
    mergeGap,
    MAX_ZONES,
  );

  const price = candles[upToIdx]?.c;
  demandZones.sort(
    (a, b) =>
      Math.abs(price - (a.top + a.bottom) / 2) -
      Math.abs(price - (b.top + b.bottom) / 2),
  );
  supplyZones.sort(
    (a, b) =>
      Math.abs(price - (a.top + a.bottom) / 2) -
      Math.abs(price - (b.top + b.bottom) / 2),
  );

  return { demandZones, supplyZones };
}

// ─── ICT Breaker Block ──────────────────────────────────────────────────────

export interface BreakerBlock {
  top: number;
  bottom: number;
  /** Original OB was bullish → broken → now acts as bearish resistance (and vice versa). */
  type: "demand" | "supply";
  index: number; // index where the OB was broken
  originalOBIndex: number;
}

/**
 * Detect Breaker Blocks — ICT concept: when an OB is broken (price closes through it),
 * the OB flips to become an opposition zone.
 *
 * Bullish OB broken by bearish close below → becomes Supply (Bearish Breaker)
 * Bearish OB broken by bullish close above → becomes Demand (Bullish Breaker)
 *
 * Breaker Blocks are high-probability reaction zones because they represent
 * failed institutional positions — when revisited, remaining orders provide support/resistance.
 */
export function detectBreakerBlocks(
  candles: Candle[],
  upToIdx: number,
  params: { lookback?: number } = {},
): BreakerBlock[] {
  const obs = collectOrderBlockCandidates(candles, upToIdx, params);
  const validBreakers: BreakerBlock[] = [];

  for (const ob of obs) {
    let breakIndex = -1;

    for (let i = ob.index + 2; i <= upToIdx; i++) {
      const c = candles[i]!;

      if (ob.bullish) {
        if (breakIndex < 0) {
          // Bullish OB broken: price closes BELOW the OB bottom → flips to Supply
          if (c.c < ob.bottom) breakIndex = i;
        } else if (c.c > ob.top) {
          // Broken again after inversion → invalid.
          breakIndex = -1;
          break;
        }
      } else {
        if (breakIndex < 0) {
          // Bearish OB broken: price closes ABOVE the OB top → flips to Demand
          if (c.c > ob.top) breakIndex = i;
        } else if (c.c < ob.bottom) {
          breakIndex = -1;
          break;
        }
      }
    }

    if (breakIndex >= 0) {
      validBreakers.push({
        top: ob.top,
        bottom: ob.bottom,
        type: ob.bullish ? "supply" : "demand",
        index: breakIndex,
        originalOBIndex: ob.index,
      });
    }
  }
  return validBreakers;
}

// ─── ICT Inversion FVG ──────────────────────────────────────────────────────

export interface InversionFVG {
  top: number;
  bottom: number;
  midpoint: number;
  /** After inversion: bullish FVG filled → flips to bearish (supply), and vice versa. */
  type: "demand" | "supply";
  index: number; // index where the FVG was inverted (fully filled)
  originalFVGIndex: number;
}

/**
 * Detect Inversion FVGs — ICT 2023 model: when price completely fills an FVG
 * (trades through it), the gap flips type and becomes a new reaction zone.
 *
 * Bullish FVG fully filled (price closes below bottom) → becomes Supply zone
 * Bearish FVG fully filled (price closes above top) → becomes Demand zone
 *
 * Inversion FVGs are powerful because they mark where inefficiency was resolved —
 * the filled gap now acts as a level where unfilled orders remain.
 */
export function detectInversionFVGs(
  candles: Candle[],
  upToIdx: number,
  tolerance: number = 0,
): InversionFVG[] {
  const validInversions: InversionFVG[] = [];

  for (let i = 2; i <= upToIdx; i++) {
    const left = candles[i - 2]!;
    const right = candles[i]!;
    let bullish = false;
    let top = 0;
    let bottom = 0;
    let midpoint = 0;

    if (right.l > left.h - tolerance) {
      bullish = true;
      bottom = left.h;
      top = right.l;
      midpoint = (top + bottom) / 2;
    } else if (right.h < left.l + tolerance) {
      top = left.l;
      bottom = right.h;
      midpoint = (top + bottom) / 2;
    } else {
      continue;
    }

    let inversionIndex = -1;
    for (let j = i + 1; j <= upToIdx; j++) {
      const c = candles[j]!;

      if (bullish) {
        if (inversionIndex < 0) {
          // Bullish FVG fully filled: price closes below the FVG bottom
          if (c.c < bottom) inversionIndex = j;
        } else if (c.c > top) {
          inversionIndex = -1;
          break;
        }
      } else {
        if (inversionIndex < 0) {
          // Bearish FVG fully filled: price closes above the FVG top
          if (c.c > top) inversionIndex = j;
        } else if (c.c < bottom) {
          inversionIndex = -1;
          break;
        }
      }
    }

    if (inversionIndex >= 0) {
      validInversions.push({
        top,
        bottom,
        midpoint,
        type: bullish ? "supply" : "demand",
        index: inversionIndex,
        originalFVGIndex: i,
      });
    }
  }
  return validInversions;
}

// ─── ICT HTF Structure Bias ──────────────────────────────────────────────────

/**
 * Determine Higher Timeframe structure bias from swing sequence.
 * ICT rule: HTF dictates direction — HH+HL = bullish, LH+LL = bearish.
 *
 * Returns 'bullish' | 'bearish' | 'neutral' with a confidence score.
 * Requires at least 4 pivots to determine swing sequence.
 */
export function htfStructureBias(
  candles: Candle[],
  upToIdx: number,
  params: {
    swingLookback?: number;
    tolerance?: number;
    pivots?: PivotPoint[];
  } = {},
): { bias: "bullish" | "bearish" | "neutral"; confidence: number } {
  const tol = params.tolerance ?? 0;
  const pivots =
    params.pivots ??
    findPivots(candles, upToIdx, params.swingLookback ?? 5, tol);
  const highs: PivotPoint[] = [];
  const lows: PivotPoint[] = [];
  for (const pivot of pivots) {
    if (pivot.kind === "high") highs.push(pivot);
    else lows.push(pivot);
  }

  if (highs.length < 2 || lows.length < 2)
    return { bias: "neutral", confidence: 0 };

  let hhCount = 0,
    hlCount = 0,
    lhCount = 0,
    llCount = 0;

  for (let i = Math.max(1, highs.length - 2); i < highs.length; i++) {
    if (highs[i]?.price > highs[i - 1]?.price) hhCount++;
    else lhCount++;
  }
  for (let i = Math.max(1, lows.length - 2); i < lows.length; i++) {
    if (lows[i]?.price > lows[i - 1]?.price) hlCount++;
    else llCount++;
  }

  // Also check BOS/CHoCH for confirmation
  const breaks = detectStructureBreaks(candles, upToIdx, { ...params, pivots });
  const recentBreak = breaks.length > 0 ? breaks[breaks.length - 1]! : null;

  // Bullish: HH + HL sequence
  if (hhCount > 0 && hlCount > 0) {
    const conf = recentBreak?.direction === "bullish" ? 0.9 : 0.7;
    return { bias: "bullish", confidence: conf };
  }

  // Bearish: LH + LL sequence
  if (lhCount > 0 && llCount > 0) {
    const conf = recentBreak?.direction === "bearish" ? 0.9 : 0.7;
    return { bias: "bearish", confidence: conf };
  }

  // Mixed — use BOS direction as tiebreaker
  if (recentBreak) {
    return { bias: recentBreak.direction, confidence: 0.5 };
  }

  return { bias: "neutral", confidence: 0 };
}

// ─── ICT Displacement Detection ─────────────────────────────────────────────

/**
 * Detect displacement candles — strong momentum candles that create BOS/CHoCH.
 * ICT: Displacement = large body candle (>1.5× ATR) that breaks structure.
 * These candles are the source of institutional order flow.
 */
export function isDisplacementCandle(
  candles: Candle[],
  idx: number,
  atrVal: number,
  minBodyAtrMult: number = 1.0,
): boolean {
  if (idx < 0 || idx >= candles.length) return false;
  const c = candles[idx]!;
  const bodySize = Math.abs(c.c - c.o);
  return bodySize > atrVal * minBodyAtrMult;
}

// ─── ICT Equal Highs/Lows (Liquidity Pools) ────────────────────────────────

export interface LiquidityPool {
  level: number;
  type: "bsl" | "ssl"; // Buy-side / Sell-side liquidity
  count: number; // how many equal levels cluster here
  index: number; // most recent contributing pivot index
}

/**
 * Detect equal highs and equal lows — ICT liquidity pools.
 * BSL (Buy-Side Liquidity): cluster of equal highs = stop losses above
 * SSL (Sell-Side Liquidity): cluster of equal lows = stop losses below
 *
 * Smart money targets these pools for stop hunts before the real move.
 */
export function findLiquidityPools(
  candles: Candle[],
  upToIdx: number,
  params: {
    tolerance?: number;
    minCluster?: number;
    lookback?: number;
    atrValue?: number;
  } = {},
): LiquidityPool[] {
  const tol = params.tolerance ?? 0;
  const minCluster = params.minCluster ?? 2;
  const pivots = findPivots(candles, upToIdx, 3, tol);
  const pools: LiquidityPool[] = [];

  const highs: PivotPoint[] = [];
  const lows: PivotPoint[] = [];
  for (const pivot of pivots) {
    if (pivot.kind === "high") highs.push(pivot);
    else lows.push(pivot);
  }

  const curATR = params.atrValue ?? atr(candles, upToIdx, 14);
  if (Number.isNaN(curATR) || curATR <= 0) return pools;
  const clusterTol = curATR * 0.15; // 15% of ATR = "equal" level

  const buildPools = (points: PivotPoint[], type: "bsl" | "ssl"): void => {
    if (points.length < minCluster) return;
    if (points.length <= 24) {
      for (let i = 0; i < points.length; i++) {
        const base = points[i]!;
        let count = 1;
        let maxIdx = base.index;
        for (let j = i + 1; j < points.length; j++) {
          const other = points[j]!;
          if (Math.abs(other.price - base.price) <= clusterTol) {
            count++;
            if (other.index > maxIdx) maxIdx = other.index;
          }
        }
        if (count >= minCluster) {
          pools.push({
            level: base.price,
            type,
            count,
            index: maxIdx,
          });
        }
      }
      return;
    }

    const sortedPrices = new Array<number>(points.length);
    for (let i = 0; i < points.length; i++) {
      sortedPrices[i] = points[i]?.price;
    }
    sortedPrices.sort((a, b) => a - b);
    const uniquePrices: number[] = [];
    for (const price of sortedPrices) {
      if (
        uniquePrices.length === 0 ||
        uniquePrices[uniquePrices.length - 1] !== price
      ) {
        uniquePrices.push(price);
      }
    }

    const lowerBound = (value: number): number => {
      let lo = 0;
      let hi = uniquePrices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (uniquePrices[mid]! < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const upperBound = (value: number): number => {
      let lo = 0;
      let hi = uniquePrices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (uniquePrices[mid]! <= value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const bit = new Array<number>(uniquePrices.length + 1).fill(0);
    const addCount = (coord: number): void => {
      for (let i = coord + 1; i < bit.length; i += i & -i) bit[i]! += 1;
    };
    const prefixCount = (coord: number): number => {
      let sum = 0;
      for (let i = coord + 1; i > 0; i -= i & -i) sum += bit[i]!;
      return sum;
    };
    const rangeCount = (left: number, right: number): number => {
      if (left > right) return 0;
      return prefixCount(right) - (left > 0 ? prefixCount(left - 1) : 0);
    };

    let size = 1;
    while (size < uniquePrices.length) size <<= 1;
    const seg = new Array<number>(size * 2).fill(-1);
    const updateMax = (coord: number, value: number): void => {
      let pos = coord + size;
      if (value > seg[pos]!) seg[pos] = value;
      pos >>= 1;
      while (pos > 0) {
        const next = Math.max(seg[pos * 2]!, seg[pos * 2 + 1]!);
        if (next === seg[pos]) break;
        seg[pos] = next;
        pos >>= 1;
      }
    };
    const rangeMax = (left: number, right: number): number => {
      if (left > right) return -1;
      let best = -1;
      let l = left + size;
      let r = right + size;
      while (l <= r) {
        if ((l & 1) === 1) {
          if (seg[l]! > best) best = seg[l]!;
          l++;
        }
        if ((r & 1) === 0) {
          if (seg[r]! > best) best = seg[r]!;
          r--;
        }
        l >>= 1;
        r >>= 1;
      }
      return best;
    };

    const nextPools: LiquidityPool[] = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const point = points[i]!;
      const left = lowerBound(point.price - clusterTol);
      const right = upperBound(point.price + clusterTol) - 1;
      const laterCount = rangeCount(left, right);
      if (laterCount + 1 >= minCluster) {
        const laterMaxIdx = rangeMax(left, right);
        nextPools.push({
          level: point.price,
          type,
          count: laterCount + 1,
          index: laterMaxIdx > point.index ? laterMaxIdx : point.index,
        });
      }

      const coord = lowerBound(point.price);
      addCount(coord);
      updateMax(coord, point.index);
    }

    nextPools.reverse();
    for (const pool of nextPools) pools.push(pool);
  };

  buildPools(highs, "bsl");
  buildPools(lows, "ssl");

  return pools;
}

// ─── ICT AMD (Power of Three) ───────────────────────────────────────────────

export interface SessionRange {
  high: number;
  low: number;
  startIdx: number;
  endIdx: number;
  barCount: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function utcHour(timestampMs: number): number {
  return Math.floor(timestampMs / MS_PER_HOUR) % 24;
}

function utcDayId(timestampMs: number): number {
  return Math.floor(timestampMs / MS_PER_DAY);
}

/**
 * Detect the Accumulation range from candles within a session window.
 * Scans backwards from `idx` to find candles within [startHourUTC, endHourUTC).
 * Returns the high/low of candles in that window = the session's accumulation range.
 *
 * Pure function. Zero I/O.
 */
export function detectSessionRange(
  candles: Candle[],
  idx: number,
  startHourUTC: number,
  endHourUTC: number,
): SessionRange | null {
  let high = -Infinity;
  let low = Infinity;
  let startIdx = -1;
  let endIdx = -1;
  let count = 0;

  // Scan backwards to find candles within the session window (same day as idx candle)
  const refTimestamp = candles[idx]?.t;
  const refDay = utcDayId(refTimestamp);
  const minTimestamp = refTimestamp - MS_PER_DAY * 1.5;

  for (let i = idx; i >= Math.max(0, idx - 200); i--) {
    const c = candles[i]!;
    if (c.t < minTimestamp) break; // too far back

    const hour = utcHour(c.t);
    const sameDay = utcDayId(c.t) === refDay;

    // Handle ranges that don't cross midnight (e.g., 0-7)
    let inWindow: boolean;
    if (startHourUTC <= endHourUTC) {
      inWindow = hour >= startHourUTC && hour < endHourUTC && sameDay;
    } else {
      // Crosses midnight (e.g., 22-2)
      inWindow = hour >= startHourUTC || hour < endHourUTC;
    }

    if (!inWindow) continue;

    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
    if (startIdx === -1 || i < startIdx) startIdx = i;
    if (endIdx === -1 || i > endIdx) endIdx = i;
    count++;
  }

  if (count < 3 || high === -Infinity) return null;
  return { high, low, startIdx, endIdx, barCount: count };
}

export interface JudasSwing {
  direction: "bullish" | "bearish"; // direction of the REAL move (opposite of fake)
  sweepLevel: number; // price level of the fake breakout
  sweepIdx: number; // candle that swept the range
  reversalIdx: number; // candle that confirmed reversal
  rangeHigh: number;
  rangeLow: number;
}

/**
 * Detect Judas Swing — ICT's fake breakout beyond accumulation range.
 *
 * Bullish Judas: price sweeps BELOW range low, then closes back inside → real move is UP
 * Bearish Judas: price sweeps ABOVE range high, then closes back inside → real move is DOWN
 *
 * Requires:
 * 1. Session range (accumulation) exists
 * 2. Candle(s) after range end sweep beyond range boundary
 * 3. Subsequent candle closes back inside range (reversal)
 *
 * Pure function. Zero I/O.
 */
export function detectJudasSwing(
  candles: Candle[],
  idx: number,
  range: SessionRange,
  tolerance: number = 0,
): JudasSwing | null {
  if (idx <= range.endIdx) return null;

  // Scan candles after range for sweep + reversal
  const scanStart = range.endIdx + 1;
  const scanEnd = Math.min(idx, range.endIdx + 30); // max 30 bars after range

  let bearishSweepIdx = -1; // swept above range high
  let bullishSweepIdx = -1; // swept below range low
  let bullishReversalIdx = -1;
  let bearishReversalIdx = -1;
  let bullishSweepLevel = 0;
  let bearishSweepLevel = 0;

  for (let i = scanStart; i <= scanEnd; i++) {
    const c = candles[i]!;

    // Bearish Judas: wick above range high (sweep BSL)
    if (bearishSweepIdx === -1 && c.h > range.high + tolerance) {
      bearishSweepIdx = i;
      bearishSweepLevel = c.h;
    }

    // Bullish Judas: wick below range low (sweep SSL)
    if (bullishSweepIdx === -1 && c.l < range.low - tolerance) {
      bullishSweepIdx = i;
      bullishSweepLevel = c.l;
    }

    // Reversal can happen on the sweep candle itself, so these checks happen
    // after sweep registration in the same pass.
    if (
      bullishSweepIdx !== -1 &&
      bullishReversalIdx === -1 &&
      c.c > range.low &&
      c.c > c.o
    ) {
      bullishReversalIdx = i;
    }
    if (
      bearishSweepIdx !== -1 &&
      bearishReversalIdx === -1 &&
      c.c < range.high &&
      c.c < c.o
    ) {
      bearishReversalIdx = i;
    }
  }

  // Preserve previous priority: bullish reversal wins if both sides qualify.
  if (bullishReversalIdx !== -1) {
    return {
      direction: "bullish",
      sweepLevel: bullishSweepLevel,
      sweepIdx: bullishSweepIdx,
      reversalIdx: bullishReversalIdx,
      rangeHigh: range.high,
      rangeLow: range.low,
    };
  }
  if (bearishReversalIdx !== -1) {
    return {
      direction: "bearish",
      sweepLevel: bearishSweepLevel,
      sweepIdx: bearishSweepIdx,
      reversalIdx: bearishReversalIdx,
      rangeHigh: range.high,
      rangeLow: range.low,
    };
  }

  return null;
}

// ─── ICT LTF Confirming Break ───────────────────────────────────────────────

/**
 * Find a confirming BOS/CHoCH within the last N bars matching expected direction.
 * ICT drill-down: after price reaches HTF POI, look for LTF structure shift.
 * Prefers CHoCH (reversal = stronger confirmation) over BOS (continuation).
 *
 * Pure function. Zero I/O.
 */
export function findConfirmingBreak(
  candles: Candle[],
  idx: number,
  lookback: number,
  expectedDirection: "bullish" | "bearish",
  tolerance: number,
): StructureBreak | null {
  let latestBos: StructureBreak | null = null;
  const startIdx = Math.max(0, idx - lookback);

  for (let i = idx; i >= startIdx; i--) {
    const breaks = detectStructureBreaks(candles, i, { tolerance });
    for (const b of breaks) {
      if (b.direction !== expectedDirection) continue;
      // Scanning backwards means the first CHoCH we see is the latest one,
      // which already matches the previous "prefer newest CHoCH over any BOS" rule.
      if (b.kind === "choch") {
        return b;
      }
      if (latestBos === null) latestBos = b;
    }
  }

  return latestBos;
}

// ─── S&D re-exports (canonical location: supply-demand.ts) ────────────────────
export { oteZone, premiumDiscount } from "./supply-demand.js";
