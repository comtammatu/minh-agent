/**
 * Order Flow indicators — pure functions for delta, book, and funding confirmation.
 *
 * Used by Layer 4 (confirm) to boost/penalize zones based on order flow data.
 * All functions are pure: no I/O, no side effects, deterministic.
 */

import {
  BOOK_IMBALANCE_THRESHOLD,
  DELTA_STRONG_THRESHOLD,
  FUNDING_CONTRARIAN_THRESHOLD,
  OI_SPIKE_THRESHOLD,
  VP_BINS,
  VP_VALUE_AREA_PCT,
} from "../config.js";
import type {
  Candle,
  DeltaState,
  KeyZone,
  SignalSide,
  VolumeProfile,
} from "../types.js";

// ── Delta ───────────────────────────────────────────────────────────────────

export interface RawTrade {
  side: "A" | "B"; // A = seller aggressor (sell), B = buyer aggressor (buy)
  size: number;
}

/**
 * Compute delta from raw trades.
 * B (buyer aggressor) = buy volume, A (seller aggressor) = sell volume.
 */
export function computeDelta(trades: RawTrade[]): {
  delta: number;
  buyVol: number;
  sellVol: number;
} {
  let buyVol = 0;
  let sellVol = 0;

  for (const t of trades) {
    if (t.side === "B") buyVol += t.size;
    else sellVol += t.size;
  }

  return { delta: buyVol - sellVol, buyVol, sellVol };
}

/**
 * Cumulative delta over last N bars.
 * Returns sum of delta values. If fewer than N bars, uses all available.
 */
export function cumulativeDelta(history: DeltaState[], n: number): number {
  if (history.length === 0) return 0;
  let cum = 0;
  const start = Math.max(0, history.length - n);
  for (let i = start; i < history.length; i++) cum += history[i]?.delta;
  return cum;
}

/**
 * Delta confirmation boost for a zone.
 *
 * - Positive delta at demand zone → +0.15 (aggressive buying at support)
 * - Negative delta at supply zone → +0.15 (aggressive selling at resistance)
 * - Strong divergence (opposite) → -0.10
 * - Weak/neutral → 0
 *
 * Range: -0.10 to +0.15
 */
export function deltaConfirm(delta: DeltaState | null, zone: KeyZone): number {
  if (!delta) return 0;

  const total = delta.buyVol + delta.sellVol;
  if (total === 0) return 0;

  const ratio = Math.abs(delta.delta) / total;

  if (zone.type === "demand") {
    // Expect buying at demand
    if (delta.delta > 0 && ratio >= DELTA_STRONG_THRESHOLD) return 0.15;
    if (delta.delta > 0) return 0.05;
    if (delta.delta < 0 && ratio >= DELTA_STRONG_THRESHOLD) return -0.1; // divergence
  } else {
    // Expect selling at supply
    if (delta.delta < 0 && ratio >= DELTA_STRONG_THRESHOLD) return 0.15;
    if (delta.delta < 0) return 0.05;
    if (delta.delta > 0 && ratio >= DELTA_STRONG_THRESHOLD) return -0.1; // divergence
  }

  return 0;
}

// ── Order Book ──────────────────────────────────────────────────────────────

/**
 * Compute bid/ask imbalance ratio.
 * Returns (bidSize - askSize) / (bidSize + askSize).
 * Range: -1 (all asks) to +1 (all bids). 0 = balanced.
 */
export function bidAskImbalance(
  bids: [number, number][],
  asks: [number, number][],
): number {
  let bidSize = 0;
  let askSize = 0;

  for (const [, sz] of bids) bidSize += sz;
  for (const [, sz] of asks) askSize += sz;

  const total = bidSize + askSize;
  if (total === 0) return 0;

  return (bidSize - askSize) / total;
}

/**
 * Book confirmation boost for a zone.
 *
 * - Bid-heavy at demand → +0.10 (institutional support)
 * - Ask-heavy at supply → +0.10 (institutional resistance)
 * - Strong imbalance (absorption pattern) → +0.20
 * - Counter-imbalance → -0.10
 * - Neutral → 0
 *
 * Range: -0.10 to +0.20
 */
export function bookConfirm(imbalance: number, zone: KeyZone): number {
  if (zone.type === "demand") {
    // Expect bid-heavy at demand
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD * 2) return 0.2; // absorption
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD) return 0.1;
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD) return -0.1; // counter
  } else {
    // Expect ask-heavy at supply
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD * 2) return 0.2; // absorption
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD) return 0.1;
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD) return -0.1; // counter
  }

  return 0;
}

// ── Funding Rate ────────────────────────────────────────────────────────────

/**
 * Funding rate contrarian boost.
 *
 * - Negative funding + long bias → +0.10 (shorts paying longs — contrarian)
 * - Positive funding + short bias → +0.10 (longs paying shorts — contrarian)
 * - Otherwise → 0
 *
 * Range: 0 to +0.10
 */
export function fundingConfirm(rate: number | null, side: SignalSide): number {
  if (rate === null || rate === 0) return 0;

  // Long: negative funding (shorts pay longs) → contrarian bullish
  if (side === "long" && rate < -FUNDING_CONTRARIAN_THRESHOLD) return 0.1;
  // Short: positive funding (longs pay shorts) → contrarian bearish
  if (side === "short" && rate > FUNDING_CONTRARIAN_THRESHOLD) return 0.1;

  return 0;
}

// ── OI Confirmation ────────────────────────────────────────────────────────

/**
 * OI spike confirmation boost.
 *
 * OI increasing (spike) aligned with setup side → momentum confirmation.
 * - OI spike (> OI_SPIKE_THRESHOLD) at demand zone + long side → +0.10
 * - OI spike (> OI_SPIKE_THRESHOLD) at supply zone + short side → +0.10
 * - Moderate OI increase (positive but below threshold) → +0.05
 * - No delta or flat/declining OI → 0
 *
 * Range: 0 to +0.10
 */
export function oiConfirm(oiDelta: number | null, _side: SignalSide): number {
  if (oiDelta === null) return 0;

  // OI increasing → participants entering → momentum signal
  if (oiDelta >= OI_SPIKE_THRESHOLD) return 0.1;
  if (oiDelta > 0) return 0.05;

  return 0;
}

// ── Volume Profile ─────────────────────────────────────────────────────────

interface VPBin {
  priceLevel: number; // bin center
  volume: number;
}

function pocIndex(bins: VPBin[]): number {
  let idx = 0,
    maxVol = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]?.volume > maxVol) {
      maxVol = bins[i]?.volume;
      idx = i;
    }
  }
  return idx;
}

function vpValueArea(
  bins: VPBin[],
  poc: number,
  pct: number,
): { vahIdx: number; valIdx: number } {
  const total = bins.reduce((s, b) => s + b.volume, 0);
  if (total === 0) return { vahIdx: poc, valIdx: poc };
  const target = total * pct;
  let acc = bins[poc]?.volume;
  let upper = poc,
    lower = poc;

  while (acc < target && (upper < bins.length - 1 || lower > 0)) {
    const upVol = upper < bins.length - 1 ? bins[upper + 1]?.volume : 0;
    const dnVol = lower > 0 ? bins[lower - 1]?.volume : 0;
    if (upVol >= dnVol && upper < bins.length - 1) {
      upper++;
      acc += bins[upper]?.volume;
    } else if (lower > 0) {
      lower--;
      acc += bins[lower]?.volume;
    } else {
      upper++;
      acc += bins[upper]?.volume;
    }
  }

  return { vahIdx: upper, valIdx: lower };
}

/**
 * Build volume profile from candles[startIdx..endIdx].
 * Distributes each candle's volume across price bins it spans.
 * Identifies POC, VAH, VAL, HVN, LVN.
 * Returns null for empty/degenerate input.
 */
export function buildVolumeProfile(
  candles: Candle[],
  startIdx: number,
  endIdx: number,
  params: { numBins?: number; valueAreaPct?: number } = {},
): VolumeProfile | null {
  const numBins = params.numBins ?? VP_BINS;
  const vaPct = params.valueAreaPct ?? VP_VALUE_AREA_PCT;

  if (startIdx < 0 || endIdx >= candles.length || startIdx >= endIdx)
    return null;

  let hi = -Infinity,
    lo = Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i]!;
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  if (hi === lo) return null;

  const binSize = (hi - lo) / numBins;
  const bins: VPBin[] = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({
      priceLevel: lo + binSize * (i + 0.5),
      volume: 0,
    });
  }

  let totalVol = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const c = candles[i]!;
    totalVol += c.v;
    const lowBin = Math.max(0, Math.floor((c.l - lo) / binSize));
    const highBin = Math.min(numBins - 1, Math.floor((c.h - lo) / binSize));
    const binsSpanned = highBin - lowBin + 1;
    const volPerBin = c.v / binsSpanned;
    for (let b = lowBin; b <= highBin; b++) bins[b]!.volume += volPerBin;
  }

  const poc = pocIndex(bins);
  const pocPrice = bins[poc]?.priceLevel;

  const { vahIdx, valIdx } = vpValueArea(bins, poc, vaPct);
  const vah = bins[vahIdx]?.priceLevel + binSize / 2;
  const val = bins[valIdx]?.priceLevel - binSize / 2;

  const avgVol = totalVol / numBins;
  const lvnThreshold = avgVol * 0.5;
  const hvn: number[] = [];
  for (let i = 1; i < bins.length - 1; i++) {
    const v = bins[i]?.volume;
    if (
      v > avgVol * 1.5 &&
      v > bins[i - 1]?.volume &&
      v > bins[i + 1]?.volume
    ) {
      hvn.push(bins[i]?.priceLevel);
    }
  }

  const lvn: number[] = [];
  let zoneStart = -1;
  for (let i = 1; i < bins.length - 1; i++) {
    if (bins[i]?.volume < lvnThreshold) {
      if (zoneStart === -1) zoneStart = i;
    } else if (zoneStart !== -1) {
      lvn.push(bins[Math.floor((zoneStart + i - 1) / 2)]?.priceLevel);
      zoneStart = -1;
    }
  }
  if (zoneStart !== -1) {
    lvn.push(bins[Math.floor((zoneStart + bins.length - 2) / 2)]?.priceLevel);
  }

  return { poc: pocPrice, vah, val, hvn, lvn };
}
