/**
 * Terminal UI (TUI) — Full-screen trading terminal dashboard using ink.
 *
 * Layout:
 *   ┌─ Header Bar ──────────────────────────────────────────────┐
 *   ├─ Account ──────────┬─ Strategy ──┬─ System ──────────────┤
 *   ├─ Positions (½) │ Watchlist (½) — side-by-side tables ────┤
 *   └──────────────────────────────────────────────────────────-┘
 *
 * Data sources: all in-process singletons (agent, pipeline, health, positions, exchange).
 * Refresh: 1s interval.
 */

import React, { useState, useEffect, useMemo, memo, useRef } from 'react'
import { render, Box, Text, useApp, useInput, useStdout } from 'ink'
import type { AgentSnapshot } from '../agent/types.js'
import type { StatusSnapshot } from '../strategy/orchestrator.js'
import { getEffectivePaperTrade, WS_MAX_SUBSCRIPTIONS, TIMEFRAMES, MIN_CANDLES_FOR_SCAN, PAPER_WALLET_STRATEGY_IDS } from '../config.js'
import { candleCount } from '../feed/store.js'
import type { CandleInterval, ActiveSetup } from '../types.js'
import type { InvalidationBridgeStats } from '../agent/invalidation-bridge.js'

// ─── Types ──────────────────────────────────────────────────────────────────

/** One simulated wallet in paper mode (matches a live strategy wallet). */
export interface PaperWalletRow {
  strategyId: string
  balance: number
  tradeCount: number
  wins: number
  losses: number
  winRate: number
}

export interface PaperStats {
  /** Sum of per-strategy paper balances (cash, excludes open uPnL in this field) */
  totalBalance: number
  wallets: PaperWalletRow[]
  tradeCount: number
  wins: number
  losses: number
  winRate: number
}

export interface AssetPrice {
  markPrice: number
  funding: number
  /** % move from today's 00:00 UTC open (1d candle `o`) to mark; null if no 1d data. */
  dayChangePctUtc: number | null
}

export interface TuiDataSources {
  getAgentSnapshot: () => AgentSnapshot
  getPositions: () => Map<string, { coin: string; side: 'long' | 'short'; leverage: number; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
  getStatus: () => StatusSnapshot[]
  getHealthReport: () => { overall: string; uptime: number; rssBytes: number; components: { feed: { status: string; consecutiveErrors: number }; db: { status: string; consecutiveErrors: number }; exchange: { status: string; consecutiveErrors: number } } }
  getAccountState: () => Promise<{ effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number }> | null
  getSubscriptionCount: () => number
  getTrackedCoins: () => string[]
  getPaperStats: () => PaperStats | null
  getAssetPrice: (coin: string) => AssetPrice | null
  getActiveSetups: () => ActiveSetup[]
  /** Invalidation bridge: matched vs skipped per strategy (live session). */
  getInvalidationStats: () => InvalidationBridgeStats
}

// ─── State (module-level for backfill progress) ─────────────────────────────

let backfillDoneListeners: Array<() => void> = []
let inkInstance: ReturnType<typeof render> | null = null
let _backfillDone = false

/** Call from index.ts when backfill completes → TUI transitions to dashboard. */
export function setBackfillDone(): void {
  _backfillDone = true
  for (const l of backfillDoneListeners) l()
}

// ─── Theme ──────────────────────────────────────────────────────────────────

const BORDER_COLOR = 'gray'

/** Short label for paper wallet rows (L/Q/S). */
function paperWalletShortLabel(strategyId: string): string {
  if (strategyId === 'layered') return 'L'
  if (strategyId === 'quant') return 'Q'
  if (strategyId === 'smc-sd') return 'S'
  return strategyId.slice(0, 3)
}
const TITLE_COLOR = 'white'
const ACCENT = 'cyan'
const DIM = 'gray'

/** Watchlist: space between columns (10 cols → 9 gaps). Budget subtracted before width math. */
const WL_GAP = 1
const WL_COL_GAPS = 9

/** Positions: 8 columns → 7 explicit gap boxes (Ink marginRight is unreliable in flex rows). */
const POS_GAP = 2
const POS_COL_GAPS = 7

/**
 * Row counts for Positions / Watchlist (side-by-side strip shares full remaining height).
 */
function computeTuiLayout(termRows: number): {
  positionsRowsPerCol: number
  watchlistRowsPerCol: number
} {
  const RESERVED_TOP = 20 // header + Account / Strategies / Buddy / System row
  const contentBudget = Math.max(12, termRows - RESERVED_TOP)
  const innerLines = Math.max(3, contentBudget - 3)

  const positionsRowsPerCol = Math.max(3, Math.min(14, Math.floor(innerLines / 2)))
  const watchlistRowsPerCol = Math.max(4, Math.min(32, Math.floor(innerLines / 2)))

  return { positionsRowsPerCol, watchlistRowsPerCol }
}

/** Inner content width for one Panel in the left/right split (border + padding). */
function computeHalfInnerWidth(termCols: number): number {
  const half = Math.floor(termCols / 2)
  return Math.max(22, half - 6)
}

type PositionsColumnWidths = {
  coin: number
  lev: number
  side: number
  entry: number
  sl: number
  tp: number
  upnl: number
  strategy: number
}

type WatchlistColumnWidths = {
  coin: number
  grade: number
  setups: number
  price: number
  dayPct: number
  fund: number
  tfCell: number
}

/** Fit integer column widths to `total` chars; `ideal` / `minimum` sums define scale. */
function distributeColumnWidths(
  total: number,
  ideal: Record<string, number>,
  minimum: Record<string, number>
): Record<string, number> {
  const keys = Object.keys(ideal)
  const sumIdeal = keys.reduce((s, k) => s + ideal[k]!, 0)
  const sumMin = keys.reduce((s, k) => s + minimum[k]!, 0)

  if (total <= sumMin) {
    return { ...minimum }
  }

  const out: Record<string, number> = {}
  if (total >= sumIdeal) {
    let extra = total - sumIdeal
    for (const k of keys) {
      out[k] = ideal[k]!
    }
    const prio = [...keys].sort((a, b) => ideal[b]! - ideal[a]!)
    let i = 0
    while (extra > 0) {
      out[prio[i % prio.length]!]!++
      extra--
      i++
    }
    return out
  }

  const t = (total - sumMin) / (sumIdeal - sumMin)
  let allocated = 0
  for (const k of keys) {
    const span = ideal[k]! - minimum[k]!
    out[k] = minimum[k]! + Math.floor(t * span)
    allocated += out[k]!
  }
  let diff = total - allocated
  const prio = [...keys].sort((a, b) => (ideal[b]! - minimum[b]!) - (ideal[a]! - minimum[a]!))
  let pi = 0
  while (diff > 0) {
    out[prio[pi % prio.length]!]!++
    diff--
    pi++
  }
  while (diff < 0) {
    const k = prio[pi % prio.length]!
    if (out[k]! > minimum[k]!) {
      out[k]!--
      diff++
    }
    pi++
    if (pi > 200) break
  }
  return out
}

const POS_COL_IDEAL: PositionsColumnWidths = {
  /** "SIDE" is 4 chars — keep narrow so ENTRY does not float far right of L/S. */
  coin: 12, lev: 4, side: 4, entry: 11, sl: 11, tp: 11, upnl: 10, strategy: 18,
}
const POS_COL_MIN: PositionsColumnWidths = {
  coin: 6,
  lev: 3,
  side: 4,
  entry: 6,
  sl: 6,
  tp: 6,
  /** Room for flash arrow + signed PnL (e.g. ^+999.99). */
  upnl: 8,
  /** "STRATEGY" is 8 chars — below this, header is clipped. */
  strategy: 8,
}

function buildPositionsColumnWidths(inner: number): PositionsColumnWidths {
  const innerNet = Math.max(22, inner - POS_COL_GAPS * POS_GAP)
  const flat = distributeColumnWidths(
    innerNet,
    { ...POS_COL_IDEAL },
    { ...POS_COL_MIN }
  ) as PositionsColumnWidths
  let sum = Object.values(flat).reduce((a, b) => a + b, 0)
  let rem = innerNet - sum
  const grow: (keyof PositionsColumnWidths)[] = ['strategy', 'coin', 'entry', 'sl', 'tp', 'upnl', 'lev', 'side']
  let gi = 0
  while (rem > 0) {
    flat[grow[gi % grow.length]!]!++
    rem--
    gi++
  }
  while (rem < 0) {
    let done = false
    for (const k of ['strategy', 'coin', 'entry', 'sl', 'tp', 'upnl', 'lev', 'side'] as const) {
      if (flat[k]! > POS_COL_MIN[k]!) {
        flat[k]!--
        rem++
        done = true
        break
      }
    }
    if (!done) break
  }
  return flat
}

function buildWatchlistColumnWidths(inner: number): WatchlistColumnWidths {
  const innerNet = Math.max(22, inner - WL_COL_GAPS * WL_GAP)
  const ideal = { coin: 12, grade: 5, setups: 5, price: 13, dayPct: 9, fund: 10, tfBlock: 40 }
  const minimum = { coin: 6, grade: 3, setups: 2, price: 7, dayPct: 5, fund: 7, tfBlock: 16 }
  const flat = distributeColumnWidths(innerNet, ideal, minimum)
  let tfCell = Math.max(3, Math.floor(flat.tfBlock / 4))
  const cols: WatchlistColumnWidths = {
    coin: flat.coin,
    grade: flat.grade,
    setups: flat.setups,
    price: flat.price,
    dayPct: flat.dayPct,
    fund: flat.fund,
    tfCell,
  }
  let sum = cols.coin + cols.grade + cols.setups + cols.price + cols.dayPct + cols.fund + 4 * cols.tfCell
  let rem = innerNet - sum
  while (rem > 0) {
    if (rem >= 4) {
      cols.tfCell++
      rem -= 4
    } else {
      cols.coin++
      rem--
    }
  }
  while (rem < 0) {
    if (rem <= -4 && cols.tfCell > 3) {
      cols.tfCell--
      rem += 4
    } else if (cols.coin > minimum.coin) {
      cols.coin--
      rem++
    } else if (cols.price > minimum.price) {
      cols.price--
      rem++
    } else if (cols.fund > minimum.fund) {
      cols.fund--
      rem++
    } else if (cols.dayPct > minimum.dayPct) {
      cols.dayPct--
      rem++
    } else if (cols.tfCell > 3) {
      cols.tfCell--
      rem += 4
    } else break
  }
  return cols
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function uptimeStr(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

function statusDot(status: string): string {
  if (status === 'ok') return '\u25CF'       // ●
  if (status === 'degraded') return '\u25CB'  // ○
  return '\u25CF'                              // ●
}

function statusColor(status: string): 'green' | 'yellow' | 'red' {
  if (status === 'ok') return 'green'
  if (status === 'degraded') return 'yellow'
  return 'red'
}

function timeNow(): string {
  return new Date().toISOString().slice(11, 19) // HH:mm:ss
}

function truncateStr(str: string, max: number): string {
  if (str.length <= max) return str
  if (max <= 1) return '\u2026'
  return str.slice(0, max - 1) + '\u2026'
}

/**
 * Ink 6 `<Text>` defaults to flexShrink:1 + wrap — table cells shift and break lines.
 * Lock each column with Box width + truncate.
 * Use `trailingGap` (empty Box) for column spacing — marginRight on flex children is easy to lose in Yoga/Ink.
 */
function TableCell({ w, children, marginRight = 0, trailingGap, ...textProps }: {
  w: number
  /** Watchlist still uses this; same effect as trailingGap when set. */
  marginRight?: number
  trailingGap?: number
  children: React.ReactNode
} & React.ComponentProps<typeof Text>) {
  const gap = trailingGap ?? marginRight
  return (
    <>
      <Box width={w} flexShrink={0}>
        <Text wrap="truncate-end" {...textProps}>{children}</Text>
      </Box>
      {gap > 0 ? <Box width={gap} flexShrink={0} /> : null}
    </>
  )
}

// ─── Components ─────────────────────────────────────────────────────────────

function Panel({ title, children, width, height, minHeight, flexGrow, flexShrink }: {
  title: string
  children: React.ReactNode
  width?: string | number
  height?: number
  minHeight?: number
  flexGrow?: number
  flexShrink?: number
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BORDER_COLOR}
      width={width ?? (flexGrow != null ? undefined : '100%')}
      height={height}
      minHeight={minHeight}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold color={TITLE_COLOR}>{title}</Text>
      {children}
    </Box>
  )
}

// ─── Header ─────────────────────────────────────────────────────────────────

const HeaderBar = memo(function HeaderBar({ snapshot, coinCount }: { snapshot: AgentSnapshot; coinCount: number }) {
  const mode = getEffectivePaperTrade() ? 'PAPER' : 'LIVE'
  const modeColor = getEffectivePaperTrade() ? 'yellow' : 'red'
  const paused = snapshot.global.globalPaused
  const uptime = uptimeStr(snapshot.global.uptime)
  const time = timeNow()

  // Count active coins (non-IDLE)
  const activeCount = Object.values(snapshot.coins).filter(c => c.state !== 'IDLE').length

  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1} justifyContent="space-between">
      <Box>
        <Text bold color={ACCENT}>MINH</Text>
        <Text color={DIM}> (明) </Text>
        <Text bold color={modeColor}>[{mode}]</Text>
        {paused && <Text bold color="red"> HALTED</Text>}
      </Box>
      <Box>
        <Text color={DIM}>{coinCount} coins </Text>
        <Text color={DIM}>| </Text>
        <Text color={activeCount > 0 ? 'cyan' : DIM}>{activeCount} active </Text>
        <Text color={DIM}>| </Text>
        <Text color={DIM}>up {uptime} </Text>
        <Text color={DIM}>| </Text>
        <Text color={DIM}>{time}</Text>
      </Box>
    </Box>
  )
})

// ─── Account ────────────────────────────────────────────────────────────────

/** Per-strategy paper row: cash (realized) + uPnL allocated from open positions. */
type PaperWalletBreakdownRow = {
  strategyId: string
  cash: number
  unrealized: number
  equity: number
}

/** Sum realized day P&L across the three paper wallets (orchestrator per-strategy globals). */
function sumPaperStrategiesDailyPnl(strategyGlobals: AgentSnapshot['strategyGlobals'] | undefined): number {
  if (!strategyGlobals) return 0
  let s = 0
  for (const id of PAPER_WALLET_STRATEGY_IDS) {
    s += strategyGlobals[id]?.dailyPnl ?? 0
  }
  return s
}

const AccountPanel = memo(function AccountPanel({
  account,
  dailyPnlGlobal,
  unrealizedPnl,
  paperStats,
  paperDerived,
  paperWalletBreakdown,
  strategyGlobals,
  paperMarginByStrategy,
}: {
  account: { effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null
  /** Legacy single global (live / default strategy); paper ALL uses Σ strategyGlobals. */
  dailyPnlGlobal: number
  unrealizedPnl: number
  paperStats: PaperStats | null
  paperDerived: { marginUsed: number; available: number } | null
  paperWalletBreakdown: PaperWalletBreakdownRow[] | null
  strategyGlobals: AgentSnapshot['strategyGlobals'] | undefined
  /** Open-position margin notional/leverage by strategyId (paper). */
  paperMarginByStrategy: Map<string, number> | null
}) {
  const [accountPage, setAccountPage] = useState(0) // 0 ALL, 1..3 → PAPER_WALLET_STRATEGY_IDS[i-1]

  const isPaper = paperStats != null && paperWalletBreakdown != null && paperWalletBreakdown.length > 0

  useInput((input) => {
    if (!isPaper) return
    const ch = input.toLowerCase()
    if (ch === 'z') setAccountPage(p => (p - 1 + 4) % 4)
    if (input === '/') setAccountPage(p => (p + 1) % 4)
  })

  const walletRowByStrategy = (sid: string): PaperWalletRow | undefined =>
    paperStats?.wallets.find(w => w.strategyId === sid)

  const totalEquity = paperStats != null
    ? paperStats.totalBalance + unrealizedPnl
    : (account?.effectiveBalance ?? null)

  const portfolioMargin = paperStats != null && paperDerived != null
    ? paperDerived.marginUsed
    : (account?.totalMarginUsed ?? null)
  const portfolioAvail = paperStats != null && paperDerived != null
    ? paperDerived.available
    : (account?.withdrawable ?? null)

  const dailyAll = isPaper ? sumPaperStrategiesDailyPnl(strategyGlobals) : dailyPnlGlobal
  const uAll = unrealizedPnl

  const renderPagerFooter = () => {
    if (!isPaper) return null
    const labels: Array<{ key: string; idx: number }> = [
      { key: 'ALL', idx: 0 },
      { key: '1', idx: 1 },
      { key: '2', idx: 2 },
      { key: '3', idx: 3 },
    ]
    return (
      <Box justifyContent="center" marginTop={1}>
        <Text color={DIM}>Z </Text>
        {labels.map((L, i) => (
          <React.Fragment key={L.key}>
            {i > 0 && <Text color={DIM}> | </Text>}
            <Text bold={accountPage === L.idx} color={accountPage === L.idx ? ACCENT : DIM}>{L.key}</Text>
          </React.Fragment>
        ))}
        <Text color={DIM}> /</Text>
      </Box>
    )
  }

  const pnlColor = (pnl: number): 'green' | 'red' => (pnl >= 0 ? 'green' : 'red')

  // ── Live (non-paper): unchanged single view ──────────────────────────────
  if (!isPaper) {
    const pnlColorG = dailyPnlGlobal >= 0 ? 'green' : 'red'
    const pnlSign = dailyPnlGlobal >= 0 ? '+' : ''
    const uPnlColor = unrealizedPnl >= 0 ? 'green' : 'red'
    const uPnlSign = unrealizedPnl >= 0 ? '+' : ''
    const balance = account?.effectiveBalance ?? null
    return (
      <Panel title="Account" flexGrow={1}>
        <Box justifyContent="space-between">
          <Text>Balance</Text>
          <Text bold>{balance != null ? `$${balance.toFixed(2)}` : '---'}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text>Margin</Text>
          <Text>{portfolioMargin != null ? `$${portfolioMargin.toFixed(2)}` : '---'}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text>Available</Text>
          <Text color="green">{portfolioAvail != null ? `$${portfolioAvail.toFixed(2)}` : '---'}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={DIM}>Day P&L</Text>
          <Text bold color={pnlColorG}>{pnlSign}${dailyPnlGlobal.toFixed(2)}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={DIM}>Unreal.</Text>
          <Text color={uPnlColor}>{uPnlSign}${unrealizedPnl.toFixed(2)}</Text>
        </Box>
      </Panel>
    )
  }

  // ── Paper: paged ALL | 1 | 2 | 3 ───────────────────────────────────────
  const pageIdx = accountPage === 0 ? -1 : accountPage - 1
  const sid = pageIdx >= 0 ? PAPER_WALLET_STRATEGY_IDS[pageIdx] : undefined
  const wBreak = sid ? paperWalletBreakdown!.find(w => w.strategyId === sid) : undefined
  const wStats = sid ? walletRowByStrategy(sid) : null

  const dailyShown = accountPage === 0
    ? dailyAll
    : (strategyGlobals?.[sid!]?.dailyPnl ?? 0)
  const unrealShown = accountPage === 0 ? uAll : (wBreak?.unrealized ?? 0)
  const equityShown = accountPage === 0
    ? totalEquity
    : (wBreak?.equity ?? paperStats!.wallets.find(w => w.strategyId === sid)?.balance ?? 0)

  const marginShown = accountPage === 0
    ? portfolioMargin
    : (paperMarginByStrategy != null && sid != null
      ? paperMarginByStrategy.get(sid) ?? 0
      : null)
  const availShown = accountPage === 0
    ? portfolioAvail
    : (wBreak != null && marginShown != null
      ? Math.max(0, wBreak.equity - marginShown)
      : null)

  const dSign = dailyShown >= 0 ? '+' : ''
  const uSign = unrealShown >= 0 ? '+' : ''

  const title = accountPage === 0
    ? 'Account'
    : `Account ${paperWalletShortLabel(sid!)}`

  return (
    <Panel title={title} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>Equity</Text>
        <Text bold>{equityShown != null ? `$${equityShown.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text>Margin</Text>
        <Text>{marginShown != null ? `$${marginShown.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text>Available</Text>
        <Text color="green">{availShown != null ? `$${availShown.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Day P&L</Text>
        <Text bold color={pnlColor(dailyShown)}>{dSign}${dailyShown.toFixed(2)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Unreal.</Text>
        <Text color={pnlColor(unrealShown)}>{uSign}${unrealShown.toFixed(2)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Trades</Text>
        <Text>
          {accountPage === 0 ? (
            <>
              <Text color="green">{paperStats!.wins}W</Text>
              <Text color={DIM}>/</Text>
              <Text color="red">{paperStats!.losses}L</Text>
              <Text> </Text>
              <Text color={ACCENT}>{(paperStats!.winRate * 100).toFixed(0)}%</Text>
            </>
          ) : wStats ? (
            <>
              <Text color="green">{wStats.wins}W</Text>
              <Text color={DIM}>/</Text>
              <Text color="red">{wStats.losses}L</Text>
              <Text> </Text>
              <Text color={ACCENT}>{(wStats.winRate * 100).toFixed(0)}%</Text>
            </>
          ) : (
            <Text color={DIM}>—</Text>
          )}
        </Text>
      </Box>
      {renderPagerFooter()}
    </Panel>
  )
})

// ─── System ─────────────────────────────────────────────────────────────────

const SystemPanel = memo(function SystemPanel({ report, subCount }: {
  report: TuiDataSources['getHealthReport'] extends () => infer R ? R : never
  subCount: number
}) {
  const rss = (report.rssBytes / 1024 / 1024).toFixed(0)
  const subPct = ((subCount / WS_MAX_SUBSCRIPTIONS) * 100).toFixed(0)

  return (
    <Panel title="System" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={DIM}>Feed</Text>
        <Text color={statusColor(report.components.feed.status)}>{statusDot(report.components.feed.status)} {report.components.feed.status}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Database</Text>
        <Text color={statusColor(report.components.db.status)}>{statusDot(report.components.db.status)} {report.components.db.status}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Exchange</Text>
        <Text color={statusColor(report.components.exchange.status)}>{statusDot(report.components.exchange.status)} {report.components.exchange.status}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Memory</Text>
        <Text>{rss} MB</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>WS Subs</Text>
        <Text>{subCount}<Text color={DIM}>/{WS_MAX_SUBSCRIPTIONS} ({subPct}%)</Text></Text>
      </Box>
    </Panel>
  )
})

// ─── Positions ──────────────────────────────────────────────────────────────

function positionsStrategyHeader(w: number): string {
  const t = 'STRATEGY'
  const s = w >= t.length ? t : t.slice(0, Math.max(1, w))
  return s.padEnd(w)
}

const PositionRow = memo(function PositionRow({ p, PC, getAssetPrice, priceTick }: {
  p: { coin: string; side: 'long' | 'short'; leverage: number; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }
  PC: { coin: number; lev: number; side: number; entry: number; sl: number; tp: number; upnl: number; strategy: number }
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Bumps every UI tick so memo() re-renders when mark price changes (position `p` ref is stable). */
  priceTick: number
}) {
  const asset = getAssetPrice(p.coin)
  const upnl = asset
    ? (asset.markPrice - p.entryPrice) * Math.abs(p.currentSize) * (p.side === 'long' ? 1 : -1)
    : null
  const upnlFlash = useFlashOnChange(upnl)
  const upnlArrow = upnlFlash === 'up' ? '^' : upnlFlash === 'down' ? 'v' : ' '
  const upnlBody = upnl != null
    ? `${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}`
    : '—'
  const upnlStr = `${upnlArrow}${upnlBody}`.padStart(PC.upnl)
  const upnlColor: 'green' | 'red' | undefined = upnl != null
    ? (upnlFlash === 'up' ? 'green' : upnlFlash === 'down' ? 'red' : (upnl >= 0 ? 'green' : 'red'))
    : undefined

  const strat = truncateStr(p.strategyId, PC.strategy).padEnd(PC.strategy)
  const levStr = `${p.leverage}x`.padEnd(PC.lev)

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={PC.coin} trailingGap={POS_GAP} bold>{p.coin.padEnd(PC.coin)}</TableCell>
      <TableCell w={PC.lev} trailingGap={POS_GAP} color={DIM}>{levStr}</TableCell>
      <TableCell w={PC.side} trailingGap={POS_GAP} bold color={p.side === 'long' ? 'green' : 'red'}>
        {p.side.slice(0, 1).toUpperCase().padEnd(PC.side)}
      </TableCell>
      <TableCell w={PC.entry} trailingGap={POS_GAP} color={ACCENT}>{formatUsd(p.entryPrice).padStart(PC.entry)}</TableCell>
      <TableCell w={PC.sl} trailingGap={POS_GAP} color="red">{formatUsd(p.slPrice).padStart(PC.sl)}</TableCell>
      <TableCell w={PC.tp} trailingGap={POS_GAP} color="green">{formatUsd(p.tpPrice).padStart(PC.tp)}</TableCell>
      <TableCell w={PC.upnl} trailingGap={POS_GAP} {...(upnlColor != null ? { color: upnlColor } : {})}>{upnlStr}</TableCell>
      <TableCell w={PC.strategy} color={DIM}>{strat}</TableCell>
    </Box>
  )
})

const PositionsPanel = memo(function PositionsPanel({ positions, getAssetPrice, rowsPerCol, pc, priceTick }: {
  positions: Array<{ coin: string; side: 'long' | 'short'; leverage: number; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Max rows per page (single full-width table; was “per column” when split). */
  rowsPerCol: number
  pc: PositionsColumnWidths
  /** 1s UI clock — forces PositionRow to re-read mark for UPNL (memo + stable `p` ref). */
  priceTick: number
}) {
  const [page, setPage] = useState(0) // 0 = first page
  const total = positions.length
  const pageSize = Math.max(2, rowsPerCol * 2)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // [ = prev page, ] = next page
  useInput((input) => {
    if (input === '[') setPage(p => Math.max(0, p - 1))
    if (input === ']') setPage(p => Math.min(p + 1, totalPages - 1))
  })

  // Clamp page when positions shrink (e.g. position closed)
  const clampedPage = Math.min(page, totalPages - 1)

  const header = (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={pc.coin} trailingGap={POS_GAP} color={DIM}>{'COIN'.padEnd(pc.coin)}</TableCell>
      <TableCell w={pc.lev} trailingGap={POS_GAP} color={DIM}>{'LEV'.padEnd(pc.lev)}</TableCell>
      <TableCell w={pc.side} trailingGap={POS_GAP} color={DIM}>{'SIDE'.padEnd(pc.side)}</TableCell>
      <TableCell w={pc.entry} trailingGap={POS_GAP} color={DIM}>{'ENTRY'.padStart(pc.entry)}</TableCell>
      <TableCell w={pc.sl} trailingGap={POS_GAP} color={DIM}>{'SL'.padStart(pc.sl)}</TableCell>
      <TableCell w={pc.tp} trailingGap={POS_GAP} color={DIM}>{'TP'.padStart(pc.tp)}</TableCell>
      <TableCell w={pc.upnl} trailingGap={POS_GAP} color={DIM}>{'UPNL'.padStart(pc.upnl)}</TableCell>
      <TableCell w={pc.strategy} color={DIM}>{positionsStrategyHeader(pc.strategy)}</TableCell>
    </Box>
  )
  const renderRow = (p: typeof positions[number]) => (
    <PositionRow key={`${p.coin}-${p.strategyId}`} p={p} PC={pc} getAssetPrice={getAssetPrice} priceTick={priceTick} />
  )
  /** One full-width table shows up to `pageSize` rows (was 2× columns). */
  const panelMinH = pageSize + 3

  if (total === 0) {
    return (
      <Box flexGrow={1} flexShrink={1} width="100%" minHeight={0}>
        <Panel title="Positions" flexGrow={1} minHeight={panelMinH} flexShrink={1}>
          <Text color={DIM}>No open positions</Text>
        </Panel>
      </Box>
    )
  }

  const startIdx = clampedPage * pageSize
  const pagePositions = positions.slice(startIdx, startIdx + pageSize)

  const pageInfo = totalPages > 1
    ? ` [/]  ${clampedPage + 1}/${totalPages}`
    : ''
  const rangeEnd = Math.min(startIdx + pagePositions.length, total)
  const title = `Positions ${startIdx + 1}-${rangeEnd} (${total})${pageInfo}`

  return (
    <Box flexGrow={1} width="100%">
      <Panel title={title} flexGrow={1} minHeight={panelMinH} flexShrink={1}>
        {header}
        {pagePositions.map(renderRow)}
      </Panel>
    </Box>
  )
})

// ─── Watchlist ───────────────────────────────────────────────────────────────

/** Flash green / red for one tick when a numeric value changes (Bias TF style). */
function useFlashOnChange(value: number | null | undefined): 'up' | 'down' | null {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  const prev = useRef<number | null>(null)
  useEffect(() => {
    if (value == null || typeof value !== 'number' || Number.isNaN(value)) {
      prev.current = value ?? null
      return
    }
    const p = prev.current
    prev.current = value
    if (p == null || Number.isNaN(p)) return
    if (value > p) {
      setFlash('up')
      const t = setTimeout(() => setFlash(null), 700)
      return () => clearTimeout(t)
    }
    if (value < p) {
      setFlash('down')
      const t = setTimeout(() => setFlash(null), 700)
      return () => clearTimeout(t)
    }
  }, [value])
  return flash
}

type TFSnapshot = { regime: string; bias: string }
type CoinInfo = {
  grade: string
  setups: number
  tfs: Record<string, TFSnapshot>
  price: number | null
  funding: number | null
  dayChangePctUtc: number | null
}

const DISPLAY_TFS = ['15m', '1h', '4h', '1d'] as const

function aggregateCoins(statuses: StatusSnapshot[], getAssetPrice: (coin: string) => AssetPrice | null): Map<string, CoinInfo> {
  const byCoin = new Map<string, CoinInfo>()
  for (const s of statuses) {
    let info = byCoin.get(s.coin)
    if (!info) {
      info = {
        grade: '\u2014',
        setups: 0,
        tfs: {},
        price: null,
        funding: null,
        dayChangePctUtc: null,
      }
      byCoin.set(s.coin, info)
    }
    const asset = getAssetPrice(s.coin)
    if (asset) {
      info.price = asset.markPrice
      info.funding = asset.funding
      info.dayChangePctUtc = asset.dayChangePctUtc
    }
    info.setups += s.activeCount
    if (s.confluenceGrade) {
      info.grade = `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}`
    }
    if ((DISPLAY_TFS as readonly string[]).includes(s.interval)) {
      info.tfs[s.interval] = { regime: s.regime, bias: s.bias }
    }
  }
  return byCoin
}


function regimeLabel(regime: string): string {
  switch (regime) {
    case 'BULL': return 'BULL'
    case 'BEAR': return 'BEAR'
    case 'VOLATILE': return 'VOLAT'
    case 'SIDEWAYS': return 'SIDE'
    default: return regime.toUpperCase().slice(0, 5)
  }
}

function regimeColor(regime: string): 'green' | 'red' | 'yellow' {
  if (regime === 'BULL') return 'green'
  if (regime === 'BEAR' || regime === 'VOLATILE') return 'red'
  return 'yellow'
}

/** ASCII-only — Unicode ▲▼◆ can be “wide” in some terminals and breaks fixed-width columns. */
function biasArrow(bias: string): string {
  if (bias === 'long' || bias === 'bullish') return '^'
  if (bias === 'short' || bias === 'bearish') return 'v'
  return '*'
}

function biasColor(bias: string): 'green' | 'red' | undefined {
  if (bias === 'long' || bias === 'bullish') return 'green'
  if (bias === 'short' || bias === 'bearish') return 'red'
  return undefined
}

function gradeColor(grade: string): 'magenta' | 'green' | 'cyan' | undefined {
  if (grade.startsWith('A+')) return 'magenta'
  if (grade.startsWith('A')) return 'green'
  if (grade.startsWith('B')) return 'cyan'
  return undefined
}

const WatchlistHeaderRow = memo(function WatchlistHeaderRow({ col }: { col: WatchlistColumnWidths }) {
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={col.coin} marginRight={WL_GAP} color={DIM}>{'COIN'.padEnd(col.coin)}</TableCell>
      <TableCell w={col.grade} marginRight={WL_GAP} color={DIM}>{'GRD'.padEnd(col.grade)}</TableCell>
      <TableCell w={col.setups} marginRight={WL_GAP} color={DIM}>{'#'.padEnd(col.setups)}</TableCell>
      <TableCell w={col.price} marginRight={WL_GAP} color={DIM}>{'PRICE'.padEnd(col.price)}</TableCell>
      <TableCell w={col.dayPct} marginRight={WL_GAP} color={DIM}>{'24H%'.padStart(col.dayPct)}</TableCell>
      <TableCell w={col.fund} marginRight={WL_GAP} color={DIM}>{'FUND'.padStart(col.fund)}</TableCell>
      {DISPLAY_TFS.map((tf, i) => (
        <TableCell key={tf} w={col.tfCell} marginRight={i < DISPLAY_TFS.length - 1 ? WL_GAP : 0} color={DIM}>{tf.toUpperCase().padStart(col.tfCell)}</TableCell>
      ))}
    </Box>
  )
})

function formatDayPct(pct: number): string {
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

function dayPctColor(pct: number): 'green' | 'red' | undefined {
  if (pct > 0.0005) return 'green'
  if (pct < -0.0005) return 'red'
  return undefined
}

function tfCellText(snap: TFSnapshot | undefined, tfW: number): { label: string; color: 'green' | 'red' | 'yellow' | undefined } {
  if (!snap) return { label: '\u2014'.padStart(tfW), color: undefined }
  const arrow = biasArrow(snap.bias)
  const r = regimeLabel(snap.regime)
  const raw = `${arrow}${r}`
  const label = raw.length <= tfW ? raw.padStart(tfW) : raw.slice(-tfW)
  return { label, color: biasColor(snap.bias) ?? regimeColor(snap.regime) }
}

function formatPrice(price: number): string {
  if (price <= 0) return '0'
  const exp = Math.floor(Math.log10(price))
  const decimals = Math.max(0, Math.min(8, 4 - exp))
  return price.toFixed(decimals)
}

function formatUsd(price: number): string {
  return `$${formatPrice(price)}`
}

function formatFunding(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`
}

function fundingColor(rate: number): 'green' | 'red' | undefined {
  if (rate > 0.0001) return 'green'   // positive = longs pay shorts
  if (rate < -0.0001) return 'red'
  return undefined
}

/** Left-aligned price + single blink column on the right (^/v/space). */
function formatWatchlistPriceCell(priceCore: string, colWidth: number, priceArrow: string): string {
  if (colWidth <= 1) return (priceCore + priceArrow).slice(0, colWidth)
  const bodyW = colWidth - 1
  const core = priceCore.length <= bodyW ? priceCore : priceCore.slice(0, bodyW)
  return (core.padEnd(bodyW) + priceArrow).slice(0, colWidth)
}

const WatchlistCoinRow = memo(function WatchlistCoinRow({ coin, info, col, priceTick }: { coin: string; info: CoinInfo | undefined; col: WatchlistColumnWidths; priceTick: number }) {
  const priceFlash = useFlashOnChange(info?.price ?? null)
  if (!info) {
    return (
      <Box flexDirection="row" flexWrap="nowrap">
        <TableCell w={col.coin} marginRight={WL_GAP} color={DIM}>{coin.padEnd(col.coin)}</TableCell>
        <TableCell w={col.grade} marginRight={WL_GAP} color={DIM}>{'\u2014'.padEnd(col.grade)}</TableCell>
        <TableCell w={col.setups} marginRight={WL_GAP} color={DIM}>{'0'.padEnd(col.setups)}</TableCell>
        <TableCell w={col.price} marginRight={WL_GAP} color={DIM}>{formatWatchlistPriceCell('\u2014', col.price, ' ')}</TableCell>
        <TableCell w={col.dayPct} marginRight={WL_GAP} color={DIM}>{'\u2014'.padStart(col.dayPct)}</TableCell>
        <TableCell w={col.fund} marginRight={WL_GAP} color={DIM}>{'\u2014'.padStart(col.fund)}</TableCell>
        {DISPLAY_TFS.map((tf, i) => (
          <TableCell key={tf} w={col.tfCell} marginRight={i < DISPLAY_TFS.length - 1 ? WL_GAP : 0} color={DIM}>{'\u2014'.padStart(col.tfCell)}</TableCell>
        ))}
      </Box>
    )
  }

  const rawPrice = info.price
  const priceCore = rawPrice != null ? formatUsd(rawPrice) : '\u2014'
  const priceArrow = priceFlash === 'up' ? '^' : priceFlash === 'down' ? 'v' : ' '
  const priceStr = formatWatchlistPriceCell(priceCore, col.price, priceArrow)
  const priceColor: 'green' | 'red' | 'cyan' =
    priceFlash === 'up' ? 'green' : priceFlash === 'down' ? 'red' : ACCENT

  const dayStr =
    info.dayChangePctUtc != null
      ? formatDayPct(info.dayChangePctUtc).padStart(col.dayPct)
      : '\u2014'.padStart(col.dayPct)
  const dCol = dayPctColor(info.dayChangePctUtc ?? 0)

  const fundStr = info.funding != null ? formatFunding(info.funding).padStart(col.fund) : '\u2014'.padStart(col.fund)

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={col.coin} marginRight={WL_GAP} bold>{coin.padEnd(col.coin)}</TableCell>
      <TableCell
        w={col.grade}
        marginRight={WL_GAP}
        bold={info.grade.startsWith('A')}
        {...(gradeColor(info.grade) != null ? { color: gradeColor(info.grade) } : {})}
      >
        {info.grade.padEnd(col.grade)}
      </TableCell>
      <TableCell w={col.setups} marginRight={WL_GAP}>{String(info.setups).padEnd(col.setups)}</TableCell>
      <TableCell w={col.price} marginRight={WL_GAP} color={priceColor}>{priceStr}</TableCell>
      <TableCell w={col.dayPct} marginRight={WL_GAP} {...(dCol != null ? { color: dCol } : {})}>{dayStr}</TableCell>
      <TableCell
        w={col.fund}
        marginRight={WL_GAP}
        {...(info.funding != null && fundingColor(info.funding) != null ? { color: fundingColor(info.funding) } : {})}
      >
        {fundStr}
      </TableCell>
      {DISPLAY_TFS.map((tf, i) => {
        const { label, color } = tfCellText(info.tfs[tf], col.tfCell)
        return (
          <TableCell key={tf} w={col.tfCell} marginRight={i < DISPLAY_TFS.length - 1 ? WL_GAP : 0} {...(color != null ? { color } : {})}>{label}</TableCell>
        )
      })}
    </Box>
  )
})

const WatchlistPanel = memo(function WatchlistPanel({ statuses, trackedCoins, getAssetPrice, rowsPerCol, col, priceTick }: {
  statuses: StatusSnapshot[]
  trackedCoins: string[]
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Rows per “logical column”; one full-width page shows up to `2 × rowsPerCol` coins. */
  rowsPerCol: number
  col: WatchlistColumnWidths
  /** 1s UI clock — `statuses` ref can be stable; re-aggregate marks + bust row memo. */
  priceTick: number
}) {
  const byCoin = useMemo(() => aggregateCoins(statuses, getAssetPrice), [statuses, getAssetPrice, priceTick])
  const [page, setPage] = useState(0)

  const pageSize = Math.max(2, rowsPerCol * 2)
  const panelMinH = pageSize + 3

  if (trackedCoins.length === 0) {
    return (
      <Box flexGrow={1} width="100%">
        <Panel title="Watchlist" flexGrow={1} minHeight={Math.max(6, panelMinH)}>
          <Text color={DIM}> No coins tracked</Text>
        </Panel>
      </Box>
    )
  }

  const total = trackedCoins.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // { = prev page, } = next page (avoids conflict with Positions [ ])
  useInput((input) => {
    if (input === '{') setPage(p => Math.max(0, p - 1))
    if (input === '}') setPage(p => Math.min(p + 1, totalPages - 1))
  })

  const clampedPage = Math.min(page, totalPages - 1)
  const startIdx = clampedPage * pageSize
  const pageCoins = trackedCoins.slice(startIdx, startIdx + pageSize)

  const pageInfo = totalPages > 1 ? ` {}/  ${clampedPage + 1}/${totalPages}` : ''
  const rangeEnd = Math.min(startIdx + pageCoins.length, total)
  const title = `Watchlist ${startIdx + 1}-${rangeEnd} (${total})${pageInfo}`

  return (
    <Box flexGrow={1} width="100%">
      <Panel title={title} flexGrow={1} minHeight={panelMinH} flexShrink={1}>
        <WatchlistHeaderRow col={col} />
        {pageCoins.map((coin: string) => (
          <WatchlistCoinRow key={coin} coin={coin} info={byCoin.get(coin)} col={col} priceTick={priceTick} />
        ))}
      </Panel>
    </Box>
  )
})

// ─── Strategy Panel ─────────────────────────────────────────────────────────

interface StrategySummary {
  strategyId: string
  totalCoins: number
  activeCoins: number
  setupCount: number
}

function aggregateStrategies(snapshot: AgentSnapshot, activeSetups: ActiveSetup[]): StrategySummary[] {
  const byStrategy = new Map<string, StrategySummary>()

  for (const [, coin] of Object.entries(snapshot.coins)) {
    const sid = coin.strategyId
    let s = byStrategy.get(sid)
    if (!s) {
      s = { strategyId: sid, totalCoins: 0, activeCoins: 0, setupCount: 0 }
      byStrategy.set(sid, s)
    }
    s.totalCoins++
    if (coin.state !== 'IDLE') s.activeCoins++
  }

  // Count current active setups per strategy.
  // Setup IDs are formatted as 'strategyId:coin|interval|type' — parse strategyId from prefix.
  for (const setup of activeSetups) {
    const sid = setup.id.split(':')[0] ?? 'unknown'
    let s = byStrategy.get(sid)
    if (!s) {
      s = { strategyId: sid, totalCoins: 0, activeCoins: 0, setupCount: 0 }
      byStrategy.set(sid, s)
    }
    s.setupCount++
  }

  return Array.from(byStrategy.values())
}

const StrategyPanel = memo(function StrategyPanel({ snapshot, activeSetups, invStats }: {
  snapshot: AgentSnapshot
  activeSetups: ActiveSetup[]
  invStats: InvalidationBridgeStats
}) {
  const strategies = useMemo(() => aggregateStrategies(snapshot, activeSetups), [snapshot, activeSetups])

  return (
    <Panel title="Strategies" flexGrow={1}>
      {strategies.length === 0 ? (
        <Text color={DIM}>No strategies</Text>
      ) : (
        <>
          {strategies.map(s => {
            const inv = invStats.byStrategy[s.strategyId]
            const m = inv?.matched ?? 0
            const sk = inv?.skipped ?? 0
            return (
              <Box key={s.strategyId} justifyContent="space-between">
                <Text bold color={ACCENT}>{s.strategyId.slice(0, 10)}</Text>
                <Text>
                  <Text color={s.activeCoins > 0 ? 'cyan' : DIM}>{s.activeCoins}</Text>
                  <Text color={DIM}>/{s.totalCoins} </Text>
                  {s.setupCount > 0 && <Text color="yellow">{s.setupCount} setups</Text>}
                  {s.setupCount === 0 && <Text color={DIM}>0 setups</Text>}
                  <Text color={DIM}> | inv </Text>
                  <Text color="green">{'\u2713'}{m}</Text>
                  <Text color={DIM}> </Text>
                  <Text color="yellow">{'\u2717'}{sk}</Text>
                </Text>
              </Box>
            )
          })}
          {invStats.parseFailed > 0 && (
            <Text color="yellow">inv parse err: {invStats.parseFailed}</Text>
          )}
        </>
      )}
    </Panel>
  )
})

// ─── Buddy Pet (明 Dragon) ──────────────────────────────────────────────────

type BuddyMood = 'idle' | 'scanning' | 'signal' | 'profit' | 'loss' | 'paused' | 'alert'

function getBuddyMood(snapshot: AgentSnapshot, positions: number, dailyPnl: number, signalCount: number): BuddyMood {
  if (snapshot.global.globalPaused) return 'paused'
  if (dailyPnl < -50) return 'loss'
  if (dailyPnl > 50) return 'profit'
  if (positions > 0) return 'alert'
  if (signalCount > 0) return 'signal'

  const activeCount = Object.values(snapshot.coins).filter(c => c.state !== 'IDLE').length
  if (activeCount > 0) return 'scanning'
  return 'idle'
}

// Each mood has multiple frames for animation (outer = frames, inner = 5 sprite lines)
const BUDDY_SPRITES: Record<BuddyMood, string[][]> = {
  idle: [
    // F0: eyes open (shown 9/10 ticks → blink every ~1s)
    ['   /\\_/\\  ', '  ( o.o ) ', '   > ^ <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    // F1: blink
    ['   /\\_/\\  ', '  ( -.- ) ', '   > ^ <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
  scanning: [
    // 4-frame eye scan: forward → right → forward → left (400ms cycle)
    ['   /\\_/\\  ', '  ( \u25C9.\u25C9 ) ', '   > ^ <  ', '  /| ~ |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  (  .\u25C9@) ', '   > ~ <  ', '  /| ~ |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( \u25C9.\u25C9 ) ', '   > ^ <  ', '  /| ~ |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  (@\u25C9.  ) ', '   > ~ <  ', '  /| ~ |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
  signal: [
    // 4-frame sparkle flash (400ms cycle)
    ['   /\\_/\\  ', '  ( \u2727.\u2727 ) ', '   > \u2605 <  ', ' \u26A1/|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( \u2605.\u2605 ) ', '   > \u2727 <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( \u2727.\u2727 ) ', '   > \u2605 <  ', ' \u26A1/|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( *.* ) ', '   > * <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
  profit: [
    // 4-frame happy bounce (400ms cycle)
    ['   /\\_/\\  ', '  ( ^.^ ) ', '   > w <  ', ' \u2728/|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ^o^ ) ', '   > W <  ', ' \u2728/|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ^.^ ) ', '   > w <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ^v^ ) ', '   > w <  ', ' \u2728/|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
  loss: [
    // 4-frame sad cycle (400ms cycle)
    ['   /\\_/\\  ', '  ( ;.; ) ', '   > n <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ;_; ) ', '   > ~ <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ;.; ) ', '   > n <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( ToT ) ', '   > ~ <  ', '  /|   |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
  paused: [
    // 4-frame growing zzZ (400ms cycle)
    ['   /\\_/\\  ', '  ( -.- ) ', '   > ~ <  ', '  /|   |\\ ', '  z       '],
    ['   /\\_/\\  ', '  ( -.- ) ', '   > ~ <  ', '  /|   |\\ ', '  zZ      '],
    ['   /\\_/\\  ', '  ( -_- ) ', '   > ~ <  ', '  /|   |\\ ', '  zZZ     '],
    ['   /\\_/\\  ', '  ( -.- ) ', '   > ~ <  ', '  /|   |\\ ', '  zZZZ    '],
  ],
  alert: [
    // 2-frame fast flash (200ms cycle)
    ['   /\\_/\\  ', '  ( \u25B2.\u25B2 ) ', '   > ! <  ', '  /| \u2191 |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
    ['   /\\_/\\  ', '  ( \u25CF.\u25CF ) ', '   > \u203C <  ', '  /| \u2191 |\\ ', '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 '],
  ],
}

const BUDDY_SPEECH: Record<BuddyMood, string[]> = {
  idle: ['Scanning...', 'Watching markets', 'All quiet', 'Waiting for setups'],
  scanning: ['Eyes on chart', 'Structure forming', 'Analyzing...', 'Reading PA'],
  signal: ['Setup found!', 'Signal detected!', 'Check this out!', 'Entry nearby!'],
  profit: ['Nice trade!', 'Green day!', 'Money printer go', 'We cooking!'],
  loss: ['Rough patch...', 'Stay disciplined', 'Part of the game', 'Next one...'],
  paused: ['Taking a break', 'System paused', 'Standing by...', 'Resting...'],
  alert: ['Position open!', 'Monitoring trade', 'Watching entry', 'In the market!'],
}

function getBuddySpeech(mood: BuddyMood, tick: number): string {
  const phrases = BUDDY_SPEECH[mood]
  return phrases[tick % phrases.length]!
}

const BuddyPanel = memo(function BuddyPanel({ mood, tick }: { mood: BuddyMood; tick: number }) {
  // Local 100ms animation tick — independent of the 1s main tick
  const [animTick, setAnimTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setAnimTick(t => t + 1), 100)
    return () => clearInterval(id)
  }, [])

  const frames = BUDDY_SPRITES[mood]
  // idle: blink for 100ms every 1s (1 frame out of 10)
  // alert: fast 200ms flash (2 frames)
  // others: cycle all frames at 100ms each
  const frameIdx = mood === 'idle'
    ? (animTick % 10 === 9 ? 1 : 0)
    : animTick % frames.length
  const sprite = frames[frameIdx]!
  const speech = getBuddySpeech(mood, tick)

  const moodColor: 'green' | 'red' | 'yellow' | 'cyan' | 'magenta' =
    mood === 'profit' ? 'green'
      : mood === 'loss' ? 'red'
        : mood === 'paused' ? 'yellow'
          : mood === 'signal' ? 'magenta'
            : mood === 'alert' ? 'cyan'
              : 'cyan'

  const bubbleWidth = Math.max(speech.length + 2, 12)
  const bubbleTop = '\u250C' + '\u2500'.repeat(bubbleWidth) + '\u2510'
  const bubbleBot = '\u2514' + '\u2500'.repeat(bubbleWidth) + '\u2518'
  const bubbleMid = '\u2502 ' + speech.padEnd(bubbleWidth - 1) + '\u2502'
  const pointer = '    \u2514\u2500\u2510'

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1} width={30} minHeight={9}>
      <Text bold color={TITLE_COLOR}>Buddy <Text color={moodColor}>[{mood.toUpperCase()}]</Text></Text>
      <Text color={DIM}>{bubbleTop}</Text>
      <Text color={DIM}>{bubbleMid}</Text>
      <Text color={DIM}>{bubbleBot}</Text>
      <Text color={DIM}>{pointer}</Text>
      {sprite.map((line, i) => (
        <Text key={i} color={moodColor}>{line}</Text>
      ))}
    </Box>
  )
})

// ─── Backfill Progress ─────────────────────────────────────────────────────

function countReadyTFs(coin: string): number {
  let count = 0
  for (const tf of TIMEFRAMES) {
    if (candleCount(coin, tf as CandleInterval) >= MIN_CANDLES_FOR_SCAN) count++
  }
  return count
}

const TOTAL_TFS_COUNT = TIMEFRAMES.length
const BAR_FILLED = '\u2588'  // █
const BAR_EMPTY = '\u2591'   // ░

function progressBar(done: number, total: number, width: number): string {
  const filled = Math.round((done / total) * width)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

function BackfillPanel({ trackedCoins, termWidth }: { trackedCoins: string[]; termWidth: number }) {
  const barWidth = Math.max(10, Math.min(40, termWidth - 25))
  let totalDone = 0
  const totalAll = trackedCoins.length * TOTAL_TFS_COUNT

  const rows = trackedCoins.map(coin => {
    const ready = countReadyTFs(coin)
    totalDone += ready
    const done = ready === TOTAL_TFS_COUNT
    return { coin, ready, done }
  })

  const pct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0

  return (
    <Box flexDirection="column" paddingLeft={2} paddingRight={2}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={ACCENT}>MINH</Text>
        <Text color={DIM}> (明) </Text>
        <Text color="yellow">Starting...</Text>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
        <Text bold color={TITLE_COLOR}>Backfill Progress</Text>
        <Text> </Text>
        {rows.map(r => (
          <Box key={r.coin}>
            <Text bold> {r.coin.padEnd(12)}</Text>
            <Text color={r.done ? 'green' : 'yellow'}>[{progressBar(r.ready, TOTAL_TFS_COUNT, barWidth)}]</Text>
            <Text color={r.done ? 'green' : DIM}> {r.ready}/{TOTAL_TFS_COUNT}</Text>
            {r.done && <Text color="green"> {'\u2713'}</Text>}
          </Box>
        ))}
        <Text> </Text>
        <Box justifyContent="center">
          <Text color={ACCENT}>Overall: {totalDone}/{totalAll} ({pct}%)</Text>
        </Box>
      </Box>
    </Box>
  )
}

// ─── Main App ───────────────────────────────────────────────────────────────

function App({ sources }: { sources: TuiDataSources }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termRows = stdout?.rows ?? 40
  const termCols = stdout?.columns ?? 120
  const [tick, setTick] = useState(0)
  const [account, setAccount] = useState<{ effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null>(null)
  const [isBackfillDone, setIsBackfillDone] = useState(_backfillDone)

  // Keyboard
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      process.emit('SIGINT' as any)
    }
  })

  // Refresh every 1s always — fast enough for live price/PnL updates
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Listen for backfill done signal
  useEffect(() => {
    if (_backfillDone) { setIsBackfillDone(true); return }
    const listener = () => setIsBackfillDone(true)
    backfillDoneListeners.push(listener)
    return () => { backfillDoneListeners = backfillDoneListeners.filter(l => l !== listener) }
  }, [])

  // Refresh account every 10s (only after backfill)
  useEffect(() => {
    if (!isBackfillDone) return
    const fetchAccount = async () => {
      try {
        const getter = sources.getAccountState()
        if (getter) {
          const acct = await getter
          setAccount(acct)
        }
      } catch {
        // Silently ignore
      }
    }
    fetchAccount()
    const id = setInterval(fetchAccount, 10_000)
    return () => clearInterval(id)
  }, [isBackfillDone])

  // All hooks MUST run before any conditional return (React rules of hooks)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trackedCoins = useMemo(() => sources.getTrackedCoins(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => sources.getAgentSnapshot(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => Array.from(sources.getPositions().values()), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statuses = useMemo(() => sources.getStatus(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const health = useMemo(() => sources.getHealthReport(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subCount = useMemo(() => sources.getSubscriptionCount(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paperStats = useMemo(() => sources.getPaperStats(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeSetups = useMemo(() => sources.getActiveSetups(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const invStats = useMemo(() => sources.getInvalidationStats(), [tick])

  const layout = useMemo(() => computeTuiLayout(termRows), [termRows])
  const halfInner = useMemo(() => computeHalfInnerWidth(termCols), [termCols])
  const positionsColumnWidths = useMemo(() => buildPositionsColumnWidths(halfInner), [halfInner])
  const watchlistColumnWidths = useMemo(() => buildWatchlistColumnWidths(halfInner), [halfInner])

  // Compute unrealized PnL from open positions + mark prices
  const unrealizedPnl = useMemo(() => {
    let total = 0
    for (const p of positions) {
      const asset = sources.getAssetPrice(p.coin)
      if (!asset) continue
      const direction = p.side === 'long' ? 1 : -1
      total += (asset.markPrice - p.entryPrice) * Math.abs(p.currentSize) * direction
    }
    return total
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, tick])

  const paperDerived = useMemo(() => {
    if (!paperStats) return null
    let marginUsed = 0
    for (const p of positions) {
      const asset = sources.getAssetPrice(p.coin)
      const mark = asset?.markPrice ?? p.entryPrice
      const notional = Math.abs(p.currentSize) * mark
      const lev = p.leverage > 0 ? p.leverage : 1
      marginUsed += notional / lev
    }
    const equity = paperStats.totalBalance + unrealizedPnl
    return { marginUsed, available: Math.max(0, equity - marginUsed) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperStats, positions, unrealizedPnl, tick])

  /** Allocate uPnL by strategy so per-wallet equity sums to total equity (when marks exist). */
  const paperWalletBreakdown = useMemo((): PaperWalletBreakdownRow[] | null => {
    if (!paperStats) return null
    const uByStrat = new Map<string, number>()
    for (const p of positions) {
      const asset = sources.getAssetPrice(p.coin)
      if (!asset) continue
      const direction = p.side === 'long' ? 1 : -1
      const u = (asset.markPrice - p.entryPrice) * Math.abs(p.currentSize) * direction
      uByStrat.set(p.strategyId, (uByStrat.get(p.strategyId) ?? 0) + u)
    }
    return paperStats.wallets.map(w => {
      const unreal = uByStrat.get(w.strategyId) ?? 0
      return {
        strategyId: w.strategyId,
        cash: w.balance,
        unrealized: unreal,
        equity: w.balance + unreal,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperStats, positions, tick])

  /** Paper: margin used per strategy (notional / leverage) for Account pages 1–3. */
  const paperMarginByStrategy = useMemo((): Map<string, number> | null => {
    if (!paperStats) return null
    const m = new Map<string, number>()
    for (const id of PAPER_WALLET_STRATEGY_IDS) m.set(id, 0)
    for (const p of positions) {
      const asset = sources.getAssetPrice(p.coin)
      const mark = asset?.markPrice ?? p.entryPrice
      const notional = Math.abs(p.currentSize) * mark
      const lev = p.leverage > 0 ? p.leverage : 1
      const mm = notional / lev
      m.set(p.strategyId, (m.get(p.strategyId) ?? 0) + mm)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperStats, positions, tick])

  // ── Backfill progress screen ──
  if (!isBackfillDone) {
    return (
      <Box flexDirection="column" height={termRows}>
        <BackfillPanel trackedCoins={trackedCoins} termWidth={termCols} />
        <Box flexGrow={1} />
        <Box justifyContent="center">
          <Text color={DIM}>Press q to quit</Text>
        </Box>
      </Box>
    )
  }

  // ── Normal dashboard ──
  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <HeaderBar snapshot={snapshot} coinCount={trackedCoins.length} />

      <Box flexShrink={0}>
        <AccountPanel
          account={account}
          dailyPnlGlobal={snapshot.global.dailyPnl}
          unrealizedPnl={unrealizedPnl}
          paperStats={paperStats}
          paperDerived={paperDerived}
          paperWalletBreakdown={paperWalletBreakdown}
          strategyGlobals={snapshot.strategyGlobals}
          paperMarginByStrategy={paperMarginByStrategy}
        />
        <StrategyPanel snapshot={snapshot} activeSetups={activeSetups} invStats={invStats} />
        <BuddyPanel mood={getBuddyMood(snapshot, positions.length, snapshot.global.dailyPnl, activeSetups.length)} tick={tick} />
        <SystemPanel report={health} subCount={subCount} />
      </Box>

      <Box flexDirection="row" flexGrow={1} minHeight={0} width="100%">
        <Box flexGrow={1} flexBasis="50%" minWidth={0} width="50%" flexDirection="column">
          <PositionsPanel
            positions={positions}
            getAssetPrice={sources.getAssetPrice}
            rowsPerCol={layout.positionsRowsPerCol}
            pc={positionsColumnWidths}
            priceTick={tick}
          />
        </Box>
        <Box flexGrow={1} flexBasis="50%" minWidth={0} width="50%" flexDirection="column">
          <WatchlistPanel
            statuses={statuses}
            trackedCoins={trackedCoins}
            getAssetPrice={sources.getAssetPrice}
            rowsPerCol={layout.watchlistRowsPerCol}
            col={watchlistColumnWidths}
            priceTick={tick}
          />
        </Box>
      </Box>
    </Box>
  )
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the TUI dashboard.
 * Call after all agent components are initialized.
 */
export function startTui(sources: TuiDataSources): void {
  inkInstance = render(<App sources={sources} />)
}

/**
 * No-op logger sink kept for API compatibility (index.ts calls setTuiSink(appendLog)).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function appendLog(_msg: string): void {}

/**
 * Stop the TUI and restore the terminal.
 */
export function stopTui(): void {
  if (inkInstance) {
    inkInstance.unmount()
    inkInstance = null
  }
  backfillDoneListeners = []
  _backfillDone = false
}

/** Whether the TUI is currently running. */
export function isTuiRunning(): boolean {
  return inkInstance !== null
}
