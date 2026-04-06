/**
 * Terminal UI (TUI) — Full-screen trading terminal dashboard using ink.
 *
 * Layout:
 *   ┌─ Header Bar ──────────────────────────────────────────────┐
 *   ├─ Account ──────────┬─ System ─────────────────────────────┤
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
import type { StatusSnapshot } from '../scanner/orchestrator.js'
import { formatAction } from './terminal.js'
import { PAPER_TRADE, WS_MAX_SUBSCRIPTIONS, TIMEFRAMES, MIN_CANDLES_FOR_SCAN } from '../config.js'
import { candleCount } from '../feed/store.js'
import type { CandleInterval } from '../types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TuiDataSources {
  getAgentSnapshot: () => AgentSnapshot
  getPositions: () => Map<string, { coin: string; side: 'long' | 'short'; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
  getStatus: () => StatusSnapshot[]
  getHealthReport: () => { overall: string; uptime: number; rssBytes: number; components: { feed: { status: string; consecutiveErrors: number }; db: { status: string; consecutiveErrors: number }; exchange: { status: string; consecutiveErrors: number } } }
  getAccountState: () => Promise<{ effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number }> | null
  getSubscriptionCount: () => number
  getTrackedCoins: () => string[]
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

function Panel({ title, children, width, height, minHeight }: {
  title: string
  children: React.ReactNode
  width?: string | number
  height?: number
  minHeight?: number
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BORDER_COLOR}
      width={width ?? '100%'}
      height={height}
      minHeight={minHeight}
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

const AccountPanel = memo(function AccountPanel({ account, dailyPnl }: {
  account: { effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null
  dailyPnl: number
}) {
  const pnlColor = dailyPnl >= 0 ? 'green' : 'red'
  const pnlSign = dailyPnl >= 0 ? '+' : ''

  return (
    <Panel title="Account" width="35%">
      {account ? (
        <>
          <Box justifyContent="space-between">
            <Text color={DIM}>Balance</Text>
            <Text bold>${account.effectiveBalance.toFixed(2)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Margin Used</Text>
            <Text>${account.totalMarginUsed.toFixed(2)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Available</Text>
            <Text color="green">${account.withdrawable.toFixed(2)}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Day P&L</Text>
            <Text bold color={pnlColor}>{pnlSign}${dailyPnl.toFixed(2)}</Text>
          </Box>
        </>
      ) : (
        <>
          <Box justifyContent="space-between">
            <Text color={DIM}>Balance</Text>
            <Text color={DIM}>---</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Margin Used</Text>
            <Text color={DIM}>---</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Available</Text>
            <Text color={DIM}>---</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text color={DIM}>Day P&L</Text>
            <Text color={DIM}>---</Text>
          </Box>
        </>
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
    <Panel title="System" width="35%">
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

const PositionsPanel = memo(function PositionsPanel({ positions }: {
  positions: Array<{ coin: string; side: 'long' | 'short'; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
}) {
  if (positions.length === 0) {
    return (
      <Panel title="Positions">
        <Text color={DIM}> No open positions</Text>
      </Panel>
    )
  }

  return (
    <Panel title={`Positions (${positions.length})`}>
      <Box>
        <Text color={DIM}>
          {' '}{'COIN'.padEnd(10)} {'SIDE'.padEnd(7)} {'SIZE'.padEnd(10)} {'ENTRY'.padEnd(12)} {'SL'.padEnd(10)} {'TP'.padEnd(10)} STRATEGY
        </Text>
      </Box>
      {positions.map(p => (
        <Box key={`${p.coin}-${p.strategyId}`}>
          <Text bold> {p.coin.padEnd(10)} </Text>
          <Text bold color={p.side === 'long' ? 'green' : 'red'}>
            {p.side.toUpperCase().padEnd(7)}
          </Text>
          <Text>
            {Math.abs(p.currentSize).toString().padEnd(10)}{' '}
          </Text>
          <Text color={ACCENT}>
            {p.entryPrice.toFixed(2).padEnd(11)}{' '}
          </Text>
          <Text color="red">
            {p.slPrice.toFixed(2).padEnd(9)}{' '}
          </Text>
          <Text color="green">
            {p.tpPrice.toFixed(2).padEnd(9)}{' '}
          </Text>
          <Text color={DIM}>{p.strategyId}</Text>
        </Box>
      ))}
    </Panel>
  )
})

// ─── Watchlist ───────────────────────────────────────────────────────────────

type CoinInfo = { regime: string; grade: string; setups: number; bias: string; tfsReady: number }

/** Count TFs with enough candle data for scanning. */
function countReadyTFs(coin: string): number {
  let count = 0
  for (const tf of TIMEFRAMES) {
    if (candleCount(coin, tf as CandleInterval) >= MIN_CANDLES_FOR_SCAN) count++
  }
  return count
}

function aggregateCoins(statuses: StatusSnapshot[]): Map<string, CoinInfo> {
  const byCoin = new Map<string, CoinInfo>()
  for (const s of statuses) {
    const prev = byCoin.get(s.coin)
    if (!prev) {
      const g = s.confluenceGrade ? `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}` : '\u2014'
      byCoin.set(s.coin, { regime: s.regime, grade: g, setups: s.activeCount, bias: s.bias, tfsReady: countReadyTFs(s.coin) })
    } else {
      prev.setups += s.activeCount
      if (s.confluenceGrade) {
        prev.grade = `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}`
      }
      prev.regime = s.regime
      prev.bias = s.bias
    }
  }
  return byCoin
}

const TOTAL_TFS = TIMEFRAMES.length

function regimeLabel(regime: string): string {
  switch (regime) {
    case 'trending': return 'TREND'
    case 'volatile': return 'VOLAT'
    case 'sideways': return 'RANGE'
    default: return regime.toUpperCase().slice(0, 5)
  }
}

function regimeColor(regime: string): 'green' | 'red' | 'yellow' {
  if (regime === 'trending') return 'green'
  if (regime === 'volatile') return 'red'
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

const COL = { coin: 12, regime: 8, grade: 5, setups: 3, bias: 10, tf: 5 }
const COIN_HEADER = `${'COIN'.padEnd(COL.coin)} ${'RGME'.padEnd(COL.regime)} ${'GRD'.padEnd(COL.grade)} ${'#'.padEnd(COL.setups)} ${'BIAS'.padEnd(COL.bias)} TF`

function CoinRow({ coin, info }: { coin: string; info: CoinInfo | undefined }) {
  if (!info) {
    return (
      <Box>
        <Text color={DIM}> {coin.padEnd(COL.coin)} {'\u2014'.padEnd(COL.regime)} {'\u2014'.padEnd(COL.grade)} {'0'.padEnd(COL.setups)} {'\u2014'.padEnd(COL.bias)} \u2014</Text>
      </Box>
    )
  }

  const tfColor = info.tfsReady === TOTAL_TFS ? 'green' : info.tfsReady >= 4 ? 'yellow' : 'red'

  return (
    <Box>
      <Text bold> {coin.padEnd(COL.coin)} </Text>
      <Text color={regimeColor(info.regime)}>{regimeLabel(info.regime).padEnd(COL.regime)} </Text>
      <Text bold={info.grade.startsWith('A')} color={gradeColor(info.grade)}>{info.grade.padEnd(COL.grade)} </Text>
      <Text>{String(info.setups).padEnd(COL.setups)} </Text>
      <Text color={biasColor(info.bias)}>{biasArrow(info.bias)} {info.bias.padEnd(COL.bias - 2)} </Text>
      <Text color={tfColor}>{info.tfsReady}/{TOTAL_TFS}</Text>
    </Box>
  )
}

const WatchlistColumn = memo(function WatchlistColumn({ title, coins, byCoin }: {
  title: string
  coins: string[]
  byCoin: Map<string, CoinInfo>
}) {
  return (
    <Panel title={title} width="50%">
      <Box>
        <Text color={DIM}> {COIN_HEADER}</Text>
      </Box>
      {coins.map((coin: string) => (
        <CoinRow key={coin} coin={coin} info={byCoin.get(coin)} />
      ))}
    </Panel>
  )
})

const WatchlistPanel = memo(function WatchlistPanel({ statuses, trackedCoins }: { statuses: StatusSnapshot[]; trackedCoins: string[] }) {
  const byCoin = useMemo(() => aggregateCoins(statuses), [statuses])

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

  const mid = Math.ceil(trackedCoins.length / 2)
  const left = trackedCoins.slice(0, mid)
  const right = trackedCoins.slice(mid)

  return (
    <Box>
      <WatchlistColumn title={`Watchlist 1-${mid} (${trackedCoins.length})`} coins={left} byCoin={byCoin} />
      <WatchlistColumn title={`Watchlist ${mid + 1}-${trackedCoins.length}`} coins={right} byCoin={byCoin} />
    </Box>
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

// ASCII sprites — 5 lines each, fixed width
const BUDDY_SPRITES: Record<BuddyMood, string[]> = {
  idle: [
    '   /\\_/\\  ',
    '  ( o.o ) ',
    '   > ^ <  ',
    '  /|   |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
  scanning: [
    '   /\\_/\\  ',
    '  ( \u25C9.\u25C9 ) ',
    '   > ^ <  ',
    '  /| ~ |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
  signal: [
    '   /\\_/\\  ',
    '  ( \u2727.\u2727 ) ',
    '   > \u2605 <  ',
    ' \u26A1/|   |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
  profit: [
    '   /\\_/\\  ',
    '  ( ^.^ ) ',
    '   > w <  ',
    ' \u2728/|   |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
  loss: [
    '   /\\_/\\  ',
    '  ( ;.; ) ',
    '   > n <  ',
    '  /|   |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
  paused: [
    '   /\\_/\\  ',
    '  ( -.- ) ',
    '   > ~ <  ',
    '  /|   |\\ ',
    '  zzZZ    ',
  ],
  alert: [
    '   /\\_/\\  ',
    '  ( \u25B2.\u25B2 ) ',
    '   > ! <  ',
    '  /| \u2191 |\\ ',
    '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500 ',
  ],
}

const BUDDY_SPEECH: Record<BuddyMood, string[]> = {
  idle:     ['Scanning...', 'Watching markets', 'All quiet', 'Waiting for setups'],
  scanning: ['Eyes on chart', 'Structure forming', 'Analyzing...', 'Reading PA'],
  signal:   ['Setup found!', 'Signal detected!', 'Check this out!', 'Entry nearby!'],
  profit:   ['Nice trade!', 'Green day!', 'Money printer go', 'We cooking!'],
  loss:     ['Rough patch...', 'Stay disciplined', 'Part of the game', 'Next one...'],
  paused:   ['Taking a break', 'System paused', 'Standing by...', 'Resting...'],
  alert:    ['Position open!', 'Monitoring trade', 'Watching entry', 'In the market!'],
}

function getBuddySpeech(mood: BuddyMood, tick: number): string {
  const phrases = BUDDY_SPEECH[mood]
  return phrases[tick % phrases.length]!
}

const BuddyPanel = memo(function BuddyPanel({ mood, tick }: { mood: BuddyMood; tick: number }) {
  const sprite = BUDDY_SPRITES[mood]
  const speech = getBuddySpeech(mood, tick)

  const moodColor: 'green' | 'red' | 'yellow' | 'cyan' | 'magenta' =
    mood === 'profit' ? 'green'
    : mood === 'loss' ? 'red'
    : mood === 'paused' ? 'yellow'
    : mood === 'signal' ? 'magenta'
    : mood === 'alert' ? 'cyan'
    : 'cyan'

  // Speech bubble
  const bubbleWidth = Math.max(speech.length + 2, 12)
  const bubbleTop = '\u250C' + '\u2500'.repeat(bubbleWidth) + '\u2510'
  const bubbleBot = '\u2514' + '\u2500'.repeat(bubbleWidth) + '\u2518'
  const bubbleMid = '\u2502 ' + speech.padEnd(bubbleWidth - 1) + '\u2502'
  const pointer =   '    \u2514\u2500\u2510'

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

const TapePanel = memo(function TapePanel({ signals }: { signals: string[] }) {
  const recent = signals.slice(-50)
  return (
    <Panel title="Tape" minHeight={10}>
      {recent.length === 0 ? (
        <Text color={DIM}> Waiting for signals...</Text>
      ) : (
        recent.map((line, i) => <Text key={i}> {line}</Text>)
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

  // Refresh during backfill: 1s for snappy progress bars, 3s after
  useEffect(() => {
    const ms = isBackfillDone ? 3000 : 1000
    const id = setInterval(() => setTick(t => t + 1), ms)
    return () => clearInterval(id)
  }, [isBackfillDone])

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
    <Box flexDirection="column" height={termRows}>
      <HeaderBar snapshot={snapshot} coinCount={trackedCoins.length} />

      <Box>
        <AccountPanel account={account} dailyPnl={snapshot.global.dailyPnl} />
        <BuddyPanel mood={getBuddyMood(snapshot, positions.length, snapshot.global.dailyPnl, signals.length)} tick={tick} />
        <SystemPanel report={health} subCount={subCount} />
      </Box>

      <PositionsPanel positions={positions} />
      <WatchlistPanel statuses={statuses} trackedCoins={trackedCoins} />
      <TapePanel signals={signals} />
      <Box flexGrow={1} />
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
 * Called from agent.onAction() wiring.
 */
export function appendSignal(action: AgentAction): void {
  const line = formatAction(action)
  if (!line) return

  // Strip ANSI codes — ink handles its own colors
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '')
  for (const listener of signalListeners) {
    listener(clean)
  }
}

/**
 * Add a log message to the tape panel.
 * Filters out noisy infrastructure warnings (staleness, etc.) — only signal/agent messages.
 */
export function appendLog(msg: string): void {
  // Skip infrastructure noise — staleness warnings are not trading signals
  if (msg.includes('stale') && msg.includes('no candle update')) return
  if (msg.includes('stale') && msg.includes('no book update')) return

  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '')
  for (const listener of signalListeners) {
    listener(clean)
  }
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
