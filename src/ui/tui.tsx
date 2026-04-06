/**
 * Terminal UI (TUI) — Full-screen dashboard using ink (React for CLI).
 *
 * Layout:
 *   ┌─ Header ────────────────────────────────────────────────┐
 *   ├─ Account ──────────┬─ Health ───────────────────────────┤
 *   ├─ Positions ─────────────────────────────────────────────┤
 *   ├─ Coins ─────────────────────────────────────────────────┤
 *   ├─ Signals Log ───────────────────────────────────────────┤
 *   └────────────────────────────────────────────────────────┘
 *
 * Data sources: all in-process singletons (agent, pipeline, health, positions, exchange).
 * Refresh: 3s interval. Signal log: event-driven via appendSignal().
 */

import React, { useState, useEffect, useMemo, memo } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import type { AgentAction } from '../agent/types.js'
import type { AgentSnapshot } from '../agent/types.js'
import type { StatusSnapshot } from '../scanner/pipeline.js'
import { formatAction } from './terminal.js'
import { PAPER_TRADE, WS_MAX_SUBSCRIPTIONS } from '../config.js'

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

// ─── State (module-level for appendSignal) ──────────────────────────────────

let signalListeners: Array<(line: string) => void> = []
let inkInstance: ReturnType<typeof render> | null = null

// ─── Helpers ────────────────────────────────────────────────────────────────

function uptimeStr(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function statusIcon(status: string): string {
  if (status === 'ok') return '✓'
  if (status === 'degraded') return '⚠'
  return '✗'
}

function statusColor(status: string): 'green' | 'yellow' | 'red' {
  if (status === 'ok') return 'green'
  if (status === 'degraded') return 'yellow'
  return 'red'
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
      borderStyle="round"
      borderColor="cyan"
      width={width ?? '100%'}
      height={height}
      minHeight={minHeight}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold color="cyan">{title}</Text>
      {children}
    </Box>
  )
}

const HeaderPanel = memo(function HeaderPanel({ snapshot, coinCount }: { snapshot: AgentSnapshot; coinCount: number }) {
  const mode = PAPER_TRADE ? 'PAPER' : 'LIVE'
  const modeColor = PAPER_TRADE ? 'yellow' : 'red'
  const paused = snapshot.global.globalPaused
  const uptime = uptimeStr(snapshot.global.uptime)

  return (
    <Box borderStyle="round" borderColor="cyan" paddingLeft={1} paddingRight={1}>
      <Text bold color="cyan">Minh (明) v2.0.0</Text>
      <Text> │ </Text>
      <Text bold color={modeColor}>{mode}</Text>
      {paused && <Text bold color="red"> [PAUSED]</Text>}
      <Text> │ Uptime: {uptime}</Text>
      <Text> │ {coinCount} coins</Text>
      <Text dimColor> │ q/Ctrl-C to quit</Text>
    </Box>
  )
})

const AccountPanel = memo(function AccountPanel({ account, dailyPnl }: {
  account: { effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null
  dailyPnl: number
}) {
  const pnlColor = dailyPnl >= 0 ? 'green' : 'red'
  const pnlSign = dailyPnl >= 0 ? '+' : ''

  return (
    <Panel title="Account" width="50%">
      {account ? (
        <>
          <Text> Balance:  <Text bold>${account.effectiveBalance.toFixed(2)}</Text></Text>
          <Text dimColor>   Perp:   ${account.accountValue.toFixed(2)}</Text>
          <Text dimColor>   Spot:   ${account.spotUsdcBalance.toFixed(2)}</Text>
          <Text> Margin:   ${account.totalMarginUsed.toFixed(2)}</Text>
          <Text> Free:     ${account.withdrawable.toFixed(2)}</Text>
        </>
      ) : (
        <>
          <Text dimColor> Balance:  loading...</Text>
          <Text> </Text><Text> </Text><Text> </Text><Text> </Text>
        </>
      )}
      <Text> Daily PnL: <Text color={pnlColor}>{pnlSign}${dailyPnl.toFixed(2)}</Text></Text>
    </Panel>
  )
})

const HealthPanel = memo(function HealthPanel({ report, subCount }: {
  report: TuiDataSources['getHealthReport'] extends () => infer R ? R : never
  subCount: number
}) {
  const rss = (report.rssBytes / 1024 / 1024).toFixed(0)

  return (
    <Panel title="Health" width="50%">
      <Text> Overall:  <Text color={statusColor(report.overall)}>{statusIcon(report.overall)} {report.overall.toUpperCase()}</Text></Text>
      <Text> Feed:     <Text color={statusColor(report.components.feed.status)}>{statusIcon(report.components.feed.status)} {report.components.feed.status}</Text>{report.components.feed.consecutiveErrors > 0 && <Text dimColor> ({report.components.feed.consecutiveErrors} errs)</Text>}</Text>
      <Text> DB:       <Text color={statusColor(report.components.db.status)}>{statusIcon(report.components.db.status)} {report.components.db.status}</Text>{report.components.db.consecutiveErrors > 0 && <Text dimColor> ({report.components.db.consecutiveErrors} errs)</Text>}</Text>
      <Text> Exchange: <Text color={statusColor(report.components.exchange.status)}>{statusIcon(report.components.exchange.status)} {report.components.exchange.status}</Text>{report.components.exchange.consecutiveErrors > 0 && <Text dimColor> ({report.components.exchange.consecutiveErrors} errs)</Text>}</Text>
      <Text> RSS:      {rss} MB</Text>
      <Text> WS Subs:  {subCount}/{WS_MAX_SUBSCRIPTIONS}</Text>
    </Panel>
  )
})

const PositionsPanel = memo(function PositionsPanel({ positions }: {
  positions: Array<{ coin: string; side: 'long' | 'short'; currentSize: number; entryPrice: number; slPrice: number; tpPrice: number; strategyId: string }>
}) {
  if (positions.length === 0) {
    return (
      <Panel title="Positions">
        <Text dimColor> No open positions</Text>
      </Panel>
    )
  }

  return (
    <Panel title={`Positions (${positions.length})`}>
      <Box>
        <Text dimColor>
          {' '}{'COIN'.padEnd(10)} {'SIDE'.padEnd(7)} {'SIZE'.padEnd(10)} {'ENTRY'.padEnd(12)} {'SL'.padEnd(10)} {'TP'.padEnd(10)} STRATEGY
        </Text>
      </Box>
      {positions.map(p => (
        <Box key={`${p.coin}-${p.strategyId}`}>
          <Text>
            {' '}{p.coin.padEnd(10)}{' '}
          </Text>
          <Text color={p.side === 'long' ? 'green' : 'red'}>
            {p.side.toUpperCase().padEnd(7)}
          </Text>
          <Text>
            {Math.abs(p.currentSize).toString().padEnd(10)}{' '}
            ${p.entryPrice.toFixed(2).padEnd(11)}{' '}
            ${p.slPrice.toFixed(2).padEnd(9)}{' '}
            ${p.tpPrice.toFixed(2).padEnd(9)}{' '}
            {p.strategyId}
          </Text>
        </Box>
      ))}
    </Panel>
  )
})

type CoinInfo = { regime: string; grade: string; setups: number; bias: string; tfsReady: number }

function aggregateCoins(statuses: StatusSnapshot[]): Map<string, CoinInfo> {
  const byCoin = new Map<string, CoinInfo>()
  for (const s of statuses) {
    const prev = byCoin.get(s.coin)
    if (!prev) {
      const g = s.confluenceGrade ? `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}` : '—'
      byCoin.set(s.coin, { regime: s.regime, grade: g, setups: s.activeCount, bias: s.bias, tfsReady: 1 })
    } else {
      prev.setups += s.activeCount
      prev.tfsReady++
      if (s.confluenceGrade) {
        prev.grade = `${s.confluenceGrade}${Math.floor(s.biasConfidence * 10)}`
      }
      prev.regime = s.regime
      prev.bias = s.bias
    }
  }
  return byCoin
}

const COIN_HEADER = `${'COIN'.padEnd(8)} ${'REGIME'.padEnd(9)} ${'GRD'.padEnd(5)} ${'#'.padEnd(3)} ${'BIAS'.padEnd(8)} TF`
const TOTAL_TFS = 6

function CoinRow({ coin, info }: { coin: string; info: CoinInfo | undefined }) {
  if (!info) {
    return (
      <Box>
        <Text dimColor> {coin.padEnd(8)} {'—'.padEnd(9)} {'—'.padEnd(5)} {'0'.padEnd(3)} {'—'.padEnd(8)} —</Text>
      </Box>
    )
  }

  const regimeColor: 'green' | 'red' | 'yellow' = info.regime === 'trending' ? 'green' : info.regime === 'volatile' ? 'red' : 'yellow'
  const gradeColor: 'magenta' | 'green' | 'blue' | undefined = info.grade.startsWith('A+') ? 'magenta' : info.grade.startsWith('A') ? 'green' : info.grade.startsWith('B') ? 'blue' : undefined
  const biasColor: 'green' | 'red' | undefined = info.bias === 'bullish' ? 'green' : info.bias === 'bearish' ? 'red' : undefined

  return (
    <Box>
      <Text> {coin.padEnd(8)} </Text>
      <Text color={regimeColor}>{info.regime.padEnd(9)} </Text>
      <Text bold={info.grade.startsWith('A+')} color={gradeColor}>{info.grade.padEnd(5)} </Text>
      <Text>{String(info.setups).padEnd(3)} </Text>
      <Text color={biasColor}>{info.bias.padEnd(8)} </Text>
      <Text>{info.tfsReady}/{TOTAL_TFS}</Text>
    </Box>
  )
}

const CoinColumn = memo(function CoinColumn({ title, coins, byCoin }: {
  title: string
  coins: string[]
  byCoin: Map<string, CoinInfo>
}) {
  return (
    <Panel title={title} width="50%">
      <Box>
        <Text dimColor> {COIN_HEADER}</Text>
      </Box>
      {coins.map((coin: string) => (
        <CoinRow key={coin} coin={coin} info={byCoin.get(coin)} />
      ))}
    </Panel>
  )
})

const CoinsPanel = memo(function CoinsPanel({ statuses, trackedCoins }: { statuses: StatusSnapshot[]; trackedCoins: string[] }) {
  const byCoin = useMemo(() => aggregateCoins(statuses), [statuses])

  if (trackedCoins.length === 0) {
    return (
      <Box>
        <Panel title="Coins L" width="50%">
          <Text dimColor> No coins tracked</Text>
        </Panel>
        <Panel title="Coins R" width="50%">
          <Text dimColor> No coins tracked</Text>
        </Panel>
      </Box>
    )
  }

  const mid = Math.ceil(trackedCoins.length / 2)
  const left = trackedCoins.slice(0, mid)
  const right = trackedCoins.slice(mid)

  return (
    <Box>
      <CoinColumn title={`Coins 1-${mid} (${trackedCoins.length})`} coins={left} byCoin={byCoin} />
      <CoinColumn title={`Coins ${mid + 1}-${trackedCoins.length}`} coins={right} byCoin={byCoin} />
    </Box>
  )
})

const SignalsPanel = memo(function SignalsPanel({ signals }: { signals: string[] }) {
  const recent = signals.slice(-15)
  return (
    <Panel title="Signals" minHeight={5}>
      {recent.length === 0 ? (
        <Text dimColor> Waiting for signals...</Text>
      ) : (
        recent.map((line, i) => <Text key={i}> {line}</Text>)
      )}
    </Panel>
  )
})

// ─── Main App ───────────────────────────────────────────────────────────────

function App({ sources }: { sources: TuiDataSources }) {
  const { exit } = useApp()
  const [tick, setTick] = useState(0)
  const [signals, setSignals] = useState<string[]>([])
  const [account, setAccount] = useState<{ effectiveBalance: number; accountValue: number; spotUsdcBalance: number; totalMarginUsed: number; withdrawable: number } | null>(null)

  // Keyboard
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      process.emit('SIGINT' as any)
    }
  })

  // Refresh data every 3s
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 3000)
    return () => clearInterval(id)
  }, [])

  // Refresh account every 10s
  useEffect(() => {
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
  }, [])

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

  // Read data (re-read each tick, memoize derived values)
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
  const trackedCoins = useMemo(() => sources.getTrackedCoins(), [tick])

  return (
    <Box flexDirection="column">
      <HeaderPanel snapshot={snapshot} coinCount={trackedCoins.length} />

      <Box>
        <AccountPanel account={account} dailyPnl={snapshot.global.dailyPnl} />
        <HealthPanel report={health} subCount={subCount} />
      </Box>

      <PositionsPanel positions={positions} />
      <CoinsPanel statuses={statuses} trackedCoins={trackedCoins} />
      <SignalsPanel signals={signals} />
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
 * Append a signal/action to the log panel.
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
 * Add a log message to the signals panel.
 */
export function appendLog(msg: string): void {
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
}

/** Whether the TUI is currently running. */
export function isTuiRunning(): boolean {
  return inkInstance !== null
}
