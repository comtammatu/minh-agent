/**
 * Dynamic coin selection based on Hyperliquid open interest.
 *
 * fetchTopCoins(): fetch top N coins by OI from HL metaAndAssetCtxs.
 * fetchHip3RankedCoins(): fetch HIP-3 (builder-deployed perp) coins via raw API.
 * CoinSelector: stateful manager that tracks top coins + HIP-3 coins + active-setup coins.
 *   - topCoins: latest top N native perps from HL
 *   - hip3Coins: latest top N HIP-3 coins from configured DEXes
 *   - trackedCoins: topCoins ∪ hip3Coins ∪ {coins with active setups}
 */

import {
  COIN_REFRESH_INTERVAL_MS,
  HIP3_DEXES,
  HIP3_MIN_24H_VOLUME,
  HIP3_TOP_COINS_LIMIT,
  MIN_24H_VOLUME,
  TOP_COINS_LIMIT,
} from "../config.js";
import { log } from "../lib/logger.js";
import { fetchMetaAndAssetCtxs } from "./hl-info.js";
import { acquire } from "./rate-limiter.js";
import { info } from "./rest.js";

/**
 * Fetch all qualifying coins from HL ranked by open interest (descending).
 * Filters delisted coins and coins below MIN_24H_VOLUME.
 * Returns full ranked list. Returns [] on error (caller decides fallback).
 */
export async function fetchRankedCoins(
  minVolume: number = MIN_24H_VOLUME,
): Promise<string[]> {
  try {
    await acquire();
    const [meta, assetCtxs] = await info.metaAndAssetCtxs();

    // Zip universe metadata with asset contexts (parallel arrays)
    const coins: { name: string; oi: number; vol: number }[] = [];
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i]!;
      const ctx = assetCtxs[i];

      // Skip delisted
      if (asset.isDelisted) continue;

      // Skip if no asset context
      if (!ctx) continue;

      const oiCoins = parseFloat(ctx.openInterest);
      if (Number.isNaN(oiCoins) || oiCoins <= 0) continue;

      const markPx = parseFloat(ctx.markPx);
      if (Number.isNaN(markPx) || markPx <= 0) continue;

      // OI in USD (openInterest is in coin units, not USD)
      const oi = oiCoins * markPx;

      const vol = parseFloat(ctx.dayNtlVlm);
      if (Number.isNaN(vol) || vol < minVolume) continue;

      coins.push({ name: asset.name, oi, vol });
    }

    // Sort by OI descending — full list, caller slices
    coins.sort((a, b) => b.oi - a.oi);
    return coins.map((c) => c.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("coin-sel", `fetchRankedCoins failed: ${msg}`);
    return [];
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
  const ranked = await fetchRankedCoins(minVolume);
  return ranked.slice(0, limit);
}

// ── HIP-3 (builder-deployed perps) ──────────────────────────────────────────

/** Response shape from HL metaAndAssetCtxs (same for native and HIP-3). */
interface MetaAndCtxsResponse {
  universe: { name: string; isDelisted?: true }[];
}

interface AssetCtx {
  openInterest: string;
  dayNtlVlm: string;
  markPx: string;
}

/**
 * Fetch HIP-3 coins from configured DEXes, ranked by OI descending.
 * Uses raw fetch for dex-scoped HIP-3 calls via hl-info.ts.
 * Returns full ranked list across all configured DEXes.
 */
export async function fetchHip3RankedCoins(
  dexes: string[] = HIP3_DEXES,
  minVolume: number = HIP3_MIN_24H_VOLUME,
): Promise<string[]> {
  const allCoins: { name: string; oi: number }[] = [];

  for (const dex of dexes) {
    try {
      const [meta, ctxs] = (await fetchMetaAndAssetCtxs(dex)) as unknown as [
        MetaAndCtxsResponse,
        AssetCtx[],
      ];

      for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i]!;
        const ctx = ctxs[i];
        if (asset.isDelisted) continue;
        if (!ctx) continue;

        const oiCoins = parseFloat(ctx.openInterest);
        if (Number.isNaN(oiCoins) || oiCoins <= 0) continue;

        const markPx = parseFloat(ctx.markPx);
        if (Number.isNaN(markPx) || markPx <= 0) continue;

        const oi = oiCoins * markPx;

        const vol = parseFloat(ctx.dayNtlVlm);
        if (Number.isNaN(vol) || vol < minVolume) continue;

        allCoins.push({ name: asset.name, oi });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("coin-sel", `fetchHip3RankedCoins ${dex} failed: ${msg}`);
    }
  }

  allCoins.sort((a, b) => b.oi - a.oi);
  return allCoins.map((c) => c.name);
}

// ── CoinSelector ────────────────────────────────────────────────────────────

export interface RefreshResult {
  added: string[];
  dropped: string[];
}

export interface CoinSelector {
  /** Current top N native perp coins from HL (latest refresh). */
  getTopCoins(): string[];
  /** Current top N HIP-3 coins (latest refresh). */
  getHip3Coins(): string[];
  /** topCoins ∪ hip3Coins ∪ activeSetupCoins — never drops a coin mid-setup. */
  getTrackedCoins(): string[];
  /** Full ranked list from last refresh (for replacement candidates). */
  getRankedCoins(): string[];
  /** Fetch new top coins + HIP-3 coins, compute diff vs current. skipCallback=true for initial load. */
  refresh(skipCallback?: boolean): Promise<RefreshResult>;
  /** Replace failed coins with next-ranked candidates. Returns newly added coins. */
  replaceFailed(failedCoins: string[]): string[];
  /** Start periodic refresh loop. */
  startRefreshLoop(): void;
  /** Stop periodic refresh loop. */
  stopRefreshLoop(): void;
}

/**
 * Create a CoinSelector instance.
 * @param getActiveSetupCoins — injected function that returns coins with active setups
 * @param onRefresh — optional callback when refresh completes (for subscribe/unsubscribe wiring)
 * @param fetchRankedFn — optional override for fetching ranked coins (e.g., Bybit tickers API).
 *   When provided, HIP-3 fetching is skipped entirely. Use for non-HL exchanges.
 * @param topLimit — max coins to track from the ranked list. Defaults to TOP_COINS_LIMIT.
 */
export function createCoinSelector(
  getActiveSetupCoins: () => string[],
  onRefresh?: (result: RefreshResult) => void | Promise<void>,
  fetchRankedFn?: () => Promise<string[]>,
  topLimit: number = TOP_COINS_LIMIT,
): CoinSelector {
  let topCoins: string[] = [];
  let hip3Coins: string[] = [];
  let rankedCoins: string[] = [];
  let hip3RankedCoins: string[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function getTrackedCoins(): string[] {
    const activeCoins = getActiveSetupCoins();
    const set = new Set([...topCoins, ...hip3Coins]);
    for (const coin of activeCoins) set.add(coin);
    return Array.from(set);
  }

  async function refresh(skipCallback = false): Promise<RefreshResult> {
    let newRanked: string[];
    let newHip3Ranked: string[];

    if (fetchRankedFn) {
      // Exchange-specific coin list (e.g., Bybit static coins) — HIP-3 not applicable
      newRanked = await fetchRankedFn();
      newHip3Ranked = [];
    } else {
      // Default: fetch native perps + HIP-3 from HL in parallel
      [newRanked, newHip3Ranked] = await Promise.all([
        fetchRankedCoins(),
        HIP3_DEXES.length > 0 ? fetchHip3RankedCoins() : Promise.resolve([]),
      ]);
    }

    // If native fetch failed (empty), keep current list
    if (newRanked.length === 0 && topCoins.length > 0) {
      log.warn("coin-sel", "refresh failed — keeping current list");
      return { added: [], dropped: [] };
    }

    rankedCoins = newRanked;
    hip3RankedCoins = newHip3Ranked;
    const newTop = newRanked.slice(0, topLimit);
    const newHip3 = newHip3Ranked.slice(0, HIP3_TOP_COINS_LIMIT);

    // Compute diff across both lists
    const oldAll = new Set([...topCoins, ...hip3Coins]);
    const newAll = new Set([...newTop, ...newHip3]);

    const added = [...newAll].filter((c) => !oldAll.has(c));
    const allDropped = [...oldAll].filter((c) => !newAll.has(c));

    // Coins that dropped but have active setups — keep tracking
    const activeCoins = new Set(getActiveSetupCoins());
    const dropped = allDropped.filter((c) => !activeCoins.has(c));
    const kept = allDropped.filter((c) => activeCoins.has(c));

    if (kept.length > 0) {
      log.info(
        "coin-sel",
        `keeping ${kept.length} dropped coins with active setups: ${kept.join(", ")}`,
      );
    }

    topCoins = newTop;
    hip3Coins = newHip3;

    if (newHip3.length > 0) {
      log.info(
        "coin-sel",
        `HIP-3: ${newHip3.length} coins — ${newHip3.join(", ")}`,
      );
    }

    const result: RefreshResult = { added, dropped };
    if (!skipCallback) {
      await onRefresh?.(result);
    }
    return result;
  }

  function startRefreshLoop(): void {
    if (refreshTimer) return;
    refreshTimer = setInterval(async () => {
      try {
        const result = await refresh();
        if (result.added.length > 0 || result.dropped.length > 0) {
          log.info(
            "coin-sel",
            `refreshed — +${result.added.length} added, -${result.dropped.length} dropped | tracking ${getTrackedCoins().length} coins`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("coin-sel", `refresh loop error: ${msg}`);
      }
    }, COIN_REFRESH_INTERVAL_MS);
  }

  function stopRefreshLoop(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  /**
   * Replace failed coins with next-ranked candidates from the full list.
   * Removes failedCoins from topCoins/hip3Coins and fills slots from ranked lists.
   * Returns the newly added replacement coins.
   */
  function replaceFailed(failedCoins: string[]): string[] {
    if (failedCoins.length === 0) return [];

    const failedSet = new Set(failedCoins);
    const currentSet = new Set([...topCoins, ...hip3Coins]);
    const replacements: string[] = [];

    // Replace failed native perps from rankedCoins
    const failedNative = failedCoins.filter((c) => !c.includes(":"));
    if (failedNative.length > 0) {
      topCoins = topCoins.filter((c) => !failedSet.has(c));
      const slotsToFill = topLimit - topCoins.length;
      for (const candidate of rankedCoins) {
        if (replacements.length >= slotsToFill) break;
        if (currentSet.has(candidate)) continue;
        if (failedSet.has(candidate)) continue;
        replacements.push(candidate);
      }
      topCoins.push(...replacements);
    }

    // Replace failed HIP-3 coins from hip3RankedCoins
    const failedHip3 = failedCoins.filter((c) => c.includes(":"));
    if (failedHip3.length > 0) {
      hip3Coins = hip3Coins.filter((c) => !failedSet.has(c));
      const slotsToFill = HIP3_TOP_COINS_LIMIT - hip3Coins.length;
      const hip3Replacements: string[] = [];
      for (const candidate of hip3RankedCoins) {
        if (hip3Replacements.length >= slotsToFill) break;
        if (currentSet.has(candidate)) continue;
        if (failedSet.has(candidate)) continue;
        hip3Replacements.push(candidate);
      }
      hip3Coins.push(...hip3Replacements);
      replacements.push(...hip3Replacements);
    }

    return replacements;
  }

  return {
    getTopCoins: () => [...topCoins],
    getHip3Coins: () => [...hip3Coins],
    getTrackedCoins,
    getRankedCoins: () => [...rankedCoins],
    refresh,
    replaceFailed,
    startRefreshLoop,
    stopRefreshLoop,
  };
}
