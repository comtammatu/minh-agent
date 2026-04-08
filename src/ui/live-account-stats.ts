/**
 * Live Account TUI helpers — closed-trade stats by strategy.
 * Pure functions + types shared with tui.tsx (no I/O here).
 */

import { PAPER_WALLET_STRATEGY_IDS } from '../config.js'

/** Closed-trade aggregates for one strategy (from DB). */
export interface StrategyClosedStatRow {
  strategyId: string
  wins: number
  losses: number
  tradeCount: number
}

export interface LiveStrategyWalletRow {
  strategyId: string
  wins: number
  losses: number
  tradeCount: number
  winRate: number
}

export interface LiveStrategyWalletStats {
  wallets: LiveStrategyWalletRow[]
  wins: number
  losses: number
  tradeCount: number
  winRate: number
}

export function normalizeStrategyId(raw: string | undefined): string {
  if (raw && PAPER_WALLET_STRATEGY_IDS.includes(raw as (typeof PAPER_WALLET_STRATEGY_IDS)[number])) {
    return raw
  }
  return 'layered'
}

/** Build TUI stats from DB rows; always emits 3 wallet rows (layered / quant / smc-sd). */
export function buildLiveStrategyWalletStats(rows: StrategyClosedStatRow[]): LiveStrategyWalletStats {
  const byId = new Map(rows.map(r => [r.strategyId, r]))
  const wallets: LiveStrategyWalletRow[] = PAPER_WALLET_STRATEGY_IDS.map(sid => {
    const r = byId.get(sid)
    const tc = r?.tradeCount ?? 0
    const w = r?.wins ?? 0
    return {
      strategyId: sid,
      wins: w,
      losses: r?.losses ?? 0,
      tradeCount: tc,
      winRate: tc > 0 ? w / tc : 0,
    }
  })
  const wins = wallets.reduce((s, w) => s + w.wins, 0)
  const losses = wallets.reduce((s, w) => s + w.losses, 0)
  const tradeCount = wallets.reduce((s, w) => s + w.tradeCount, 0)
  return {
    wallets,
    wins,
    losses,
    tradeCount,
    winRate: tradeCount > 0 ? wins / tradeCount : 0,
  }
}
