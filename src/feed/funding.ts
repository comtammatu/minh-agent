/**
 * Funding rate feed — REST polling every 60s.
 *
 * Uses HL REST fundingHistory() to fetch last 24h of rates per coin.
 * Stores latest snapshot per coin for Layer 4 consumption.
 */

import { info } from './rest.js'
import {
  FUNDING_POLL_INTERVAL_MS,
  FUNDING_HISTORY_HOURS,
} from '../config.js'
import type { FundingSnapshot } from '../types.js'

// coin → sorted snapshots (ascending by timestamp)
const fundingStore = new Map<string, FundingSnapshot[]>()

let pollingTimer: ReturnType<typeof setInterval> | null = null

// ── Public API ───────────────────────────────────────────────────────────────

/** Get latest funding snapshot for a coin, or null if not yet fetched. */
export function getLatestFunding(coin: string): FundingSnapshot | null {
  const arr = fundingStore.get(coin)
  if (!arr || arr.length === 0) return null
  return arr[arr.length - 1]!
}

/**
 * Start polling funding rates for the given coins.
 * Performs an initial fetch immediately, then polls every FUNDING_POLL_INTERVAL_MS.
 */
export async function startFundingPolling(coins: string[]): Promise<void> {
  // Initial fetch (sequential — avoids burst on startup)
  for (const coin of coins) {
    await fetchFunding(coin)
  }

  pollingTimer = setInterval(async () => {
    for (const coin of coins) {
      await fetchFunding(coin)
    }
  }, FUNDING_POLL_INTERVAL_MS)
}

/** Stop funding polling (call on SIGINT). */
export function stopFundingPolling(): void {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function fetchFunding(coin: string): Promise<void> {
  const startTime = Date.now() - FUNDING_HISTORY_HOURS * 60 * 60 * 1000
  try {
    const results = await info.fundingHistory({ coin, startTime })
    const snapshots: FundingSnapshot[] = results.map(r => ({
      coin: r.coin,
      rate: parseFloat(r.fundingRate),
      premium: parseFloat(r.premium),
      timestamp: r.time,
    }))
    // Filter out NaN entries from malformed API responses
    const valid = snapshots.filter(s => !isNaN(s.rate) && !isNaN(s.premium))
    fundingStore.set(coin, valid)
  } catch (err) {
    console.log(
      `[FUNDING] ${coin}: fetch error — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
