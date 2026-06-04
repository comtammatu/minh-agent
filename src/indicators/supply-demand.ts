/**
 * Supply & Demand — premium/discount zones and optimal trade entry.
 * Pure functions. Zero I/O.
 */

// ─── Premium/Discount Zone ────────────────────────────────────────────────────

/**
 * Determine if price is in premium, discount, or equilibrium relative to a swing range.
 * Premium = above midpoint (sell zone), Discount = below midpoint (buy zone).
 * 0.5% buffer around equilibrium to avoid noise.
 */
export function premiumDiscount(
  swingHigh: number,
  swingLow: number,
  price: number,
): "premium" | "discount" | "equilibrium" {
  if (swingHigh <= swingLow) return "equilibrium";
  const eq = (swingHigh + swingLow) / 2;
  if (price > eq * 1.005) return "premium";
  if (price < eq * 0.995) return "discount";
  return "equilibrium";
}

// ─── Optimal Trade Entry (OTE) ────────────────────────────────────────────────

/**
 * OTE = Fib 62%–79% retracement zone of an impulse move (swingA → swingB).
 * Bullish impulse (B > A): retracement zone is below B.
 * Bearish impulse (B < A): retracement zone is above B.
 * Returns null if swingA === swingB (no range).
 */
export function oteZone(
  swingA: number,
  swingB: number,
): { top: number; bottom: number } | null {
  const range = Math.abs(swingB - swingA);
  if (range === 0) return null;
  if (swingB > swingA) {
    // Bullish impulse — OTE is a pullback zone below swingB
    return { top: swingB - range * 0.62, bottom: swingB - range * 0.79 };
  } else {
    // Bearish impulse — OTE is a pullback zone above swingB
    return { top: swingB + range * 0.79, bottom: swingB + range * 0.62 };
  }
}
