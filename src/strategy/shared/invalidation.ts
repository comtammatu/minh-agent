/**
 * Setup invalidation logic.
 * Pure functions — no side effects, no I/O.
 *
 * Live pattern: minh — close beyond zone boundary ± ATR buffer, or TTL expiry.
 * TTL: PATTERN_TTL_BARS in config.ts (see .claude/rules/invalidation-table.md).
 */

import { PATTERN_TTL_BARS } from "../../config.js";
import type {
  ActiveSetup,
  Candle,
  CandleInterval,
  InvalidationReason,
} from "../../types.js";

export interface InvalidationResult {
  invalidated: boolean;
  reason?: InvalidationReason;
}

/** Check if a setup is invalidated by current price action or TTL. */
export function isInvalidated(
  setup: ActiveSetup,
  candles: Candle[],
  currentBarIdx: number,
): InvalidationResult {
  // TTL expiry — check before candle bounds (setup may outlive the candle slice)
  if (currentBarIdx >= setup.expiresAtBar) {
    return { invalidated: true, reason: "ttl-expired" };
  }

  // Skip invalidation on the bar where setup was created.
  // The entry bar's wick may have triggered the signal (e.g., spring/sweep),
  // so checking SL on that same bar causes false invalidation.
  // Trade needs at least 1 bar to "work out."
  if (
    setup.detectedAtBar !== undefined &&
    currentBarIdx <= setup.detectedAtBar
  ) {
    return { invalidated: false };
  }

  const c = candles[currentBarIdx];
  if (!c) return { invalidated: false };

  const pd = setup.patternData;

  switch (setup.type) {
    case "minh": {
      // Zone-based invalidation: close beyond zone boundary + ATR buffer
      const smcZoneBottom = pd.zoneBottom as number;
      const smcZoneTop = pd.zoneTop as number;
      const smcAtr = (pd.atrAtEntry as number) ?? 0;
      const invBuffer = smcAtr * 0.5; // ATR buffer before invalidating
      if (
        setup.side === "long" &&
        c.c < (smcZoneBottom ?? setup.slPrice) - invBuffer
      ) {
        return { invalidated: true, reason: "zone-broken" };
      }
      if (
        setup.side === "short" &&
        c.c > (smcZoneTop ?? setup.slPrice) + invBuffer
      ) {
        return { invalidated: true, reason: "zone-broken" };
      }
      break;
    }
  }

  return { invalidated: false };
}

/** Compute expiresAtBar from detection bar + TTL. */
export function computeExpiresAtBar(
  type: ActiveSetup["type"],
  detectedAtBar: number,
): number {
  return detectedAtBar + (PATTERN_TTL_BARS[type] ?? 0);
}

/** Build a unique setup ID. At most one active setup per coin/tf/type. */
export function setupId(
  coin: string,
  interval: CandleInterval,
  type: ActiveSetup["type"],
): string {
  return `${coin}|${interval}|${type}`;
}
