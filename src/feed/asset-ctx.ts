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
import { fetchAllPerpDexNames, fetchMetaAndAssetCtxs } from './perp-info.js'
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

  // Fetch builder-deployed perp DEX names (HIP-3 etc), then load their universe names.
  // If HIP3_DEXES is configured, it acts as an allowlist to limit extra REST calls.
  let dexs: string[] = []
  try {
    dexs = (await fetchAllPerpDexNames()).filter(d => d !== '')
  } catch (err) {
    log.warn('asset-ctx', `Failed to load perpDexs list: ${err instanceof Error ? err.message : err}`)
    dexs = []
  }

  const allow = HIP3_DEXES.length > 0 ? new Set(HIP3_DEXES) : null
  const selected = allow ? dexs.filter(d => allow.has(d)) : dexs
  for (const dex of selected) {
    try {
      const [hip3Meta] = await fetchMetaAndAssetCtxs(dex)
      dexCoinNames.set(dex, hip3Meta.universe.map(a => a.name))
      log.info('asset-ctx', `Perp dex "${dex}": loaded ${hip3Meta.universe.length} coin names`)
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

// ── Exchange-agnostic write API (used by Bybit feed) ─────────────────────────

/**
 * Write an asset context snapshot from an external feed (e.g. Bybit ticker WS).
 * Stores current + rotates previous for OI delta computation.
 */
export function writeAssetCtx(coin: string, snapshot: AssetCtxSnapshot): void {
  const existing = oiStore.get(coin)
  oiStore.set(coin, { current: snapshot, previous: existing?.current ?? null })
}

/** Remove asset context for a coin (used by Bybit unsubscribe). */
export function removeAssetCtx(coin: string): void {
  oiStore.delete(coin)
}

// ── Backward-compat aliases (used by index.ts) ──────────────────────────────

/** @deprecated Use startOiFeed */
export const startOiPolling = startOiFeed
/** @deprecated Use stopOiFeed */
export const stopOiPolling = stopOiFeed
