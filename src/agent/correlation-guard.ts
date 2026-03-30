/**
 * Anti-Correlation Guard — pure functions for correlated position detection.
 *
 * S12: Prevents excessive exposure to correlated assets.
 * Coins in the same correlation group (config.ts CORRELATION_GROUPS) count
 * toward a shared limit (RISK.maxCorrelatedPositions).
 *
 * All functions are pure: (inputs) → result. No I/O, no side effects.
 */

import { CORRELATION_GROUPS, RISK } from '../config.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CorrelationCheckResult {
  blocked: boolean
  reason: string | null
  /** Which group(s) caused the block. */
  blockedGroups: string[]
}

const OK: CorrelationCheckResult = { blocked: false, reason: null, blockedGroups: [] }

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Find all correlation groups a coin belongs to.
 * Returns empty array for unknown coins (uncorrelated — always allowed).
 */
export function getCorrelationGroups(coin: string): string[] {
  const groups: string[] = []
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.includes(coin)) {
      groups.push(group)
    }
  }
  return groups
}

/**
 * Check if opening a new position for `coin` would exceed the correlated
 * position limit in any shared group.
 *
 * @param coin - The coin to enter
 * @param openPositionCoins - Coins with currently open positions (IN_POSITION or ENTERING)
 * @param maxPerGroup - Max positions per correlation group (default: RISK.maxCorrelatedPositions)
 * @returns Whether the entry should be blocked
 */
export function shouldBlockCorrelatedEntry(
  coin: string,
  openPositionCoins: readonly string[],
  maxPerGroup: number = RISK.maxCorrelatedPositions,
): CorrelationCheckResult {
  const coinGroups = getCorrelationGroups(coin)

  // Unknown coin (not in any group) → always allowed
  if (coinGroups.length === 0) return OK

  const blockedGroups: string[] = []

  for (const group of coinGroups) {
    const members = CORRELATION_GROUPS[group]
    if (!members) continue

    // Count how many open positions are in this group (excluding the coin itself,
    // since it shouldn't already be open — 1-position-per-coin rule)
    let groupCount = 0
    for (const openCoin of openPositionCoins) {
      if (openCoin !== coin && members.includes(openCoin)) {
        groupCount++
      }
    }

    // Adding this coin would make groupCount + 1
    if (groupCount + 1 > maxPerGroup) {
      blockedGroups.push(group)
    }
  }

  if (blockedGroups.length > 0) {
    const groupNames = blockedGroups.join(', ')
    return {
      blocked: true,
      reason: `Correlated position limit (${maxPerGroup}) exceeded in group(s): ${groupNames}`,
      blockedGroups,
    }
  }

  return OK
}

/**
 * Get a summary of current correlation exposure across all groups.
 * Useful for API status endpoint.
 *
 * @param openPositionCoins - Coins with currently open positions
 * @returns Map of group → count of positions in that group
 */
export function getCorrelationExposure(
  openPositionCoins: readonly string[],
): Record<string, { count: number; coins: string[] }> {
  const exposure: Record<string, { count: number; coins: string[] }> = {}

  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    const coins: string[] = []
    for (const openCoin of openPositionCoins) {
      if (members.includes(openCoin)) {
        coins.push(openCoin)
      }
    }
    if (coins.length > 0) {
      exposure[group] = { count: coins.length, coins }
    }
  }

  return exposure
}
