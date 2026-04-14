/**
 * Terminal UI (TUI) — Full-screen trading terminal dashboard using ink.
 *
 * Layout:
 *   ┌─ Header Bar ──────────────────────────────────────────────┐
 *   ├─ Account ──────────┬─ Strategy ──┬─ Deliberation ──┬─ Health ───────┤
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
import type {
  getBriefingRefreshStats as getBriefingRefreshStatsFn,
  getBriefingRefreshHealth as getBriefingRefreshHealthFn,
  getBriefingRefreshHistory as getBriefingRefreshHistoryFn,
  getBriefingRefreshIncidents as getBriefingRefreshIncidentsFn,
} from '../alert/telegram/briefing-refresh-stats.js'
import { getEffectivePaperTrade, WS_MAX_SUBSCRIPTIONS, TIMEFRAMES, MIN_CANDLES_FOR_SCAN, PAPER_WALLET_STRATEGY_IDS } from '../config.js'
import {
  buildDeliberationFocusCandidates,
  buildDeliberationFocusSlots,
  cycleDeliberationFocus,
  describeDeliberationFocus,
  resolveFocusedCoin,
  resolveFocusedOperatorAudit,
  resolveBriefingHealthFocus,
  resolveFocusedPosition,
  resolveFocusedSetup,
  resolveFocusedStrategyId,
  resolveDeliberationFocusDigit,
  resolveFocusedDecisionTrace,
  type DeliberationFocusSlot,
  type DeliberationFocus,
} from './deliberation-focus.js'
import { normalizeStrategyId, type LiveStrategyWalletStats } from './live-account-stats.js'
import { candleCount } from '../feed/store.js'
import type { CandleInterval, ActiveSetup, DecisionTrace } from '../types.js'
import type { InvalidationBridgeStats } from '../agent/invalidation-bridge.js'
import type { AccountState } from '../execution/exchange-service.js'
import type { PositionState } from '../agent/types.js'

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
  funding: number | null
  /** % move from today's 00:00 UTC open (1d candle `o`) to mark; null if no 1d data. */
  dayChangePctUtc: number | null
}

export interface TuiDataSources {
  getAgentSnapshot: () => AgentSnapshot
  getPositions: () => Map<string, {
    rowKey?: string
    positionId?: string
    coin: string
    side: 'long' | 'short'
    leverage: number
    currentSize: number
    entryPrice: number
    slPrice: number
    tpPrice: number
    strategyId: string
    /** Live: HL row without a matching bot-tracked position (manual / external fill). */
    exchangeOnly?: boolean
  }>
  getStatus: () => StatusSnapshot[]
  getHealthReport: () => { overall: string; uptime: number; rssBytes: number; components: { feed: { status: string; consecutiveErrors: number }; db: { status: string; consecutiveErrors: number }; exchange: { status: string; consecutiveErrors: number } } }
  getAccountState: () => Promise<{ effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null> | null
  getSubscriptionCount: () => number
  getTrackedCoins: () => string[]
  getPaperStats: () => PaperStats | null
  /** Live: closed-trade stats per strategy (DB); null in paper or before first fetch. */
  getLiveStrategyWalletStats: () => LiveStrategyWalletStats | null
  /** Live: cached account state per strategy view for the shared runtime wallet. */
  getLiveAccountStatesByStrategy: () => ReadonlyMap<string, AccountState> | null
  getAssetPrice: (coin: string) => AssetPrice | null
  getActiveSetups: () => ActiveSetup[]
  getDecisionTraces: () => DecisionTrace[]
  getOperatorAuditEntries: () => OperatorAuditEntry[]
  getBriefingRefreshStats: () => ReturnType<typeof getBriefingRefreshStatsFn>
  getBriefingRefreshHealth: () => ReturnType<typeof getBriefingRefreshHealthFn>
  getBriefingRefreshHistory: () => ReturnType<typeof getBriefingRefreshHistoryFn>
  getBriefingRefreshIncidents: () => ReturnType<typeof getBriefingRefreshIncidentsFn>
  getTrackedPosition: (positionId: string) => PositionState | null
  /** Invalidation bridge: matched vs skipped per strategy (live session). */
  getInvalidationStats: () => InvalidationBridgeStats
  setStrategyPaused: (strategyId: string, paused: boolean, reason: string) => boolean
  closePosition: (positionId: string, reason: string) => boolean
  partialClosePosition: (positionId: string, closePct: number, reason: string) => boolean
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

const TITLE_COLOR = 'white'
const ACCENT = 'cyan'
const DIM = 'gray'
const MAX_OPERATOR_AUDIT_ENTRIES = 6

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
  const RESERVED_TOP = 27 // header + focus/action/audit strips + top panel row + position detail
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
  coin: 8, lev: 6, side: 4, entry: 12, sl: 12, tp: 12, upnl: 10, strategy: 12,
}
const POS_COL_MIN: PositionsColumnWidths = {
  coin: 6,
  lev: 4,
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
  const tfBlock = flat.tfBlock ?? minimum.tfBlock
  let tfCell = Math.max(3, Math.floor(tfBlock / 4))
  const cols: WatchlistColumnWidths = {
    coin: flat.coin ?? minimum.coin,
    grade: flat.grade ?? minimum.grade,
    setups: flat.setups ?? minimum.setups,
    price: flat.price ?? minimum.price,
    dayPct: flat.dayPct ?? minimum.dayPct,
    fund: flat.fund ?? minimum.fund,
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

function formatStateLabel(value: string): string {
  return value.replace(/_/g, ' ').toUpperCase()
}

function formatClockTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}

function shortTraceRef(value: string | undefined): string {
  if (value == null || value.length === 0) return '—'
  return truncateStr(value, 20)
}

function getTimelineEvent(
  trace: DecisionTrace | null,
  predicate: (item: DecisionTrace['timeline'][number]) => boolean,
): DecisionTrace['timeline'][number] | null {
  if (trace == null) return null
  return trace.timeline.find(predicate) ?? null
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

export type OperatorAuditEntry = {
  ts: number
  action: string
  target: string
  status: 'armed' | 'submitted' | 'failed'
  coin?: string | null
  strategyId?: string | null
  positionId?: string | null
}

function mergeOperatorAuditEntries(
  persisted: OperatorAuditEntry[],
  ephemeral: OperatorAuditEntry[],
): OperatorAuditEntry[] {
  const merged = [...persisted, ...ephemeral]
  merged.sort((a, b) => a.ts - b.ts)

  const deduped: OperatorAuditEntry[] = []
  const seen = new Set<string>()
  for (const entry of merged) {
    const key = `${entry.ts}|${entry.action}|${entry.target}|${entry.status}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }

  return deduped.slice(-MAX_OPERATOR_AUDIT_ENTRIES)
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

const FocusStrip = memo(function FocusStrip({
  slots,
  current,
}: {
  slots: DeliberationFocusSlot[]
  current: DeliberationFocus
}) {
  if (slots.length === 0) {
    return (
      <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
        <Text color={DIM}>Focus 0 AUTO | No active positions or setups</Text>
      </Box>
    )
  }

  const currentKey = current.kind === 'auto'
    ? 'auto'
    : current.kind === 'position'
      ? `position:${current.positionId}`
      : `setup:${current.setupId}`

  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
      <Text color={DIM}>Focus </Text>
      <Text color={current.kind === 'auto' ? ACCENT : DIM}>[0 AUTO]</Text>
      <Text color={DIM}> </Text>
      {slots.map((slot, idx) => {
        const slotKey = slot.focus.kind === 'position'
          ? `position:${slot.focus.positionId}`
          : slot.focus.kind === 'setup'
            ? `setup:${slot.focus.setupId}`
            : 'auto'
        const active = currentKey === slotKey
        return (
          <React.Fragment key={`${slot.digit}-${slot.label}`}>
            {idx > 0 && <Text color={DIM}> </Text>}
            <Text color={active ? ACCENT : DIM}>
              [{slot.digit} {truncateStr(slot.label, 16)}]
            </Text>
          </React.Fragment>
        )
      })}
      <Text color={DIM}>  n/p cycle</Text>
    </Box>
  )
})

const ActionStrip = memo(function ActionStrip({
  strategyId,
  strategyPaused,
  pendingPauseConfirm,
  positionLabel,
  pendingCloseConfirm,
  pendingReduceConfirm,
  banner,
}: {
  strategyId: string | null
  strategyPaused: boolean
  pendingPauseConfirm: string | null
  positionLabel: string | null
  pendingCloseConfirm: string | null
  pendingReduceConfirm: string | null
  banner: { color: 'green' | 'yellow' | 'red'; text: string } | null
}) {
  if (strategyId == null && positionLabel == null) {
    return (
      <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
        <Text color={DIM}>Actions Select a setup/position focus to enable strategy controls</Text>
      </Box>
    )
  }

  const pauseLabel = strategyPaused ? 'resume' : 'pause'
  const pauseColor = strategyPaused ? 'green' : 'yellow'

  return (
    <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
      <Text color={DIM}>Actions </Text>
      {strategyId != null ? (
        <>
          <Text color={ACCENT}>{strategyId}</Text>
          <Text color={DIM}> </Text>
          <Text color={pauseColor}>[s {pauseLabel}]</Text>
          <Text color={DIM}> </Text>
          <Text color={strategyPaused ? 'green' : DIM}>{strategyPaused ? 'PAUSED' : 'RUNNING'}</Text>
        </>
      ) : null}
      {positionLabel != null ? (
        <>
          {strategyId != null ? <Text color={DIM}> </Text> : null}
          <Text color="red">[x close {truncateStr(positionLabel, 18)}]</Text>
          <Text color={DIM}> </Text>
          <Text color="yellow">[r 25%]</Text>
          <Text color={DIM}> </Text>
          <Text color="yellow">[f 50%]</Text>
        </>
      ) : null}
      {pendingPauseConfirm != null ? (
        <>
          <Text color={DIM}> </Text>
          <Text color="yellow">Confirm: press s again to pause {truncateStr(pendingPauseConfirm, 20)}</Text>
        </>
      ) : null}
      {pendingCloseConfirm != null ? (
        <>
          <Text color={DIM}> </Text>
          <Text color="yellow">Confirm: press x again to close {truncateStr(pendingCloseConfirm, 18)}</Text>
        </>
      ) : null}
      {pendingReduceConfirm != null ? (
        <>
          <Text color={DIM}> </Text>
          <Text color="yellow">Confirm: press same key again to reduce {truncateStr(pendingReduceConfirm, 20)}</Text>
        </>
      ) : null}
      {banner != null ? (
        <>
          <Text color={DIM}> </Text>
          <Text color={banner.color}>{truncateStr(banner.text, 72)}</Text>
        </>
      ) : null}
    </Box>
  )
})

const OperatorAuditPanel = memo(function OperatorAuditPanel({
  entries,
}: {
  entries: OperatorAuditEntry[]
}) {
  return (
    <Panel title="Operator" minHeight={5}>
      {entries.length === 0 ? (
        <Text color={DIM}>No manual operator actions yet</Text>
      ) : (
        entries.slice(-3).reverse().map(entry => {
          const statusColor = entry.status === 'submitted'
            ? 'green'
            : entry.status === 'failed'
              ? 'red'
              : 'yellow'
          const stamp = new Date(entry.ts).toISOString().slice(11, 19)
          return (
            <Box key={`${entry.ts}-${entry.action}-${entry.target}`}>
              <Text color={DIM}>{stamp}</Text>
              <Text color={DIM}> </Text>
              <Text color={statusColor}>{entry.status.toUpperCase()}</Text>
              <Text color={DIM}> </Text>
              <Text>{truncateStr(`${entry.action} ${entry.target}`, 72)}</Text>
            </Box>
          )
        })
      )}
    </Panel>
  )
})

// ─── Account ────────────────────────────────────────────────────────────────

/**
 * Account panel (ALL + tabs 1–3):
 * - **Equity**: Total account value — HL `effectiveBalance` (perp `accountValue` + spot USDC), or paper cash+uPnL.
 *   This is *not* “wallet cash + margin” as two addends: margin is already part of equity; the Margin row breaks out locked collateral.
 * - **Margin**: Collateral locked in open positions (`totalMarginUsed`, or notional/leverage estimate).
 * - **Available**: Free collateral ≈ Equity − Margin (see `liveFreeMarginUsd`). Not HL `withdrawable` (often $0 while in perps).
 */

/** Sum realized day P&L across the three strategy wallets (paper + live multi-strategy). */
function sumStrategiesDailyPnl(strategyGlobals: AgentSnapshot['strategyGlobals'] | undefined): number {
  if (!strategyGlobals) return 0
  let s = 0
  for (const id of PAPER_WALLET_STRATEGY_IDS) {
    s += strategyGlobals[id]?.dailyPnl ?? 0
  }
  return s
}

/**
 * Hyperliquid `withdrawable` is USDC that can be sent off-platform; it is often $0 while balance
 * sits in perp/cross margin. The Account panel uses **Available = balance − margin used**, not
 * `withdrawable`, so it matches perp trading expectations (same idea as Paper mode).
 */
function liveFreeMarginUsd(st: Pick<AccountState, 'effectiveBalance' | 'totalMarginUsed'>): number {
  return Math.max(0, st.effectiveBalance - st.totalMarginUsed)
}

const AccountPanel = memo(function AccountPanel({
  account,
  dailyPnlGlobal,
  unrealizedPnl,
  paperStats,
  paperDerived,
  strategyGlobals,
  liveStrategyStats,
}: {
  account: { effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null
  /** Fallback when strategyGlobals has no per-strategy daily rows yet. */
  dailyPnlGlobal: number
  unrealizedPnl: number
  paperStats: PaperStats | null
  paperDerived: { marginUsed: number; available: number } | null
  strategyGlobals: AgentSnapshot['strategyGlobals'] | undefined
  liveStrategyStats: LiveStrategyWalletStats | null
}) {
  const isPaper = paperStats != null

  const totalEquityPaper = paperStats != null ? paperStats.totalBalance + unrealizedPnl : null

  const portfolioMargin = isPaper && paperDerived != null
    ? paperDerived.marginUsed
    : (account?.totalMarginUsed ?? null)
  const portfolioAvail = isPaper && paperDerived != null
    ? paperDerived.available
    : (!isPaper && account
      ? liveFreeMarginUsd(account)
      : (account?.withdrawable ?? null))

  const sumStratDaily = sumStrategiesDailyPnl(strategyGlobals)
  const hasStratGlobals = Boolean(strategyGlobals && Object.keys(strategyGlobals).length > 0)
  const dailyShown = isPaper
    ? sumStratDaily
    : (hasStratGlobals ? sumStratDaily : dailyPnlGlobal)
  const unrealShown = unrealizedPnl

  const balanceShown = isPaper ? totalEquityPaper : (account?.effectiveBalance ?? null)

  const pnlColor = (pnl: number): 'green' | 'red' => (pnl >= 0 ? 'green' : 'red')
  const dSign = dailyShown >= 0 ? '+' : ''
  const uSign = unrealShown >= 0 ? '+' : ''

  const aggTrades = isPaper ? paperStats! : liveStrategyStats

  return (
    <Panel title="Account" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>Equity</Text>
        <Text bold>{balanceShown != null ? `$${balanceShown.toFixed(2)}` : '---'}</Text>
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
        <Text bold color={pnlColor(dailyShown)}>{dSign}${dailyShown.toFixed(2)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Unreal.</Text>
        <Text color={pnlColor(unrealShown)}>{uSign}${unrealShown.toFixed(2)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Trades</Text>
        <Text>
          {aggTrades ? (
            <>
              <Text color="green">{aggTrades.wins}W</Text>
              <Text color={DIM}>/</Text>
              <Text color="red">{aggTrades.losses}L</Text>
              <Text> </Text>
              <Text color={ACCENT}>{(aggTrades.winRate * 100).toFixed(0)}%</Text>
            </>
          ) : (
            <Text color={DIM}>—</Text>
          )}
        </Text>
      </Box>
    </Panel>
  )
})

// ─── Health ────────────────────────────────────────────────────────────────

const UnifiedHealthPanel = memo(function UnifiedHealthPanel({
  report,
  subCount,
  stats,
  briefingHealth,
  history,
  incidents,
}: {
  report: TuiDataSources['getHealthReport'] extends () => infer R ? R : never
  subCount: number
  stats: ReturnType<TuiDataSources['getBriefingRefreshStats']>
  briefingHealth: ReturnType<TuiDataSources['getBriefingRefreshHealth']>
  history: ReturnType<TuiDataSources['getBriefingRefreshHistory']>
  incidents: ReturnType<TuiDataSources['getBriefingRefreshIncidents']>
}) {
  const rss = (report.rssBytes / 1024 / 1024).toFixed(0)
  const subPct = ((subCount / WS_MAX_SUBSCRIPTIONS) * 100).toFixed(0)
  const overallColor = statusColor(report.overall)
  const briefingHealthColor =
    briefingHealth.state === 'critical'
      ? 'red'
      : briefingHealth.state === 'degraded'
        ? 'yellow'
        : 'green'

  return (
    <Panel title="Health" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={DIM}>Core</Text>
        <Text color={overallColor}>
          {statusDot(report.overall)} {report.overall}
          <Text color={DIM}> up {uptimeStr(report.uptime)}</Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={DIM}>Mem/WS</Text>
        <Text>
          {rss} MB
          <Text color={DIM}> | </Text>
          {subCount}<Text color={DIM}>/{WS_MAX_SUBSCRIPTIONS} ({subPct}%)</Text>
        </Text>
      </Box>
      <Text color={DIM} wrap="truncate-end">
        {truncateStr(
          `Feed ${statusDot(report.components.feed.status)} ${report.components.feed.status}(${report.components.feed.consecutiveErrors})`
          + ` | DB ${statusDot(report.components.db.status)} ${report.components.db.status}(${report.components.db.consecutiveErrors})`
          + ` | Exch ${statusDot(report.components.exchange.status)} ${report.components.exchange.status}(${report.components.exchange.consecutiveErrors})`,
          58,
        )}
      </Text>
      <Text color={briefingHealthColor} wrap="truncate-end">
        {truncateStr(
          `Briefing ${briefingHealth.state.toUpperCase()} | ${Math.round(briefingHealth.editRatio * 100)}% edit`
          + ` | fail ${briefingHealth.failed} | coal ${briefingHealth.coalesced}`,
          58,
        )}
      </Text>
      <Text color={DIM} wrap="truncate-end">
        {truncateStr(
          `Briefing req ${stats.requested} edit ${stats.edited} skip ${stats.skippedIdentical} coal ${stats.coalesced} fail ${stats.failed}`,
          58,
        )}
      </Text>
      <Text color={briefingHealthColor} wrap="truncate-end">
        {stats.lastOutcome != null
          ? truncateStr(`Last ${stats.lastOutcome.replace(/_/g, ' ')} ${stats.lastKind ?? ''}`.trim(), 58)
          : 'Last none'}
      </Text>
      {briefingHealth.state === 'healthy' && briefingHealth.recoveredFrom != null ? (
        <Text color="green" wrap="truncate-end">
          {truncateStr(
            `Recovered ${briefingHealth.recoveredFrom.toUpperCase()}`
            + `${briefingHealth.recoveredTarget != null ? ` | ${briefingHealth.recoveredTarget}` : ''}`
            + `${briefingHealth.recoveredAttention != null ? ` | ${briefingHealth.recoveredAttention}` : ''}`,
            58,
          )}
        </Text>
      ) : null}
      {(briefingHealth.lastTarget != null || briefingHealth.lastAttention != null) ? (
        <Text color={DIM} wrap="truncate-end">
          {truncateStr(
            `Target ${briefingHealth.lastTarget ?? '—'}`
            + `${briefingHealth.lastAttention != null ? ` | ${briefingHealth.lastAttention}` : ''}`,
            58,
          )}
        </Text>
      ) : null}
      <Text color={DIM} wrap="truncate-end">
        {stats.lastAt != null ? formatClockTime(stats.lastAt) : 'No briefing refresh yet'}
      </Text>
      {incidents.length > 0 ? (
        <Text color={DIM} wrap="truncate-end">
          {truncateStr(
            `Incident ${incidents.map(item => `${item.peakState.toUpperCase()} ${item.status.toUpperCase()}${item.target != null ? ` ${item.target}` : ''}`).join(' | ')}`,
            58,
          )}
        </Text>
      ) : null}
      {history.length > 0 ? (
        <Text color={DIM} wrap="truncate-end">
          {truncateStr(
            `History ${history.map(item => `${item.from}->${item.to}`).join(' | ')}`,
            58,
          )}
        </Text>
      ) : null}
      {(
        briefingHealth.lastTarget != null ||
        briefingHealth.lastCoin != null ||
        briefingHealth.recoveredTarget != null ||
        briefingHealth.recoveredCoin != null
      ) ? (
        <Text color={DIM} wrap="truncate-end">
          Press h to jump health target
        </Text>
      ) : null}
    </Panel>
  )
})

// ─── Positions ──────────────────────────────────────────────────────────────

function positionsStrategyHeader(w: number): string {
  const t = 'STRATEGY'
  const s = w >= t.length ? t : t.slice(0, Math.max(1, w))
  return s.padEnd(w)
}

const PositionRow = memo(function PositionRow({ p, PC, getAssetPrice, priceTick, isFocused }: {
  p: {
    rowKey?: string
    positionId?: string
    coin: string
    side: 'long' | 'short'
    leverage: number
    currentSize: number
    entryPrice: number
    slPrice: number
    tpPrice: number
    strategyId: string
    exchangeOnly?: boolean
  }
  PC: { coin: number; lev: number; side: number; entry: number; sl: number; tp: number; upnl: number; strategy: number }
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Bumps every UI tick so memo() re-renders when mark price changes (position `p` ref is stable). */
  priceTick: number
  isFocused: boolean
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
  const slStr = p.exchangeOnly ? '—'.padStart(PC.sl) : formatUsd(p.slPrice).padStart(PC.sl)
  const tpStr = p.exchangeOnly ? '—'.padStart(PC.tp) : formatUsd(p.tpPrice).padStart(PC.tp)

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={PC.coin} trailingGap={POS_GAP} bold {...(isFocused ? { color: ACCENT } : {})}>{p.coin.padEnd(PC.coin)}</TableCell>
      <TableCell w={PC.lev} trailingGap={POS_GAP} color={DIM}>{levStr}</TableCell>
      <TableCell w={PC.side} trailingGap={POS_GAP} bold color={p.side === 'long' ? 'green' : 'red'}>
        {p.side.slice(0, 1).toUpperCase().padEnd(PC.side)}
      </TableCell>
      <TableCell w={PC.entry} trailingGap={POS_GAP} color={ACCENT}>{formatUsd(p.entryPrice).padStart(PC.entry)}</TableCell>
      <TableCell w={PC.sl} trailingGap={POS_GAP} color="red">{slStr}</TableCell>
      <TableCell w={PC.tp} trailingGap={POS_GAP} color="green">{tpStr}</TableCell>
      <TableCell w={PC.upnl} trailingGap={POS_GAP} {...(upnlColor != null ? { color: upnlColor } : {})}>{upnlStr}</TableCell>
      <TableCell w={PC.strategy} color={isFocused ? ACCENT : DIM}>{strat}</TableCell>
    </Box>
  )
})

function positionRowReactKey(p: {
  rowKey?: string
  positionId?: string
  coin: string
  strategyId: string
}): string {
  return p.rowKey ?? p.positionId ?? `${p.coin}-${p.strategyId}`
}

const PositionsPanel = memo(function PositionsPanel({ positions, getAssetPrice, rowsPerCol, pc, priceTick, focusedPositionId }: {
  positions: Array<{
    rowKey?: string
    positionId?: string
    coin: string
    side: 'long' | 'short'
    leverage: number
    currentSize: number
    entryPrice: number
    slPrice: number
    tpPrice: number
    strategyId: string
    exchangeOnly?: boolean
  }>
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Max rows per page (single full-width table; was “per column” when split). */
  rowsPerCol: number
  pc: PositionsColumnWidths
  /** 1s UI clock — forces PositionRow to re-read mark for UPNL (memo + stable `p` ref). */
  priceTick: number
  focusedPositionId: string | null
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
    <PositionRow
      key={positionRowReactKey(p)}
      p={p}
      PC={pc}
      getAssetPrice={getAssetPrice}
      priceTick={priceTick}
      isFocused={focusedPositionId != null && p.positionId === focusedPositionId}
    />
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

const WatchlistCoinRow = memo(function WatchlistCoinRow({
  coin,
  info,
  col,
  priceTick,
  isFocused,
}: {
  coin: string
  info: CoinInfo | undefined
  col: WatchlistColumnWidths
  priceTick: number
  isFocused: boolean
}) {
  const priceFlash = useFlashOnChange(info?.price ?? null)
  if (!info) {
    return (
      <Box flexDirection="row" flexWrap="nowrap">
        <TableCell w={col.coin} marginRight={WL_GAP} color={isFocused ? ACCENT : DIM}>{coin.padEnd(col.coin)}</TableCell>
        <TableCell w={col.grade} marginRight={WL_GAP} color={DIM}>{'\u2014'.padEnd(col.grade)}</TableCell>
        <TableCell w={col.setups} marginRight={WL_GAP} color={isFocused ? ACCENT : DIM}>{'0'.padEnd(col.setups)}</TableCell>
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
  const gradeCol = gradeColor(info.grade)
  const fundingCol = info.funding != null ? fundingColor(info.funding) : undefined

  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <TableCell w={col.coin} marginRight={WL_GAP} bold {...(isFocused ? { color: ACCENT } : {})}>{coin.padEnd(col.coin)}</TableCell>
      {gradeCol !== undefined ? (
        <TableCell
          w={col.grade}
          marginRight={WL_GAP}
          bold={info.grade.startsWith('A')}
          color={isFocused ? ACCENT : gradeCol}
        >
          {info.grade.padEnd(col.grade)}
        </TableCell>
      ) : (
        <TableCell
          w={col.grade}
          marginRight={WL_GAP}
          bold={info.grade.startsWith('A')}
          {...(isFocused ? { color: ACCENT } : {})}
        >
          {info.grade.padEnd(col.grade)}
        </TableCell>
      )}
      <TableCell w={col.setups} marginRight={WL_GAP} {...(isFocused ? { color: ACCENT } : {})}>{String(info.setups).padEnd(col.setups)}</TableCell>
      <TableCell w={col.price} marginRight={WL_GAP} {...(priceColor !== undefined ? { color: priceColor } : {})}>{priceStr}</TableCell>
      <TableCell w={col.dayPct} marginRight={WL_GAP} {...(dCol != null ? { color: dCol } : {})}>{dayStr}</TableCell>
      {fundingCol !== undefined ? (
        <TableCell
          w={col.fund}
          marginRight={WL_GAP}
          color={fundingCol}
        >
          {fundStr}
        </TableCell>
      ) : (
        <TableCell
          w={col.fund}
          marginRight={WL_GAP}
        >
          {fundStr}
        </TableCell>
      )}
      {DISPLAY_TFS.map((tf, i) => {
        const { label, color } = tfCellText(info.tfs[tf], col.tfCell)
        return (
          <TableCell key={tf} w={col.tfCell} marginRight={i < DISPLAY_TFS.length - 1 ? WL_GAP : 0} {...(color != null ? { color } : {})}>{label}</TableCell>
        )
      })}
    </Box>
  )
})

const WatchlistPanel = memo(function WatchlistPanel({
  statuses,
  trackedCoins,
  getAssetPrice,
  rowsPerCol,
  col,
  priceTick,
  focusedCoin,
  focusLabel,
}: {
  statuses: StatusSnapshot[]
  trackedCoins: string[]
  getAssetPrice: (coin: string) => AssetPrice | null
  /** Rows per “logical column”; one full-width page shows up to `2 × rowsPerCol` coins. */
  rowsPerCol: number
  col: WatchlistColumnWidths
  /** 1s UI clock — `statuses` ref can be stable; re-aggregate marks + bust row memo. */
  priceTick: number
  focusedCoin: string | null
  focusLabel: string
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
  const focusSuffix = focusedCoin != null ? ` | ${truncateStr(focusLabel, 12)}` : ''
  const title = `Watchlist ${startIdx + 1}-${rangeEnd} (${total})${pageInfo}${focusSuffix}`

  return (
    <Box flexGrow={1} width="100%">
      <Panel title={title} flexGrow={1} minHeight={panelMinH} flexShrink={1}>
        <WatchlistHeaderRow col={col} />
        {pageCoins.map((coin: string) => (
          <WatchlistCoinRow
            key={coin}
            coin={coin}
            info={byCoin.get(coin)}
            col={col}
            priceTick={priceTick}
            isFocused={focusedCoin === coin}
          />
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

// ─── Deliberation ───────────────────────────────────────────────────────────

function stanceColor(stance: 'bullish' | 'bearish' | 'neutral'): 'green' | 'red' | 'yellow' {
  return stance === 'bullish' ? 'green' : stance === 'bearish' ? 'red' : 'yellow'
}

function verdictColor(verdict: 'approve' | 'reject' | 'watch' | undefined): 'green' | 'red' | 'yellow' | 'gray' {
  if (verdict === 'approve') return 'green'
  if (verdict === 'reject') return 'red'
  if (verdict === 'watch') return 'yellow'
  return 'gray'
}

function timelineActorColor(actor: 'scanner' | 'judge' | 'executor' | 'guardian'): 'cyan' | 'yellow' | 'green' | 'magenta' {
  if (actor === 'scanner') return 'cyan'
  if (actor === 'judge') return 'magenta'
  if (actor === 'executor') return 'green'
  return 'yellow'
}

const DeliberationPanel = memo(function DeliberationPanel({
  trace,
  focusLabel,
}: {
  trace: DecisionTrace | null
  focusLabel: string
}) {
  if (trace == null) {
    return (
      <Panel title="Deliberation" width={42} minHeight={9}>
        <Text color={DIM}>No decision trace yet</Text>
        <Text color={DIM}>Waiting for the next closed bar...</Text>
      </Panel>
    )
  }

  const judge = trace.roles.judge
  const bull = trace.roles.bull
  const bear = trace.roles.bear
  const risk = trace.roles.risk
  const guardian = trace.roles.guardian
  const executor = trace.roles.executor
  const header = `${trace.coin} ${trace.interval} [${trace.strategyId}]`
  const action = trace.outcome.action.toUpperCase()
  const confPct = `${Math.round(trace.outcome.confidence * 100)}%`

  return (
    <Panel title="Deliberation" width={42} minHeight={9}>
      <Text bold>{truncateStr(header, 36)}</Text>
      <Text color={DIM}>{truncateStr(`Focus ${focusLabel} | n/p cycle | 0 auto`, 38)}</Text>
      <Box justifyContent="space-between">
        <Text color={verdictColor(judge?.verdict)}>
          {judge != null ? judge.verdict.toUpperCase() : 'WAIT'}
        </Text>
        <Text color={ACCENT}>{action} {confPct}</Text>
      </Box>
      <Text color={DIM} wrap="truncate-end">{truncateStr(trace.outcome.summary, 38)}</Text>
      {bull != null && (
        <Text color={stanceColor(bull.stance)} wrap="truncate-end">
          BULL {Math.round(bull.confidence * 100)}% {truncateStr(bull.summary, 29)}
        </Text>
      )}
      {bear != null && (
        <Text color={stanceColor(bear.stance)} wrap="truncate-end">
          BEAR {Math.round(bear.confidence * 100)}% {truncateStr(bear.summary, 29)}
        </Text>
      )}
      {risk != null && (
        <Text color={DIM} wrap="truncate-end">
          RISK {Math.round(risk.confidence * 100)}% {truncateStr(risk.summary, 29)}
        </Text>
      )}
      {executor != null && (
        <Text color={ACCENT} wrap="truncate-end">
          EXEC {executor.state.toUpperCase()} {truncateStr(executor.summary, 27)}
        </Text>
      )}
      {guardian != null && (
        <Text color="yellow" wrap="truncate-end">
          GUARD {guardian.state.toUpperCase()} {truncateStr(guardian.summary, 25)}
        </Text>
      )}
      {trace.timeline.slice(-3).map((item, idx) => (
        <Text key={`${item.ts}-${idx}`} color={timelineActorColor(item.actor)} wrap="truncate-end">
          {truncateStr(`${item.actor.toUpperCase()} ${item.action}: ${item.summary}`, 38)}
        </Text>
      ))}
      <Text color={DIM} wrap="truncate-end">
        {truncateStr(`Regime ${trace.regime.state} x${trace.regime.modifier.toFixed(2)}`, 38)}
      </Text>
    </Panel>
  )
})

const FocusDetailPanel = memo(function FocusDetailPanel({
  position,
  setup,
  trace,
  linkedOperatorAudit,
  getAssetPrice,
  focusLabel,
}: {
  position: PositionState | null
  setup: ActiveSetup | null
  trace: DecisionTrace | null
  linkedOperatorAudit: OperatorAuditEntry | null
  getAssetPrice: (coin: string) => AssetPrice | null
  focusLabel: string
}) {
  if (position == null && setup == null) {
    return (
      <Panel title="Focus Detail" minHeight={8}>
        <Text color={DIM}>Focus a setup or tracked position to inspect thesis and lifecycle</Text>
        <Text color={DIM}>{truncateStr(`Current focus ${focusLabel}`, 56)}</Text>
      </Panel>
    )
  }

  if (setup != null && position == null) {
    const judge = trace?.roles.judge
    const bull = trace?.roles.bull
    const bear = trace?.roles.bear
    const risk = trace?.roles.risk
    const ttlBars = Math.max(0, setup.expiresAtBar - setup.detectedAtBar)
    const setupAgeMin = Math.max(0, Math.floor((Date.now() - setup.detectedAt) / 60_000))
    const judgeEvent = getTimelineEvent(trace, item => item.actor === 'judge')
    const fillEvent = getTimelineEvent(trace, item => item.actor === 'executor' && item.action === 'filled')

    return (
      <Panel title="Focus Detail" minHeight={8}>
        <Text bold>{truncateStr(`${setup.coin} ${setup.interval} ${setup.side.toUpperCase()} [${setup.strategyId ?? 'default'}]`, 56)}</Text>
        <Text color={DIM}>{truncateStr(`Focus ${focusLabel} | setup age ${setupAgeMin}m | ttl ${ttlBars} bars`, 56)}</Text>
        <Box justifyContent="space-between">
          <Text color={setup.side === 'long' ? 'green' : 'red'}>{setup.type.toUpperCase()} {setup.side.toUpperCase()}</Text>
          <Text color={ACCENT}>{Math.round(setup.confidence * 100)}%</Text>
        </Box>
        <Text wrap="truncate-end">
          Entry {formatUsd(setup.entryPrice)}
          <Text color={DIM}> | </Text>
          <Text color="red">SL {formatUsd(setup.slPrice)}</Text>
          <Text color={DIM}> | </Text>
          <Text color="green">TP {formatUsd(setup.tpPrice)}</Text>
        </Text>
        <Text wrap="truncate-end">
          Grade <Text color={gradeColor(setup.confluenceGrade ?? 'C') ?? DIM}>{setup.confluenceGrade ?? '—'}</Text>
          <Text color={DIM}> | Cfx </Text>
          <Text>{setup.confluenceCount ?? 0}</Text>
          <Text color={DIM}> | Judge </Text>
          <Text color={verdictColor(judge?.verdict)}>{judge != null ? judge.verdict.toUpperCase() : 'WAIT'}</Text>
        </Text>
        <Text color={DIM} wrap="truncate-end">
          {truncateStr(
            `Trace ${shortTraceRef(trace?.outcome.setupId ?? setup.id)} | Judge ${judgeEvent != null ? formatClockTime(judgeEvent.ts) : 'pending'}`
            + `${fillEvent != null ? ` | Fill ${formatClockTime(fillEvent.ts)}` : ' | Waiting executor fill'}`,
            56,
          )}
        </Text>
        {linkedOperatorAudit != null ? (
          <Text color={linkedOperatorAudit.status === 'failed' ? 'red' : linkedOperatorAudit.status === 'submitted' ? 'green' : 'yellow'} wrap="truncate-end">
            {truncateStr(`OP ${linkedOperatorAudit.status.toUpperCase()} ${linkedOperatorAudit.action} @ ${formatClockTime(linkedOperatorAudit.ts)}`, 56)}
          </Text>
        ) : null}
        {bull != null ? (
          <Text color={stanceColor(bull.stance)} wrap="truncate-end">
            {truncateStr(`Bull ${Math.round(bull.confidence * 100)}% ${bull.summary}`, 56)}
          </Text>
        ) : null}
        {bear != null ? (
          <Text color={stanceColor(bear.stance)} wrap="truncate-end">
            {truncateStr(`Bear ${Math.round(bear.confidence * 100)}% ${bear.summary}`, 56)}
          </Text>
        ) : null}
        {risk != null ? (
          <Text color={DIM} wrap="truncate-end">
            {truncateStr(`Risk ${Math.round(risk.confidence * 100)}% ${risk.summary}`, 56)}
          </Text>
        ) : (
          <Text color={DIM} wrap="truncate-end">
            Waiting for risk and judge detail on this setup
          </Text>
        )}
      </Panel>
    )
  }

  if (position == null) {
    return (
      <Panel title="Focus Detail" minHeight={8}>
        <Text color={DIM}>Tracked position is temporarily unavailable</Text>
        <Text color={DIM}>{truncateStr(`Current focus ${focusLabel}`, 56)}</Text>
      </Panel>
    )
  }

  const asset = getAssetPrice(position.coin)
  const mark = asset?.markPrice ?? null
  const upnl = mark != null
    ? (mark - position.entryPrice) * Math.abs(position.currentSize) * (position.side === 'long' ? 1 : -1)
    : null
  const guardian = trace?.roles.guardian
  const executor = trace?.roles.executor
  const latestLifecycle = trace?.timeline.slice().reverse().find(item =>
    item.actor === 'guardian' || item.actor === 'executor',
  ) ?? null
  const judgeEvent = getTimelineEvent(trace, item => item.actor === 'judge')
  const fillEvent = getTimelineEvent(trace, item => item.actor === 'executor' && item.action === 'filled')
  const guardianStart = getTimelineEvent(trace, item => item.actor === 'guardian')
  const openedAgoMin = Math.max(0, Math.floor((Date.now() - position.openedAt) / 60_000))
  const remainingPct = position.originalSize > 0
    ? Math.max(0, Math.min(100, Math.round((position.currentSize / position.originalSize) * 100)))
    : 0

  return (
    <Panel title="Focus Detail" minHeight={8}>
      <Text bold>{truncateStr(`${position.coin} ${position.side.toUpperCase()} [${position.strategyId}]`, 56)}</Text>
      <Text color={DIM}>{truncateStr(`Focus ${focusLabel} | tracked | open ${openedAgoMin}m`, 56)}</Text>
      <Box justifyContent="space-between">
        <Text color={position.side === 'long' ? 'green' : 'red'}>{position.side.toUpperCase()}</Text>
        <Text color={ACCENT}>
          {mark != null ? `MARK ${formatUsd(mark)}` : 'MARK ---'}
          {upnl != null ? ` | ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}` : ''}
        </Text>
      </Box>
      <Text>
        Size <Text color={ACCENT}>{position.currentSize.toFixed(4)}</Text>
        <Text color={DIM}>/{position.originalSize.toFixed(4)} ({remainingPct}%)</Text>
        <Text color={DIM}> | Lev </Text>
        <Text>{position.leverage.toFixed(0)}x</Text>
      </Text>
      <Text wrap="truncate-end">
        Entry {formatUsd(position.entryPrice)}
        <Text color={DIM}> | </Text>
        <Text color="red">SL {formatUsd(position.slPrice)}</Text>
        <Text color={DIM}> | </Text>
        <Text color="green">TP {formatUsd(position.tpPrice)}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={guardian != null ? 'yellow' : DIM}>
          Guard {guardian != null ? formatStateLabel(guardian.state) : 'WAITING'}
        </Text>
        <Text color={DIM}> | </Text>
        <Text color={executor != null ? ACCENT : DIM}>
          Exec {executor != null ? formatStateLabel(executor.state) : 'IDLE'}
        </Text>
      </Text>
      <Text color={DIM} wrap="truncate-end">
        Partials {position.partialClosesFired.length > 0 ? position.partialClosesFired.map(idx => idx + 1).join(',') : 'none'}
        <Text color={DIM}> | Sync {formatClockTime(position.lastSyncAt)}</Text>
      </Text>
      <Text color={DIM} wrap="truncate-end">
        {truncateStr(
          `Origin ${shortTraceRef(trace?.outcome.setupId)} | Judge ${judgeEvent != null ? formatClockTime(judgeEvent.ts) : '—'}`
          + ` | Fill ${fillEvent != null ? formatClockTime(fillEvent.ts) : formatClockTime(position.openedAt)}`
          + `${guardianStart != null ? ` | Guard ${formatClockTime(guardianStart.ts)}` : ''}`,
          56,
        )}
      </Text>
      {linkedOperatorAudit != null ? (
        <Text color={linkedOperatorAudit.status === 'failed' ? 'red' : linkedOperatorAudit.status === 'submitted' ? 'green' : 'yellow'} wrap="truncate-end">
          {truncateStr(`OP ${linkedOperatorAudit.status.toUpperCase()} ${linkedOperatorAudit.action} @ ${formatClockTime(linkedOperatorAudit.ts)}`, 56)}
        </Text>
      ) : null}
      {latestLifecycle != null ? (
        <Text color={timelineActorColor(latestLifecycle.actor)} wrap="truncate-end">
          {truncateStr(`${latestLifecycle.actor.toUpperCase()} ${latestLifecycle.summary}`, 56)}
        </Text>
      ) : (
        <Text color={DIM} wrap="truncate-end">
          Waiting for guardian or executor lifecycle updates
        </Text>
      )}
    </Panel>
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
  const [deliberationFocus, setDeliberationFocus] = useState<DeliberationFocus>({ kind: 'auto' })
  const [pendingPauseConfirm, setPendingPauseConfirm] = useState<{ strategyId: string; expiresAt: number } | null>(null)
  const [pendingCloseConfirm, setPendingCloseConfirm] = useState<{ positionId: string; expiresAt: number } | null>(null)
  const [pendingReduceConfirm, setPendingReduceConfirm] = useState<{ positionId: string; closePct: number; expiresAt: number } | null>(null)
  const [actionBanner, setActionBanner] = useState<{ color: 'green' | 'yellow' | 'red'; text: string; expiresAt: number } | null>(null)
  const [ephemeralOperatorAudit, setEphemeralOperatorAudit] = useState<OperatorAuditEntry[]>([])

  const appendEphemeralOperatorAudit = (entry: Omit<OperatorAuditEntry, 'ts'>) => {
    const next: OperatorAuditEntry = { ts: Date.now(), ...entry }
    setEphemeralOperatorAudit(current => [...current.slice(-(MAX_OPERATOR_AUDIT_ENTRIES - 1)), next])
  }

  // Keyboard
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      process.emit('SIGINT')
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
  const decisionTraces = useMemo(() => sources.getDecisionTraces(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const invStats = useMemo(() => sources.getInvalidationStats(), [tick])
  const focusCandidates = useMemo(
    () => buildDeliberationFocusCandidates(positions, activeSetups),
    [positions, activeSetups],
  )
  const focusSlots = useMemo(
    () => buildDeliberationFocusSlots(focusCandidates, positions, activeSetups),
    [focusCandidates, positions, activeSetups],
  )
  const focusedTrace = useMemo(
    () => resolveFocusedDecisionTrace(decisionTraces, deliberationFocus),
    [decisionTraces, deliberationFocus],
  )
  const deliberationFocusLabel = useMemo(
    () => describeDeliberationFocus(deliberationFocus, positions, activeSetups),
    [deliberationFocus, positions, activeSetups],
  )
  const focusedCoin = useMemo(
    () => resolveFocusedCoin(deliberationFocus, positions, activeSetups),
    [deliberationFocus, positions, activeSetups],
  )
  const focusedStrategyId = useMemo(
    () => resolveFocusedStrategyId(deliberationFocus, positions, activeSetups),
    [deliberationFocus, positions, activeSetups],
  )
  const focusedPosition = useMemo(
    () => resolveFocusedPosition(deliberationFocus, positions),
    [deliberationFocus, positions],
  )
  const focusedSetup = useMemo(
    () => resolveFocusedSetup(deliberationFocus, activeSetups),
    [deliberationFocus, activeSetups],
  )
  const focusedPositionId = focusedPosition?.positionId ?? null
  const focusedTrackedPosition = useMemo(
    () => focusedPositionId != null ? sources.getTrackedPosition(focusedPositionId) : null,
    [focusedPositionId, sources, tick],
  )
  const focusedPositionLabel = focusedPosition != null
    ? `${focusedPosition.coin} ${focusedPosition.side.toUpperCase()}`
    : null
  const focusedStrategyPaused = focusedStrategyId != null
    ? (snapshot.strategyGlobals?.[focusedStrategyId]?.globalPaused ?? false)
    : false
  const persistedOperatorAudit = sources.getOperatorAuditEntries()
  const briefingRefreshStats = useMemo(() => sources.getBriefingRefreshStats(), [tick])
  const briefingRefreshHealth = useMemo(() => sources.getBriefingRefreshHealth(), [tick])
  const briefingRefreshHistory = useMemo(() => sources.getBriefingRefreshHistory(), [tick])
  const briefingRefreshIncidents = useMemo(() => sources.getBriefingRefreshIncidents(), [tick])
  const operatorAudit = useMemo(
    () => mergeOperatorAuditEntries(persistedOperatorAudit, ephemeralOperatorAudit),
    [persistedOperatorAudit, ephemeralOperatorAudit],
  )
  const focusedOperatorAudit = useMemo(
    () => resolveFocusedOperatorAudit(operatorAudit, deliberationFocus, positions, activeSetups),
    [operatorAudit, deliberationFocus, positions, activeSetups],
  )
  const healthTargetFocus = useMemo(
    () => resolveBriefingHealthFocus(briefingRefreshHealth, positions, activeSetups),
    [briefingRefreshHealth, positions, activeSetups],
  )

  useEffect(() => {
    if (deliberationFocus.kind === 'auto') return
    const stillExists = focusCandidates.some(candidate => {
      if (candidate.kind !== deliberationFocus.kind) return false
      if (candidate.kind === 'position' && deliberationFocus.kind === 'position') {
        return candidate.positionId === deliberationFocus.positionId
      }
      if (candidate.kind === 'setup' && deliberationFocus.kind === 'setup') {
        return candidate.setupId === deliberationFocus.setupId
      }
      return false
    })
    if (!stillExists) setDeliberationFocus({ kind: 'auto' })
  }, [focusCandidates, deliberationFocus])

  useEffect(() => {
    const now = Date.now()
    if (pendingPauseConfirm != null && pendingPauseConfirm.expiresAt <= now) {
      setPendingPauseConfirm(null)
    }
    if (actionBanner != null && actionBanner.expiresAt <= now) {
      setActionBanner(null)
    }
    if (pendingCloseConfirm != null && pendingCloseConfirm.expiresAt <= now) {
      setPendingCloseConfirm(null)
    }
    if (pendingReduceConfirm != null && pendingReduceConfirm.expiresAt <= now) {
      setPendingReduceConfirm(null)
    }
  }, [tick, pendingPauseConfirm, pendingCloseConfirm, pendingReduceConfirm, actionBanner])

  useEffect(() => {
    if (pendingPauseConfirm == null) return
    if (focusedStrategyId == null || focusedStrategyId !== pendingPauseConfirm.strategyId) {
      setPendingPauseConfirm(null)
    }
  }, [focusedStrategyId, pendingPauseConfirm])

  useEffect(() => {
    if (pendingCloseConfirm == null) return
    if (focusedPositionId == null || focusedPositionId !== pendingCloseConfirm.positionId) {
      setPendingCloseConfirm(null)
    }
  }, [focusedPositionId, pendingCloseConfirm])

  useEffect(() => {
    if (pendingReduceConfirm == null) return
    if (focusedPositionId == null || focusedPositionId !== pendingReduceConfirm.positionId) {
      setPendingReduceConfirm(null)
    }
  }, [focusedPositionId, pendingReduceConfirm])

  useInput((input) => {
    if (input === 'n') {
      setDeliberationFocus(current => cycleDeliberationFocus(current, focusCandidates, 1))
    }
    if (input === 'p') {
      setDeliberationFocus(current => cycleDeliberationFocus(current, focusCandidates, -1))
    }
    if (input === '0') {
      setDeliberationFocus({ kind: 'auto' })
    }
    if (input === 'h') {
      if (healthTargetFocus != null) {
        setDeliberationFocus(healthTargetFocus)
        setActionBanner({
          color: 'green',
          text: `Focused health target ${describeDeliberationFocus(healthTargetFocus, positions, activeSetups)}`,
          expiresAt: Date.now() + 4_000,
        })
      } else {
        setActionBanner({
          color: 'yellow',
          text: 'No health target available to focus right now',
          expiresAt: Date.now() + 4_000,
        })
      }
    }
    const directFocus = resolveDeliberationFocusDigit(input, focusSlots)
    if (directFocus != null) {
      setDeliberationFocus(directFocus)
    }
    if (input === 's') {
      if (focusedStrategyId == null) {
        setActionBanner({
          color: 'yellow',
          text: 'Select a focused setup or position before using strategy actions',
          expiresAt: Date.now() + 4_000,
        })
        return
      }

      const strategyLabel = focusedStrategyId
      if (focusedStrategyPaused) {
        const ok = sources.setStrategyPaused(
          focusedStrategyId,
          false,
          `manual via TUI (${deliberationFocusLabel})`,
        )
        setPendingPauseConfirm(null)
        setActionBanner({
          color: ok ? 'green' : 'red',
          text: ok
            ? `${strategyLabel} resumed from TUI focus`
            : `${strategyLabel} resume failed`,
          expiresAt: Date.now() + 5_000,
        })
        return
      }

      if (pendingPauseConfirm?.strategyId !== focusedStrategyId) {
        setPendingPauseConfirm({ strategyId: focusedStrategyId, expiresAt: Date.now() + 5_000 })
        appendEphemeralOperatorAudit({
          action: 'pause',
          target: strategyLabel,
          status: 'armed',
          coin: focusedCoin,
          strategyId: focusedStrategyId,
        })
        setActionBanner({
          color: 'yellow',
          text: `${strategyLabel} pause is armed. Press s again to confirm. This may close live positions.`,
          expiresAt: Date.now() + 5_000,
        })
        return
      }

      const ok = sources.setStrategyPaused(
        focusedStrategyId,
        true,
        `manual via TUI (${deliberationFocusLabel})`,
      )
      setPendingPauseConfirm(null)
      setActionBanner({
        color: ok ? 'green' : 'red',
        text: ok
          ? `${strategyLabel} paused from TUI focus`
          : `${strategyLabel} pause failed`,
        expiresAt: Date.now() + 5_000,
      })
      return
    }
    if (input === 'x') {
      if (focusedPositionId == null || focusedPositionLabel == null) {
        setActionBanner({
          color: 'yellow',
          text: 'Focus a tracked position before using close action',
          expiresAt: Date.now() + 4_000,
        })
        return
      }

      if (pendingCloseConfirm?.positionId !== focusedPositionId) {
        setPendingCloseConfirm({ positionId: focusedPositionId, expiresAt: Date.now() + 5_000 })
        appendEphemeralOperatorAudit({
          action: 'close',
          target: focusedPositionLabel,
          status: 'armed',
          coin: focusedTrackedPosition?.coin ?? focusedCoin,
          strategyId: focusedTrackedPosition?.strategyId ?? focusedStrategyId,
          positionId: focusedPositionId,
        })
        setActionBanner({
          color: 'yellow',
          text: `${focusedPositionLabel} close is armed. Press x again to confirm.`,
          expiresAt: Date.now() + 5_000,
        })
        return
      }

      const ok = sources.closePosition(
        focusedPositionId,
        `manual via TUI (${focusedPositionLabel})`,
      )
      setPendingCloseConfirm(null)
      setActionBanner({
        color: ok ? 'green' : 'red',
        text: ok
          ? `${focusedPositionLabel} close submitted from TUI focus`
          : `${focusedPositionLabel} close failed`,
        expiresAt: Date.now() + 5_000,
      })
      return
    }
    const reducePct = input === 'r' ? 0.25 : input === 'f' ? 0.5 : null
    if (reducePct != null) {
      if (focusedPositionId == null || focusedPositionLabel == null) {
        setActionBanner({
          color: 'yellow',
          text: 'Focus a tracked position before using reduce action',
          expiresAt: Date.now() + 4_000,
        })
        return
      }

      const isSamePending = pendingReduceConfirm?.positionId === focusedPositionId
        && Math.abs(pendingReduceConfirm.closePct - reducePct) < 0.0001

      if (!isSamePending) {
        setPendingReduceConfirm({ positionId: focusedPositionId, closePct: reducePct, expiresAt: Date.now() + 5_000 })
        appendEphemeralOperatorAudit({
          action: `reduce ${(reducePct * 100).toFixed(0)}%`,
          target: focusedPositionLabel,
          status: 'armed',
          coin: focusedTrackedPosition?.coin ?? focusedCoin,
          strategyId: focusedTrackedPosition?.strategyId ?? focusedStrategyId,
          positionId: focusedPositionId,
        })
        setActionBanner({
          color: 'yellow',
          text: `${focusedPositionLabel} reduce ${(reducePct * 100).toFixed(0)}% is armed. Press the same key again to confirm.`,
          expiresAt: Date.now() + 5_000,
        })
        return
      }

      const ok = sources.partialClosePosition(
        focusedPositionId,
        reducePct,
        `manual via TUI (${focusedPositionLabel})`,
      )
      setPendingReduceConfirm(null)
      setActionBanner({
        color: ok ? 'green' : 'red',
        text: ok
          ? `${focusedPositionLabel} reduced ${(reducePct * 100).toFixed(0)}% from TUI focus`
          : `${focusedPositionLabel} reduce failed`,
        expiresAt: Date.now() + 5_000,
      })
    }
  })

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

  const liveStrategyStats = useMemo(() => sources.getLiveStrategyWalletStats(), [tick])

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
      <FocusStrip slots={focusSlots} current={deliberationFocus} />
      <ActionStrip
        strategyId={focusedStrategyId}
        strategyPaused={focusedStrategyPaused}
        pendingPauseConfirm={pendingPauseConfirm?.strategyId ?? null}
        positionLabel={focusedPositionLabel}
        pendingCloseConfirm={pendingCloseConfirm?.positionId === focusedPositionId ? focusedPositionLabel : null}
        pendingReduceConfirm={
          pendingReduceConfirm?.positionId === focusedPositionId && focusedPositionLabel != null
            ? `${focusedPositionLabel} ${(pendingReduceConfirm.closePct * 100).toFixed(0)}%`
            : null
        }
        banner={actionBanner == null ? null : { color: actionBanner.color, text: actionBanner.text }}
      />
      <OperatorAuditPanel entries={operatorAudit} />

      <Box flexShrink={0}>
        <AccountPanel
          account={account}
          dailyPnlGlobal={snapshot.global.dailyPnl}
          unrealizedPnl={unrealizedPnl}
          paperStats={paperStats}
          paperDerived={paperDerived}
          strategyGlobals={snapshot.strategyGlobals}
          liveStrategyStats={liveStrategyStats}
        />
        <StrategyPanel snapshot={snapshot} activeSetups={activeSetups} invStats={invStats} />
        <DeliberationPanel trace={focusedTrace} focusLabel={deliberationFocusLabel} />
        <UnifiedHealthPanel
          report={health}
          subCount={subCount}
          stats={briefingRefreshStats}
          briefingHealth={briefingRefreshHealth}
          history={briefingRefreshHistory}
          incidents={briefingRefreshIncidents}
        />
      </Box>

      <Box flexDirection="row" flexGrow={1} minHeight={0} width="100%">
        <Box flexGrow={1} flexBasis="50%" minWidth={0} width="50%" flexDirection="column">
          <FocusDetailPanel
            position={focusedTrackedPosition}
            setup={focusedSetup}
            trace={focusedTrace}
            linkedOperatorAudit={focusedOperatorAudit}
            getAssetPrice={sources.getAssetPrice}
            focusLabel={deliberationFocusLabel}
          />
          <PositionsPanel
            positions={positions}
            getAssetPrice={sources.getAssetPrice}
            rowsPerCol={layout.positionsRowsPerCol}
            pc={positionsColumnWidths}
            priceTick={tick}
            focusedPositionId={focusedPositionId}
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
            focusedCoin={focusedCoin}
            focusLabel={deliberationFocusLabel}
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
export function appendLog(_msg: string): void { }

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
