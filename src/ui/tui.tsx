/**
 * Terminal UI (TUI) — Full-screen trading terminal dashboard using ink.
 *
 * Layout:
 *   ┌─ Header Bar ──────────────────────────────────────────────┐
 *   ├─ Account ──────────┬─ Strategy ──┬─ System ──────────────┤
 *   ├─ Positions ─────────────────────────────────────────────  ┤
 *   ├─ Watchlist L ──────┬─ Watchlist R ────────────────────────┤
 *   ├─ Tape (Signal Log) ───────────────────────────────────────┤
 *   └──────────────────────────────────────────────────────────-┘
 *
 * Data sources: all in-process singletons (agent, pipeline, health, positions, exchange).
 * Refresh: 3s interval. Tape: event-driven via appendSignal().
 */

import React, { useState, useEffect, useMemo, memo } from 'react'
import { render, Box, Text, useApp, useInput, useStdout } from 'ink'
import type { AgentAction } from '../agent/types.js'
import type { AgentSnapshot } from '../agent/types.js'
import type { StatusSnapshot } from '../strategy/orchestrator.js'
import { formatAction } from './terminal.js'
import { PAPER_TRADE, WS_MAX_SUBSCRIPTIONS, TIMEFRAMES, MIN_CANDLES_FOR_SCAN } from '../config.js'
import { candleCount } from '../feed/store.js'
import type { CandleInterval, ActiveSetup } from '../types.js'
import type { InvalidationBridgeStats } from '../agent/invalidation-bridge.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PaperStats {
  balance: number
  tradeCount: number
  wins: number
  losses: number
  winRate: number
}

export interface AssetPrice {
  markPrice: number
  funding: number
}

export interface TuiDataSources {
  getAgentSnapshot: () => AgentSnapshot
  getPositions: () => Map<string, { coin: string; side: 'long' | 'short'; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
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

// ─── State (module-level for appendSignal + backfill progress) ─────────────

let signalListeners: Array<(line: string) => void> = []
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
const TITLE_COLOR = 'white'
const ACCENT = 'cyan'
const DIM = 'gray'

/**
 * Split vertical space between Positions / Watchlist / Tape from terminal height.
 * - Tall terminals → more rows for Watchlist (scan surface), modest Positions.
 * - Tape stays capped so it never dominates.
 */
function computeTuiLayout(termRows: number): {
  positionsRowsPerCol: number
  watchlistRowsPerCol: number
  tapeLines: number
} {
  // Header + Account/Strategies/Buddy/System row (tallest column ~Buddy): conservative
  const RESERVED_ABOVE = 16
  // Three stacked panels each: title + top/bottom border ≈ +3 lines vs content
  const PANEL_CHROME = 9

  const contentBudget = Math.max(10, termRows - RESERVED_ABOVE - PANEL_CHROME)

  let tapeLines = Math.max(3, Math.min(8, Math.round(contentBudget * 0.2)))

  const pair = contentBudget - tapeLines
  let watchlistRowsPerCol = Math.max(4, Math.min(24, Math.round(pair * 0.58)))
  let positionsRowsPerCol = Math.max(3, Math.min(10, Math.round(pair * 0.38)))

  let total = positionsRowsPerCol + watchlistRowsPerCol + tapeLines
  if (total > contentBudget) {
    let over = total - contentBudget
    const wShrink = Math.min(watchlistRowsPerCol - 4, over)
    watchlistRowsPerCol -= wShrink
    over -= wShrink
    if (over > 0) {
      const pShrink = Math.min(positionsRowsPerCol - 3, over)
      positionsRowsPerCol -= pShrink
      over -= pShrink
    }
    if (over > 0) {
      tapeLines = Math.max(3, tapeLines - over)
    }
  }

  return { positionsRowsPerCol, watchlistRowsPerCol, tapeLines }
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
  const mode = PAPER_TRADE ? 'PAPER' : 'LIVE'
  const modeColor = PAPER_TRADE ? 'yellow' : 'red'
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

const AccountPanel = memo(function AccountPanel({ account, dailyPnl, unrealizedPnl, paperStats }: {
  account: { effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null
  dailyPnl: number
  unrealizedPnl: number
  paperStats: PaperStats | null
}) {
  const pnlColor = dailyPnl >= 0 ? 'green' : 'red'
  const pnlSign = dailyPnl >= 0 ? '+' : ''
  const uPnlColor = unrealizedPnl >= 0 ? 'green' : 'red'
  const uPnlSign = unrealizedPnl >= 0 ? '+' : ''

  const balance = paperStats?.balance ?? account?.effectiveBalance ?? null
  const marginUsed = account?.totalMarginUsed ?? null
  const available = account?.withdrawable ?? null

  return (
    <Panel title="Account" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={DIM}>Balance</Text>
        <Text bold>{balance != null ? `$${balance.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Margin</Text>
        <Text>{marginUsed != null ? `$${marginUsed.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Available</Text>
        <Text color="green">{available != null ? `$${available.toFixed(2)}` : '---'}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Day P&L</Text>
        <Text bold color={pnlColor}>{pnlSign}${dailyPnl.toFixed(2)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Unreal.</Text>
        <Text color={uPnlColor}>{uPnlSign}${unrealizedPnl.toFixed(2)}</Text>
      </Box>
      {paperStats && (
        <Box justifyContent="space-between">
          <Text color={DIM}>Trades</Text>
          <Text><Text color="green">{paperStats.wins}W</Text><Text color={DIM}>/</Text><Text color="red">{paperStats.losses}L</Text> <Text color={ACCENT}>{(paperStats.winRate * 100).toFixed(0)}%</Text></Text>
        </Box>
      )}
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

const PositionsPanel = memo(function PositionsPanel({ positions, getAssetPrice, rowsPerCol }: {
  positions: Array<{ coin: string; side: 'long' | 'short'; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Max rows rendered per column to prevent layout breakout. */
  rowsPerCol: number
}) {
  const [page, setPage] = useState(0) // 0 = first page
  const total = positions.length
  const pageSize = Math.max(2, rowsPerCol * 2)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // [ = prev page, ] = next page (avoids conflict with Tape ↑↓)
  useInput((input) => {
    if (input === '[') setPage(p => Math.max(0, p - 1))
    if (input === ']') setPage(p => Math.min(p + 1, totalPages - 1))
  })

  // Clamp page when positions shrink (e.g. position closed)
  const clampedPage = Math.min(page, totalPages - 1)

  if (total === 0) {
    return (
      <Panel title="Positions">
        <Text color={DIM}>No open positions</Text>
      </Panel>
    )
  }

  const startIdx = clampedPage * pageSize
  const pagePositions = positions.slice(startIdx, startIdx + pageSize)
  const mid = Math.min(rowsPerCol, Math.ceil(pagePositions.length / 2))
  const left = pagePositions.slice(0, mid)
  const right = pagePositions.slice(mid, mid + rowsPerCol)

  const pageInfo = totalPages > 1
    ? ` [/]  ${clampedPage + 1}/${totalPages}`
    : ''
  const rangeEnd = Math.min(startIdx + pageSize, total)

  const PC = { coin: 12, side: 6, entry: 10, sl: 10, tp: 10, upnl: 10 }
  const header = (
    <Box>
      <Text color={DIM}>{'COIN'.padEnd(PC.coin)} {'SIDE'.padEnd(PC.side)} {'ENTRY'.padEnd(PC.entry)} {'SL'.padEnd(PC.sl)} {'TP'.padEnd(PC.tp)} {'UPNL'.padEnd(PC.upnl)} STRATEGY</Text>
    </Box>
  )
  const renderRow = (p: typeof positions[number]) => {
    const asset = getAssetPrice(p.coin)
    const upnl = asset
      ? (asset.markPrice - p.entryPrice) * Math.abs(p.currentSize) * (p.side === 'long' ? 1 : -1)
      : null
    const upnlStr = upnl != null
      ? `${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}`
      : '—'
    return (
      <Box key={`${p.coin}-${p.strategyId}`}>
        <Text bold>{p.coin.padEnd(PC.coin)} </Text>
        <Text bold color={p.side === 'long' ? 'green' : 'red'}>{p.side.slice(0, 1).toUpperCase().padEnd(PC.side)} </Text>
        <Text color={ACCENT}>{formatPrice(p.entryPrice).padEnd(PC.entry)} </Text>
        <Text color="red">{formatPrice(p.slPrice).padEnd(PC.sl)} </Text>
        <Text color="green">{formatPrice(p.tpPrice).padEnd(PC.tp)} </Text>
        <Text {...(upnl != null ? { color: upnl >= 0 ? 'green' as const : 'red' as const } : {})}>{upnlStr.padEnd(PC.upnl)} </Text>
        <Text color={DIM}>{p.strategyId}</Text>
      </Box>
    )
  }
  const renderColumn = (rows: typeof positions, label: string) => (
    <Panel title={label} width="50%" height={rowsPerCol + 3} flexShrink={0}>
      {header}
      {rows.map(renderRow)}
    </Panel>
  )
  return (
    <Box>
      {renderColumn(left, `Positions ${startIdx + 1}-${startIdx + mid} (${total})${pageInfo}`)}
      {renderColumn(right, `Positions ${startIdx + mid + 1}-${rangeEnd}`)}
    </Box>
  )
})

// ─── Watchlist ───────────────────────────────────────────────────────────────

type TFSnapshot = { regime: string; bias: string }
type CoinInfo = { grade: string; setups: number; tfs: Record<string, TFSnapshot>; price: number | null; funding: number | null }

const DISPLAY_TFS = ['15m', '1h', '4h', '1d'] as const

function aggregateCoins(statuses: StatusSnapshot[], getAssetPrice: (coin: string) => AssetPrice | null): Map<string, CoinInfo> {
  const byCoin = new Map<string, CoinInfo>()
  for (const s of statuses) {
    let info = byCoin.get(s.coin)
    if (!info) {
      const asset = getAssetPrice(s.coin)
      info = { grade: '\u2014', setups: 0, tfs: {}, price: asset?.markPrice ?? null, funding: asset?.funding ?? null }
      byCoin.set(s.coin, info)
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

function biasArrow(bias: string): string {
  if (bias === 'long' || bias === 'bullish') return '\u25B2'  // ▲
  if (bias === 'short' || bias === 'bearish') return '\u25BC' // ▼
  return '\u25C6' // ◆
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

const COL = { coin: 12, grade: 5, setups: 5, price: 12, fund: 10, tfCell: 10 }
const TF_HEADERS = DISPLAY_TFS.map(tf => tf.toUpperCase().padEnd(COL.tfCell)).join('')
const COIN_HEADER = `${'COIN'.padEnd(COL.coin)} ${'GRD'.padEnd(COL.grade)} ${'#'.padEnd(COL.setups)} ${'PRICE'.padEnd(COL.price)} ${'FUND'.padEnd(COL.fund)} ${TF_HEADERS}`

function tfCellText(snap: TFSnapshot | undefined): { label: string; color: 'green' | 'red' | 'yellow' | undefined } {
  if (!snap) return { label: '\u2014'.padEnd(COL.tfCell), color: undefined }
  const arrow = biasArrow(snap.bias)
  const r = regimeLabel(snap.regime)
  return { label: `${arrow}${r}`.padEnd(COL.tfCell), color: biasColor(snap.bias) ?? regimeColor(snap.regime) }
}

function formatPrice(price: number): string {
  if (price <= 0) return '0'
  const exp = Math.floor(Math.log10(price))
  const decimals = Math.max(0, Math.min(8, 4 - exp))
  return price.toFixed(decimals)
}

function formatFunding(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`
}

function fundingColor(rate: number): 'green' | 'red' | undefined {
  if (rate > 0.0001) return 'green'   // positive = longs pay shorts
  if (rate < -0.0001) return 'red'
  return undefined
}

function CoinRow({ coin, info }: { coin: string; info: CoinInfo | undefined }) {
  if (!info) {
    const empty = DISPLAY_TFS.map(() => '\u2014'.padEnd(COL.tfCell)).join('')
    return (
      <Box>
        <Text color={DIM}>{coin.padEnd(COL.coin)} {'\u2014'.padEnd(COL.grade)} {'0'.padEnd(COL.setups)} {'\u2014'.padEnd(COL.price)} {'\u2014'.padEnd(COL.fund)} {empty}</Text>
      </Box>
    )
  }

  const priceStr = info.price != null ? formatPrice(info.price).padEnd(COL.price) : '\u2014'.padEnd(COL.price)
  const fundStr = info.funding != null ? formatFunding(info.funding).padEnd(COL.fund) : '\u2014'.padEnd(COL.fund)

  return (
    <Box>
      <Text bold>{coin.padEnd(COL.coin)} </Text>
      <Text bold={info.grade.startsWith('A')} {...(gradeColor(info.grade) != null ? { color: gradeColor(info.grade) } : {})}>{info.grade.padEnd(COL.grade)} </Text>
      <Text>{String(info.setups).padEnd(COL.setups)} </Text>
      <Text color={ACCENT}>{priceStr} </Text>
      <Text {...(info.funding != null && fundingColor(info.funding) != null ? { color: fundingColor(info.funding) } : {})}>{fundStr} </Text>
      {DISPLAY_TFS.map(tf => {
        const { label, color } = tfCellText(info.tfs[tf])
        return <Text key={tf} {...(color != null ? { color } : {})}>{label}</Text>
      })}
    </Box>
  )
}

const WatchlistColumn = memo(function WatchlistColumn({ title, coins, byCoin, rowsPerCol }: {
  title: string
  coins: string[]
  byCoin: Map<string, CoinInfo>
  rowsPerCol: number
}) {
  const visible = coins.slice(0, rowsPerCol)
  const hidden = Math.max(0, coins.length - visible.length)
  return (
    <Panel title={title} width="50%" height={rowsPerCol + 3} flexShrink={0}>
      <Box>
        <Text color={DIM}>{COIN_HEADER}</Text>
      </Box>
      {visible.map((coin: string) => (
        <CoinRow key={coin} coin={coin} info={byCoin.get(coin)} />
      ))}
      {hidden > 0 && <Text color={DIM}>… +{hidden} more</Text>}
    </Panel>
  )
})

const WatchlistPanel = memo(function WatchlistPanel({ statuses, trackedCoins, getAssetPrice, rowsPerCol }: {
  statuses: StatusSnapshot[]
  trackedCoins: string[]
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Max rows rendered per column to prevent layout breakout. */
  rowsPerCol: number
}) {
  const byCoin = useMemo(() => aggregateCoins(statuses, getAssetPrice), [statuses, getAssetPrice])
  const [page, setPage] = useState(0)

  if (trackedCoins.length === 0) {
    return (
      <Box>
        <Panel title="Watchlist" width="50%">
          <Text color={DIM}> No coins tracked</Text>
        </Panel>
        <Panel title="Watchlist" width="50%">
          <Text color={DIM}> No coins tracked</Text>
        </Panel>
      </Box>
    )
  }

  const pageSize = Math.max(2, rowsPerCol * 2)
  const total = trackedCoins.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // { = prev page, } = next page (avoids conflict with Tape ↑↓ and Positions [ ])
  useInput((input) => {
    if (input === '{') setPage(p => Math.max(0, p - 1))
    if (input === '}') setPage(p => Math.min(p + 1, totalPages - 1))
  })

  const clampedPage = Math.min(page, totalPages - 1)
  const startIdx = clampedPage * pageSize
  const pageCoins = trackedCoins.slice(startIdx, startIdx + pageSize)

  const mid = Math.min(rowsPerCol, Math.ceil(pageCoins.length / 2))
  const left = pageCoins.slice(0, mid)
  const right = pageCoins.slice(mid, mid + rowsPerCol)

  const pageInfo = totalPages > 1 ? ` {}/  ${clampedPage + 1}/${totalPages}` : ''
  const rangeEnd = Math.min(startIdx + pageSize, total)

  return (
    <Box>
      <WatchlistColumn
        title={`Watchlist ${startIdx + 1}-${startIdx + mid} (${total})${pageInfo}`}
        coins={left}
        byCoin={byCoin}
        rowsPerCol={rowsPerCol}
      />
      <WatchlistColumn
        title={`Watchlist ${startIdx + mid + 1}-${rangeEnd}`}
        coins={right}
        byCoin={byCoin}
        rowsPerCol={rowsPerCol}
      />
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

// ─── Tape (Signal Log) ─────────────────────────────────────────────────────

const TAPE_PAGE_SIZE = 10

const TapePanel = memo(function TapePanel({ signals, maxLines }: { signals: string[]; maxLines: number }) {
  // page=0 → latest page, page=1 → one page back, etc.
  const [page, setPage] = useState(0)
  const total = signals.length
  const totalPages = Math.max(1, Math.ceil(total / TAPE_PAGE_SIZE))

  // ↑ = older page, ↓ = newer page (back to latest)
  useInput((_input, key) => {
    if (key.upArrow) setPage(p => Math.min(p + 1, totalPages - 1))
    if (key.downArrow) setPage(p => Math.max(0, p - 1))
  })

  // Auto-reset to latest page when new signals arrive and user is already on latest
  const prevTotal = React.useRef(total)
  if (total !== prevTotal.current) {
    if (page === 0) { /* stay on latest — slice will update automatically */ }
    prevTotal.current = total
  }

  const endIdx = total - page * TAPE_PAGE_SIZE
  const startIdx = Math.max(0, endIdx - TAPE_PAGE_SIZE)
  const lines = signals.slice(startIdx, endIdx).slice(-Math.max(1, maxLines))

  const displayedPage = totalPages - page // 1-based, ascending (1=oldest page)
  const pageInfo = total > TAPE_PAGE_SIZE
    ? ` ↑↓  ${displayedPage}/${totalPages}${page === 0 ? ' ▼' : ''}`
    : ''

  return (
    <Panel title={`Tape${pageInfo}`} height={maxLines + 3} flexShrink={0} minHeight={6}>
      {lines.length === 0 ? (
        <Text color={DIM}>Waiting for signals...</Text>
      ) : (
        lines.map((line, i) => <Text key={startIdx + i}>{line}</Text>)
      )}
    </Panel>
  )
})

// ─── Main App ───────────────────────────────────────────────────────────────

function App({ sources }: { sources: TuiDataSources }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termRows = stdout?.rows ?? 40
  const termCols = stdout?.columns ?? 120
  const [tick, setTick] = useState(0)
  const [signals, setSignals] = useState<string[]>([])
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

  // Signal log listener
  useEffect(() => {
    const listener = (line: string) => {
      setSignals(prev => {
        const next = [...prev, line]
        return next.length > 200 ? next.slice(-200) : next
      })
    }
    signalListeners.push(listener)
    return () => {
      signalListeners = signalListeners.filter(l => l !== listener)
    }
  }, [])

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
        <AccountPanel account={account} dailyPnl={snapshot.global.dailyPnl} unrealizedPnl={unrealizedPnl} paperStats={paperStats} />
        <StrategyPanel snapshot={snapshot} activeSetups={activeSetups} invStats={invStats} />
        <BuddyPanel mood={getBuddyMood(snapshot, positions.length, snapshot.global.dailyPnl, signals.length)} tick={tick} />
        <SystemPanel report={health} subCount={subCount} />
      </Box>

      <PositionsPanel positions={positions} getAssetPrice={sources.getAssetPrice} rowsPerCol={layout.positionsRowsPerCol} />
      <WatchlistPanel statuses={statuses} trackedCoins={trackedCoins} getAssetPrice={sources.getAssetPrice} rowsPerCol={layout.watchlistRowsPerCol} />
      <TapePanel signals={signals} maxLines={layout.tapeLines} />
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
 * Append a signal/action to the tape panel.
 * Only setup-related events: signal (SETUP), enter (FILLED), exit (CLOSED).
 * Skips SKIP and other noise.
 */
export function appendSignal(action: AgentAction): void {
  // Only pass through setup-relevant events
  if (action.type === 'log_journal') {
    const et = (action as { type: 'log_journal'; eventType: string }).eventType
    if (et !== 'signal' && et !== 'enter' && et !== 'exit') return
  }

  const line = formatAction(action)
  if (!line) return

  // Strip ANSI codes — ink handles its own colors
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '')
  for (const listener of signalListeners) {
    listener(clean)
  }
}

/**
 * No-op logger sink kept for API compatibility (index.ts calls setTuiSink(appendLog)).
 * All tape content goes through appendSignal (agent.onAction) which has structured
 * formatting. Raw logger output is suppressed to avoid noise and format inconsistency.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function appendLog(_msg: string): void {
  // No-op: all trading-relevant events (SETUP, FILLED, CLOSED, circuit_break,
  // error, pause, invalidate) are routed via appendSignal (agent.onAction).
  // Routing raw logger output here causes operational noise (stale candle warnings,
  // pipeline INFO spam) to flood the tape with inconsistent formatting.
}

/**
 * Stop the TUI and restore the terminal.
 */
export function stopTui(): void {
  if (inkInstance) {
    inkInstance.unmount()
    inkInstance = null
  }
  signalListeners = []
  backfillDoneListeners = []
  _backfillDone = false
}

/** Whether the TUI is currently running. */
export function isTuiRunning(): boolean {
  return inkInstance !== null
}
