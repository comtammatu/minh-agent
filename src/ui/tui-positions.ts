/**
 * Merge Hyperliquid clearinghouse positions with bot-tracked positions for the TUI.
 * Tracked-only rows come from {@link PositionMonitor}; without merge, manual / external
 * positions on ACCOUNT_ADDRESS never appeared in the Positions panel.
 */

import type { ExchangePositionSnapshot, PositionState } from '../agent/types.js'
import { normalizeStrategyId } from './live-account-stats.js'

/** One row for the Positions table (live). */
export interface TuiPositionRow {
  /** Stable key for React list items. */
  rowKey: string
  coin: string
  side: 'long' | 'short'
  leverage: number
  currentSize: number
  entryPrice: number
  slPrice: number
  tpPrice: number
  strategyId: string
  /** True when the row is from HL only (no matching {@link PositionMonitor} entry). */
  exchangeOnly: boolean
}

function snapSide(s: ExchangePositionSnapshot): 'long' | 'short' {
  return s.size > 0 ? 'long' : 'short'
}

function findMatchingTracked(
  snap: ExchangePositionSnapshot,
  tracked: Map<string, PositionState>,
  consumed: Set<string>,
): PositionState | null {
  const candidates: PositionState[] = []
  for (const pos of tracked.values()) {
    if (pos.coin !== snap.coin) continue
    if (consumed.has(pos.positionId)) continue
    if (snap.strategyId !== undefined && pos.strategyId !== snap.strategyId) continue
    candidates.push(pos)
  }
  if (candidates.length === 0) return null
  if (snap.strategyId !== undefined) return candidates[0] ?? null
  return candidates[0] ?? null
}

/**
 * Build a TUI position map: one row per non-zero HL asset position, enriched from
 * {@link PositionMonitor} when the bot is tracking the same coin/strategy locally.
 * Tracked positions missing from the last exchange snapshot are still shown (stale poll).
 */
export function mergeExchangeAndTrackedForTui(
  tracked: Map<string, PositionState>,
  exchange: ExchangePositionSnapshot[],
): Map<string, TuiPositionRow> {
  const out = new Map<string, TuiPositionRow>()
  const consumed = new Set<string>()

  for (const snap of exchange) {
    if (snap.size === 0) continue

    const side = snapSide(snap)
    const absSize = Math.abs(snap.size)
    const lev = snap.leverage !== undefined && snap.leverage > 0 ? snap.leverage : 1
    const stratFromSnap = snap.strategyId !== undefined ? normalizeStrategyId(snap.strategyId) : null

    const match = findMatchingTracked(snap, tracked, consumed)
    if (match) {
      consumed.add(match.positionId)
      // Exchange snapshot is source of truth for leverage; fall back to tracked if exchange omits it
      const mergedLev = snap.leverage !== undefined && snap.leverage > 0 ? snap.leverage : (match.leverage > 0 ? match.leverage : 1)
      out.set(match.positionId, {
        rowKey: match.positionId,
        coin: snap.coin,
        side,
        leverage: mergedLev,
        currentSize: absSize,
        entryPrice: snap.entryPrice,
        slPrice: match.slPrice,
        tpPrice: match.tpPrice,
        strategyId: match.strategyId,
        exchangeOnly: false,
      })
      continue
    }

    const sid = stratFromSnap ?? 'ext'
    const rowKey = `hl:${sid}:${snap.coin}`
    out.set(rowKey, {
      rowKey,
      coin: snap.coin,
      side,
      leverage: lev,
      currentSize: absSize,
      entryPrice: snap.entryPrice,
      slPrice: snap.slPrice ?? 0,
      tpPrice: snap.tpPrice ?? 0,
      strategyId: sid,
      exchangeOnly: true,
    })
  }

  for (const [id, pos] of tracked) {
    if (consumed.has(id)) continue
    out.set(id, {
      rowKey: id,
      coin: pos.coin,
      side: pos.side,
      leverage: pos.leverage > 0 ? pos.leverage : 1,
      currentSize: pos.currentSize,
      entryPrice: pos.entryPrice,
      slPrice: pos.slPrice,
      tpPrice: pos.tpPrice,
      strategyId: pos.strategyId,
      exchangeOnly: false,
    })
  }

  return out
}
