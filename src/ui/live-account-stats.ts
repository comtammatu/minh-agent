/**
 * Live Account TUI helpers — per-strategy breakdown + closed-trade stats.
 * Pure functions + types shared with tui.tsx (no I/O here).
 */

import { PAPER_WALLET_STRATEGY_IDS } from '../config.js'

/** One strategy row for Account ALL | 1 | 2 | 3 (live). `equity` = total slice value (cash + uPnL); not “balance + margin” as separate addends. */
export interface LiveWalletBreakdownRow {
  strategyId: string
  cash: number
  unrealized: number
  equity: number
}

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

/**
 * Split main account value (`effectiveBalance`) across strategies by margin share for ALL vs tabs 1–3
 * when one HL unified wallet backs multiple strategy labels. Per row: **balance** (`equity` field) =
 * allocated cash + unrealized for that strategy. UI **Available** = balance − margin for that strategy
 * when shown without a per-main HL snapshot.
 * When no margin anywhere, split free cash evenly across the three slots.
 */
export function buildLiveWalletBreakdown(
  account: { effectiveBalance: number },
  positions: Array<{
    coin: string
    side: 'long' | 'short'
    strategyId?: string
    currentSize: number
    entryPrice: number
    leverage: number
  }>,
  unrealizedPnlTotal: number,
  getMark: (coin: string) => number | null,
): LiveWalletBreakdownRow[] {
  const uByStrat = new Map<string, number>()
  const mByStrat = new Map<string, number>()
  for (const id of PAPER_WALLET_STRATEGY_IDS) {
    uByStrat.set(id, 0)
    mByStrat.set(id, 0)
  }

  for (const p of positions) {
    const sid = normalizeStrategyId(p.strategyId)
    const mark = getMark(p.coin) ?? p.entryPrice
    const direction = p.side === 'long' ? 1 : -1
    const u = (mark - p.entryPrice) * Math.abs(p.currentSize) * direction
    uByStrat.set(sid, (uByStrat.get(sid) ?? 0) + u)

    const notional = Math.abs(p.currentSize) * mark
    const lev = p.leverage > 0 ? p.leverage : 1
    mByStrat.set(sid, (mByStrat.get(sid) ?? 0) + notional / lev)
  }

  const E = account.effectiveBalance
  const cashPool = Math.max(0, E - unrealizedPnlTotal)
  const M = [...mByStrat.values()].reduce((a, b) => a + b, 0)
  const nSlot = PAPER_WALLET_STRATEGY_IDS.length

  return PAPER_WALLET_STRATEGY_IDS.map(sid => {
    const unreal = uByStrat.get(sid) ?? 0
    const margin = mByStrat.get(sid) ?? 0
    const cash = M > 0 ? cashPool * (margin / M) : cashPool / nSlot
    return {
      strategyId: sid,
      cash,
      unrealized: unreal,
      equity: cash + unreal,
    }
  })
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
