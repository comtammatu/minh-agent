/**
 * Dynamic coin selection based on Hyperliquid open interest.
 *
 * fetchTopCoins(): fetch top N coins by OI from HL metaAndAssetCtxs.
 * CoinSelector: stateful manager that tracks top coins + active-setup coins.
 *   - topCoins: latest top N from HL (refreshed every COIN_REFRESH_INTERVAL_MS)
 *   - trackedCoins: topCoins ∪ {coins with active setups} — never drops mid-setup
 */

import { info } from './rest.js'
import { acquire } from './rate-limiter.js'
import { TOP_COINS_LIMIT, MIN_24H_VOLUME, COIN_REFRESH_INTERVAL_MS } from '../config.js'

/**
 * Fetch all qualifying coins from HL ranked by open interest (descending).
 * Filters delisted coins and coins below MIN_24H_VOLUME.
 * Returns full ranked list. Returns [] on error (caller decides fallback).
 */
export async function fetchRankedCoins(
  minVolume: number = MIN_24H_VOLUME,
): Promise<string[]> {
  try {
    await acquire()
    const [meta, assetCtxs] = await info.metaAndAssetCtxs()

    // Zip universe metadata with asset contexts (parallel arrays)
    const coins: { name: string; oi: number; vol: number }[] = []
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i]!
      const ctx = assetCtxs[i]

      // Skip delisted
      if (asset.isDelisted) continue

      // Skip if no asset context
      if (!ctx) continue

      const oi = parseFloat(ctx.openInterest)
      if (isNaN(oi) || oi <= 0) continue

      const vol = parseFloat(ctx.dayNtlVlm)
      if (isNaN(vol) || vol < minVolume) continue

      coins.push({ name: asset.name, oi, vol })
    }

    // Sort by OI descending — full list, caller slices
    coins.sort((a, b) => b.oi - a.oi)
    return coins.map(c => c.name)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[COIN-SELECTOR] fetchRankedCoins failed: ${msg}`)
    return []
  }
}

/**
 * Fetch top N coins from HL ranked by open interest (descending).
 * Convenience wrapper over fetchRankedCoins.
 */
export async function fetchTopCoins(
  limit: number = TOP_COINS_LIMIT,
  minVolume: number = MIN_24H_VOLUME,
): Promise<string[]> {
  const ranked = await fetchRankedCoins(minVolume)
  return ranked.slice(0, limit)
}

// ── CoinSelector ────────────────────────────────────────────────────────────

export interface RefreshResult {
  added: string[]
  dropped: string[]
}

export interface CoinSelector {
  /** Current top N coins from HL (latest refresh). */
  getTopCoins(): string[]
  /** topCoins ∪ activeSetupCoins — never drops a coin mid-setup. */
  getTrackedCoins(): string[]
  /** Full ranked list from last refresh (for replacement candidates). */
  getRankedCoins(): string[]
  /** Fetch new top coins, compute diff vs current. skipCallback=true for initial load. */
  refresh(skipCallback?: boolean): Promise<RefreshResult>
  /** Replace failed coins with next-ranked candidates. Returns newly added coins. */
  replaceFailed(failedCoins: string[]): string[]
  /** Start periodic refresh loop. */
  startRefreshLoop(): void
  /** Stop periodic refresh loop. */
  stopRefreshLoop(): void
}

/**
 * Create a CoinSelector instance.
 * @param getActiveSetupCoins — injected function that returns coins with active setups
 * @param onRefresh — optional callback when refresh completes (for subscribe/unsubscribe wiring)
 */
export function createCoinSelector(
  getActiveSetupCoins: () => string[],
  onRefresh?: (result: RefreshResult) => void | Promise<void>,
): CoinSelector {
  let topCoins: string[] = []
  let rankedCoins: string[] = []
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  function getTrackedCoins(): string[] {
    const activeCoins = getActiveSetupCoins()
    const set = new Set(topCoins)
    for (const coin of activeCoins) set.add(coin)
    return Array.from(set)
  }

  async function refresh(skipCallback = false): Promise<RefreshResult> {
    const newRanked = await fetchRankedCoins()

    // If fetch failed (empty), keep current list
    if (newRanked.length === 0 && topCoins.length > 0) {
      console.log('[COIN-SELECTOR] refresh failed — keeping current list')
      return { added: [], dropped: [] }
    }

    rankedCoins = newRanked
    const newTop = newRanked.slice(0, TOP_COINS_LIMIT)

    const oldSet = new Set(topCoins)
    const newSet = new Set(newTop)

    const added = newTop.filter(c => !oldSet.has(c))
    const allDropped = topCoins.filter(c => !newSet.has(c))

    // Coins that dropped from top but have active setups — keep tracking
    const activeCoins = new Set(getActiveSetupCoins())
    const dropped = allDropped.filter(c => !activeCoins.has(c))
    const kept = allDropped.filter(c => activeCoins.has(c))

    if (kept.length > 0) {
      console.log(`[COIN-SELECTOR] keeping ${kept.length} dropped coins with active setups: ${kept.join(', ')}`)
    }

    topCoins = newTop

    const result: RefreshResult = { added, dropped }
    if (!skipCallback) {
      await onRefresh?.(result)
    }
    return result
  }

  function startRefreshLoop(): void {
    if (refreshTimer) return
    refreshTimer = setInterval(async () => {
      try {
        const result = await refresh()
        if (result.added.length > 0 || result.dropped.length > 0) {
          console.log(
            `[COIN-SELECTOR] refreshed — +${result.added.length} added, -${result.dropped.length} dropped | tracking ${getTrackedCoins().length} coins`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[COIN-SELECTOR] refresh loop error: ${msg}`)
      }
    }, COIN_REFRESH_INTERVAL_MS)
  }

  function stopRefreshLoop(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  /**
   * Replace failed coins with next-ranked candidates from the full list.
   * Removes failedCoins from topCoins and fills slots from rankedCoins.
   * Returns the newly added replacement coins.
   */
  function replaceFailed(failedCoins: string[]): string[] {
    if (failedCoins.length === 0) return []

    const failedSet = new Set(failedCoins)
    const currentSet = new Set(topCoins)

    // Remove failed coins from topCoins
    topCoins = topCoins.filter(c => !failedSet.has(c))

    // Find candidates: in ranked list, not already tracked, not failed
    const slotsToFill = TOP_COINS_LIMIT - topCoins.length
    const replacements: string[] = []
    for (const candidate of rankedCoins) {
      if (replacements.length >= slotsToFill) break
      if (currentSet.has(candidate)) continue
      if (failedSet.has(candidate)) continue
      replacements.push(candidate)
    }

    topCoins.push(...replacements)
    return replacements
  }

  return {
    getTopCoins: () => [...topCoins],
    getTrackedCoins,
    getRankedCoins: () => [...rankedCoins],
    refresh,
    replaceFailed,
    startRefreshLoop,
    stopRefreshLoop,
  }
}
