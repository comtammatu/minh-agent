/**
 * Order Flow indicators — pure functions for delta, book, and funding confirmation.
 *
 * Used by Layer 4 (confirm) to boost/penalize zones based on order flow data.
 * All functions are pure: no I/O, no side effects, deterministic.
 */

import type { KeyZone, DeltaState, SignalSide } from '../types.js'
import {
  DELTA_STRONG_THRESHOLD,
  BOOK_IMBALANCE_THRESHOLD,
  FUNDING_CONTRARIAN_THRESHOLD,
  OI_SPIKE_THRESHOLD,
} from '../config.js'

// ── Delta ───────────────────────────────────────────────────────────────────

export interface RawTrade {
  side: 'A' | 'B'  // A = seller aggressor (sell), B = buyer aggressor (buy)
  size: number
}

/**
 * Compute delta from raw trades.
 * B (buyer aggressor) = buy volume, A (seller aggressor) = sell volume.
 */
export function computeDelta(trades: RawTrade[]): { delta: number; buyVol: number; sellVol: number } {
  let buyVol = 0
  let sellVol = 0

  for (const t of trades) {
    if (t.side === 'B') buyVol += t.size
    else sellVol += t.size
  }

  return { delta: buyVol - sellVol, buyVol, sellVol }
}

/**
 * Cumulative delta over last N bars.
 * Returns sum of delta values. If fewer than N bars, uses all available.
 */
export function cumulativeDelta(history: DeltaState[], n: number): number {
  if (history.length === 0) return 0
  const slice = history.slice(-n)
  let cum = 0
  for (const d of slice) cum += d.delta
  return cum
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
  if (!delta) return 0

  const total = delta.buyVol + delta.sellVol
  if (total === 0) return 0

  const ratio = Math.abs(delta.delta) / total

  if (zone.type === 'demand') {
    // Expect buying at demand
    if (delta.delta > 0 && ratio >= DELTA_STRONG_THRESHOLD) return 0.15
    if (delta.delta > 0) return 0.05
    if (delta.delta < 0 && ratio >= DELTA_STRONG_THRESHOLD) return -0.10  // divergence
  } else {
    // Expect selling at supply
    if (delta.delta < 0 && ratio >= DELTA_STRONG_THRESHOLD) return 0.15
    if (delta.delta < 0) return 0.05
    if (delta.delta > 0 && ratio >= DELTA_STRONG_THRESHOLD) return -0.10  // divergence
  }

  return 0
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
  let bidSize = 0
  let askSize = 0

  for (const [, sz] of bids) bidSize += sz
  for (const [, sz] of asks) askSize += sz

  const total = bidSize + askSize
  if (total === 0) return 0

  return (bidSize - askSize) / total
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
  if (zone.type === 'demand') {
    // Expect bid-heavy at demand
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD * 2) return 0.20  // absorption
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD) return 0.10
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD) return -0.10  // counter
  } else {
    // Expect ask-heavy at supply
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD * 2) return 0.20  // absorption
    if (imbalance <= -BOOK_IMBALANCE_THRESHOLD) return 0.10
    if (imbalance >= BOOK_IMBALANCE_THRESHOLD) return -0.10  // counter
  }

  return 0
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
  if (rate === null || rate === 0) return 0

  if (side === 'long' && rate < FUNDING_CONTRARIAN_THRESHOLD) return 0.10
  if (side === 'short' && rate > -FUNDING_CONTRARIAN_THRESHOLD) return 0.10

  return 0
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
export function oiConfirm(oiDelta: number | null, side: SignalSide): number {
  if (oiDelta === null) return 0

  // OI increasing → participants entering → momentum signal
  if (oiDelta >= OI_SPIKE_THRESHOLD) return 0.10
  if (oiDelta > 0) return 0.05

  return 0
}
