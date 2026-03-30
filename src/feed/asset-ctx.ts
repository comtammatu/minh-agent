/**
 * Asset Context feed — REST polling every 30s.
 *
 * Uses HL REST metaAndAssetCtxs() to fetch OI + mark/oracle prices per coin.
 * Stores current + previous snapshot per coin for OI delta computation.
 * Supports dynamic coin add/remove via addOiCoin/removeOiCoin.
 *
 * Single REST call returns all coins — no per-coin calls needed.
 */

import { info } from './rest.js'
import {
  OI_POLL_INTERVAL_MS,
  MARK_ORACLE_DIVERGENCE_THRESHOLD,
} from '../config.js'
import type { AssetCtxSnapshot } from '../types.js'

// coin → { current, previous } for delta computation
const oiStore = new Map<string, { current: AssetCtxSnapshot; previous: AssetCtxSnapshot | null }>()

let pollingTimer: ReturnType<typeof setInterval> | null = null

// Mutable set — interval callback iterates this, so add/remove takes effect next poll
const polledCoins = new Set<string>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Get latest asset context snapshot for a coin, or null if not yet fetched. */
export function getLatestAssetCtx(coin: string): AssetCtxSnapshot | null {
  return oiStore.get(coin)?.current ?? null
}

/**
 * Get OI percentage change vs previous snapshot.
 * Returns null if no previous snapshot available.
 * Positive = OI increasing, negative = OI decreasing.
 */
export function getOiDelta(coin: string): number | null {
  const entry = oiStore.get(coin)
  if (!entry || !entry.previous) return null
  if (entry.previous.openInterest === 0) return null
  return (entry.current.openInterest - entry.previous.openInterest) / entry.previous.openInterest
}

/**
 * Check if mark/oracle divergence exceeds threshold.
 * Returns true if divergence is significant (cascade risk).
 */
export function hasDivergence(coin: string): boolean {
  const entry = oiStore.get(coin)
  if (!entry) return false
  const { markPrice, oraclePrice } = entry.current
  if (oraclePrice === 0) return false
  return Math.abs(markPrice - oraclePrice) / oraclePrice > MARK_ORACLE_DIVERGENCE_THRESHOLD
}

/**
 * Start polling asset context for the given coins.
 * Performs an initial fetch immediately, then polls every OI_POLL_INTERVAL_MS.
 */
export async function startOiPolling(coins: string[]): Promise<void> {
  polledCoins.clear()
  for (const coin of coins) polledCoins.add(coin)

  // Initial fetch
  await fetchAllAssetCtx()

  pollingTimer = setInterval(async () => {
    await fetchAllAssetCtx()
  }, OI_POLL_INTERVAL_MS)
}

/** Stop OI polling (call on SIGINT). */
export function stopOiPolling(): void {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

/** Add a coin to the polling set (takes effect on next poll cycle). */
export function addOiCoin(coin: string): void {
  polledCoins.add(coin)
}

/** Remove a coin from polling and clear its stored data. */
export function removeOiCoin(coin: string): void {
  polledCoins.delete(coin)
  oiStore.delete(coin)
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Fetch metaAndAssetCtxs once — updates all polled coins in a single REST call.
 * Coins not in polledCoins are ignored (no wasted storage).
 */
async function fetchAllAssetCtx(): Promise<void> {
  if (polledCoins.size === 0) return

  try {
    const [meta, assetCtxs] = await info.metaAndAssetCtxs()
    const now = Date.now()

    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i]!
      const ctx = assetCtxs[i]
      if (!ctx) continue

      // Only store coins we're tracking
      if (!polledCoins.has(asset.name)) continue

      const snapshot: AssetCtxSnapshot = {
        coin: asset.name,
        openInterest: parseFloat(ctx.openInterest),
        markPrice: parseFloat(ctx.markPx),
        oraclePrice: parseFloat(ctx.oraclePx),
        funding: parseFloat(ctx.funding),
        premium: parseFloat(ctx.premium),
        timestamp: now,
      }

      // Skip if any parsed value is NaN
      if (isNaN(snapshot.openInterest) || isNaN(snapshot.markPrice) || isNaN(snapshot.oraclePrice)) {
        continue
      }

      const existing = oiStore.get(asset.name)
      oiStore.set(asset.name, {
        current: snapshot,
        previous: existing?.current ?? null,
      })
    }
  } catch (err) {
    console.log(
      `[ASSET-CTX] fetch error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
