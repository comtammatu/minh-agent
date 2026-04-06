/**
 * Asset Context feed — WS `allDexsAssetCtxs` subscription.
 *
 * Single WS subscription receives real-time OI + mark/oracle prices for ALL coins.
 * Stores current + previous snapshot per coin for OI delta computation.
 * Supports dynamic coin add/remove via addOiCoin/removeOiCoin.
 *
 * Replaces the previous REST polling approach (saved 40 weight/min).
 */

import { info } from './rest.js'
import { getWsClient, registerSubscription, removeSubscription } from './ws.js'
import { acquire } from './rate-limiter.js'
import { MARK_ORACLE_DIVERGENCE_THRESHOLD, HIP3_DEXES } from '../config.js'
import { log } from '../lib/logger.js'
import type { AssetCtxSnapshot } from '../types.js'
import type { ISubscription } from '@nktkas/hyperliquid'

// coin → { current, previous } for delta computation
const oiStore = new Map<string, { current: AssetCtxSnapshot; previous: AssetCtxSnapshot | null }>()

// Active WS subscription
let wsSub: ISubscription | null = null

// Mutable set — WS sends all coins, we only store coins in this set
const trackedCoins = new Set<string>()

// dexId → index→coinName mapping. '' = main perp, 'xyz' = HIP-3, etc.
const dexCoinNames = new Map<string, string[]>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Get latest asset context snapshot for a coin, or null if not yet received. */
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
 * Start OI feed — fetches meta once for coin name mapping, then subscribes
 * to `allDexsAssetCtxs` WS for real-time updates.
 */
export async function startOiFeed(coins: string[]): Promise<void> {
  trackedCoins.clear()
  for (const coin of coins) trackedCoins.add(coin)

  // Fetch main perp coin names (index → name)
  await acquire()
  const meta = await info.meta()
  dexCoinNames.set('', meta.universe.map(a => a.name))

  // Fetch HIP-3 coin names for each configured DEX
  for (const dex of HIP3_DEXES) {
    try {
      await acquire()
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }),
      })
      if (res.ok) {
        const [hip3Meta] = (await res.json()) as [{ universe: { name: string }[] }, unknown]
        dexCoinNames.set(dex, hip3Meta.universe.map(a => a.name))
        log.info('asset-ctx', `HIP-3 dex "${dex}": loaded ${hip3Meta.universe.length} coin names`)
      }
    } catch (err) {
      log.warn('asset-ctx', `Failed to load HIP-3 names for dex "${dex}": ${err instanceof Error ? err.message : err}`)
    }
  }

  // Subscribe to allDexsAssetCtxs WS — single subscription covers all dexes
  const client = getWsClient()
  wsSub = await client.allDexsAssetCtxs((event) => {
    try {
      const now = Date.now()
      for (const [dexId, ctxs] of event.ctxs) {
        const names = dexCoinNames.get(dexId)
        if (!names) continue  // unknown dex — no name mapping loaded

        for (let i = 0; i < ctxs.length; i++) {
          const name = names[i]
          if (!name || !trackedCoins.has(name)) continue

          const ctx = ctxs[i]!
          const snapshot: AssetCtxSnapshot = {
            coin: name,
            openInterest: parseFloat(ctx.openInterest),
            markPrice: parseFloat(ctx.markPx),
            oraclePrice: parseFloat(ctx.oraclePx),
            funding: parseFloat(ctx.funding),
            premium: parseFloat(ctx.premium ?? '0'),
            timestamp: now,
          }

          if (isNaN(snapshot.openInterest) || isNaN(snapshot.markPrice) || isNaN(snapshot.oraclePrice)) {
            continue
          }

          const existing = oiStore.get(name)
          oiStore.set(name, {
            current: snapshot,
            previous: existing?.current ?? null,
          })
        }
      }
    } catch (err) {
      log.error('asset-ctx', `WS parse error — ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  registerSubscription(wsSub)
}

/** Stop OI feed — unsubscribe WS (call on SIGINT). */
export async function stopOiFeed(): Promise<void> {
  if (wsSub) {
    try { await wsSub.unsubscribe() } catch { /* ignore */ }
    removeSubscription(wsSub)
    wsSub = null
  }
  dexCoinNames.clear()
}

/** Add a coin to the tracked set (takes effect immediately — next WS event will include it). */
export function addOiCoin(coin: string): void {
  trackedCoins.add(coin)
}

/** Remove a coin from tracking and clear its stored data. */
export function removeOiCoin(coin: string): void {
  trackedCoins.delete(coin)
  oiStore.delete(coin)
}

// ── Backward-compat aliases (used by index.ts) ──────────────────────────────

/** @deprecated Use startOiFeed */
export const startOiPolling = startOiFeed
/** @deprecated Use stopOiFeed */
export const stopOiPolling = stopOiFeed
