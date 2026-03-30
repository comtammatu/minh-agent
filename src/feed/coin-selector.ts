/**
 * Dynamic coin selection based on Hyperliquid open interest.
 *
 * fetchTopCoins(): fetch top N coins by OI from HL metaAndAssetCtxs.
 * CoinSelector: stateful manager that tracks top coins + active-setup coins.
 *   - topCoins: latest top N from HL (refreshed every COIN_REFRESH_INTERVAL_MS)
 *   - trackedCoins: topCoins ∪ {coins with active setups} — never drops mid-setup
 */

import { info } from './rest.js'
import { TOP_COINS_LIMIT, COIN_REFRESH_INTERVAL_MS } from '../config.js'

/**
 * Fetch top N coins from HL ranked by open interest (descending).
 * Filters delisted coins. Returns coin name strings.
 * Returns [] on error (caller decides fallback behavior).
 */
export async function fetchTopCoins(limit: number = TOP_COINS_LIMIT): Promise<string[]> {
  try {
    const [meta, assetCtxs] = await info.metaAndAssetCtxs()

    // Zip universe metadata with asset contexts (parallel arrays)
    const coins: { name: string; oi: number }[] = []
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i]!
      const ctx = assetCtxs[i]

      // Skip delisted
      if (asset.isDelisted) continue

      // Skip if no asset context
      if (!ctx) continue

      const oi = parseFloat(ctx.openInterest)
      if (isNaN(oi) || oi <= 0) continue

      coins.push({ name: asset.name, oi })
    }

    // Sort by OI descending, take top N
    coins.sort((a, b) => b.oi - a.oi)
    return coins.slice(0, limit).map(c => c.name)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[COIN-SELECTOR] fetchTopCoins failed: ${msg}`)
    return []
  }
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
  /** Fetch new top coins, compute diff vs current. */
  refresh(): Promise<RefreshResult>
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
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  function getTrackedCoins(): string[] {
    const activeCoins = getActiveSetupCoins()
    const set = new Set(topCoins)
    for (const coin of activeCoins) set.add(coin)
    return Array.from(set)
  }

  async function refresh(): Promise<RefreshResult> {
    const newTop = await fetchTopCoins()

    // If fetch failed (empty), keep current list
    if (newTop.length === 0 && topCoins.length > 0) {
      console.log('[COIN-SELECTOR] refresh failed — keeping current list')
      return { added: [], dropped: [] }
    }

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
    await onRefresh?.(result)
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

  return {
    getTopCoins: () => [...topCoins],
    getTrackedCoins,
    refresh,
    startRefreshLoop,
    stopRefreshLoop,
  }
}
