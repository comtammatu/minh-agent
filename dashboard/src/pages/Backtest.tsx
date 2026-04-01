/**
 * Backtest page — list runs + detail view + "Run from browser" config editor.
 *
 * Data sources:
 *   - REST /api/backtest/runs → list all saved runs
 *   - REST /api/backtest/runs/:id → full run detail (metrics + trades + equity)
 *   - POST /api/backtest/run → trigger new backtest
 *   - SSE  /api/backtest/progress → live progress updates
 */

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'

// ─── Types ──────────────────────────────────────────────────────────────────

interface RunSummary {
  id: string
  name: string | null
  totalTrades: number
  netPnl: number
  winRate: number
  maxDrawdown: number
  sharpeRatio: number
  expectancy: number
  createdAt: string
  config: {
    coins?: string[]
    startDate?: string
    endDate?: string
    initialCapital?: number
  }
}

interface BacktestTrade {
  coin: string
  interval: string
  side: string
  patternType: string
  confluenceGrade: string | null
  entryPrice: number
  exitPrice: number
  slPrice: number
  tpPrice: number
  sizeUsd: number
  entryTime: number
  exitTime: number
  holdingBars: number
  pnl: number
  pnlPct: number
  exitReason: string
}

interface BacktestMetrics {
  totalTrades: number
  winRate: number
  profitFactor: number
  sharpeRatio: number
  sortinoRatio: number
  maxDrawdown: number
  maxDrawdownDuration: number
  avgWin: number
  avgLoss: number
  avgRR: number
  avgHoldingPeriod: number
  expectancy: number
  calmarRatio: number
  netPnl: number
  grossProfit: number
  grossLoss: number
}

interface EquityPoint {
  ts: number
  equity: number
}

interface FullRun extends RunSummary {
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: EquityPoint[]
}

interface MetricsDelta {
  totalTrades: number
  winRate: number
  netPnl: number
  profitFactor: number
  expectancy: number
  maxDrawdown: number
  sharpeRatio: number
  sortinoRatio: number
  calmarRatio: number
  avgRR: number
  avgHoldingBars: number
}

interface ComparisonResult {
  runA: RunSummary
  runB: RunSummary
  metricsA: BacktestMetrics
  metricsB: BacktestMetrics
  delta: MetricsDelta
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

function useBacktestRuns(refreshKey = 0) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/backtest/runs?limit=100')
        if (!res.ok) { setError(`HTTP ${res.status}`); return }
        const data = await res.json()
        if (!cancelled) { setRuns(data.runs ?? []); setError(null) }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [refreshKey])

  return { runs, loading, error }
}

function useBacktestDetail(runId: string | null) {
  const [run, setRun] = useState<FullRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) { setRun(null); return }
    let cancelled = false
    setLoading(true)
    async function load() {
      try {
        const res = await fetch(`/api/backtest/runs/${runId}`)
        if (!res.ok) { setError(`HTTP ${res.status}`); return }
        const data = await res.json()
        if (!cancelled) { setRun(data.run ?? null); setError(null) }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [runId])

  return { run, loading, error }
}

// ─── Backtest Runner Hook ──────────────────────────────────────────────────

interface BacktestRunConfig {
  coins: string[]
  timeframes: string[]
  months: number
  initialCapital: number
  name?: string
}

interface ProgressEvent {
  runId: string
  pct: number
  bar: number
  total: number
  phase: string
  savedRunId?: string
  totalTrades?: number
  netPnl?: number
  winRate?: number
  error?: string
}

function useBacktestRunner(onComplete: () => void) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  const run = useCallback(async (config: BacktestRunConfig) => {
    setRunning(true)
    setError(null)
    setProgress(null)

    // Connect SSE before POST to not miss early events
    cleanup()
    const es = new EventSource('/api/backtest/progress')
    eventSourceRef.current = es

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data) as ProgressEvent
      setProgress(data)

      if (data.phase === 'done') {
        setRunning(false)
        cleanup()
        onComplete()
      } else if (data.phase === 'error') {
        setRunning(false)
        setError(data.error ?? 'Unknown error')
        cleanup()
      }
    })

    es.onerror = () => {
      // SSE reconnects automatically, but if we're not running, clean up
      if (!running) cleanup()
    }

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
        throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`)
      }
    } catch (err) {
      setRunning(false)
      setError((err as Error).message)
      cleanup()
    }
  }, [cleanup, onComplete, running])

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup])

  return { run, running, progress, error }
}

// ─── Comparison Hook ──────────────────────────────────────────────────────

function useBacktestComparison(idA: string | null, idB: string | null) {
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [equityA, setEquityA] = useState<EquityPoint[]>([])
  const [equityB, setEquityB] = useState<EquityPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!idA || !idB) { setComparison(null); setEquityA([]); setEquityB([]); return }
    let cancelled = false
    setLoading(true)
    setError(null)

    async function load() {
      try {
        // Fetch comparison + both equity curves in parallel
        const [compRes, runARes, runBRes] = await Promise.all([
          fetch(`/api/backtest/compare?a=${idA}&b=${idB}`),
          fetch(`/api/backtest/runs/${idA}`),
          fetch(`/api/backtest/runs/${idB}`),
        ])
        if (!compRes.ok) {
          const data = await compRes.json().catch(() => ({}))
          throw new Error(data.message ?? `HTTP ${compRes.status}`)
        }
        const compData = await compRes.json()
        const aData = runARes.ok ? await runARes.json() : null
        const bData = runBRes.ok ? await runBRes.json() : null

        if (!cancelled) {
          setComparison(compData.comparison)
          setEquityA(aData?.run?.equityCurve ?? [])
          setEquityB(bData?.run?.equityCurve ?? [])
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [idA, idB])

  return { comparison, equityA, equityB, loading, error }
}

// ─── Available Options ─────────────────────────────────────────────────────

const AVAILABLE_COINS = [
  'BTC', 'ETH', 'SOL', 'DOGE', 'AVAX', 'LINK', 'ARB', 'SUI',
  'WLD', 'INJ', 'TIA', 'SEI', 'WIF', 'PEPE', 'ONDO', 'HYPE', 'TAO',
]

const AVAILABLE_TIMEFRAMES = ['5m', '15m', '1h', '4h']

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL']
const DEFAULT_TIMEFRAMES = ['15m', '1h', '4h']

// ─── Config Editor ─────────────────────────────────────────────────────────

function ConfigEditor({ onRun, running, progress, error }: {
  onRun: (config: BacktestRunConfig) => void
  running: boolean
  progress: ProgressEvent | null
  error: string | null
}) {
  const [coins, setCoins] = useState<string[]>(DEFAULT_COINS)
  const [timeframes, setTimeframes] = useState<string[]>(DEFAULT_TIMEFRAMES)
  const [months, setMonths] = useState(3)
  const [capital, setCapital] = useState(10000)
  const [name, setName] = useState('')

  const toggleItem = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter(x => x !== item) : [...list, item])
  }

  const handleRun = () => {
    if (coins.length === 0 || timeframes.length === 0) return
    onRun({ coins, timeframes, months, initialCapital: capital, name: name || undefined })
  }

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 space-y-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Run Backtest</h3>

      {/* Coins */}
      <div>
        <label className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">Coins</label>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {AVAILABLE_COINS.map(c => (
            <button
              key={c}
              onClick={() => toggleItem(coins, c, setCoins)}
              disabled={running}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                coins.includes(c)
                  ? 'bg-amber-900/50 border-amber-700 text-amber-300'
                  : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
              } disabled:opacity-50`}
            >{c}</button>
          ))}
        </div>
      </div>

      {/* Timeframes */}
      <div>
        <label className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">Timeframes</label>
        <div className="flex gap-1.5 mt-1">
          {AVAILABLE_TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => toggleItem(timeframes, tf, setTimeframes)}
              disabled={running}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                timeframes.includes(tf)
                  ? 'bg-amber-900/50 border-amber-700 text-amber-300'
                  : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
              } disabled:opacity-50`}
            >{tf}</button>
          ))}
        </div>
      </div>

      {/* Params row */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">Months</label>
          <input
            type="number" min={1} max={6} value={months}
            onChange={e => setMonths(Math.min(6, Math.max(1, +e.target.value)))}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border-default)] rounded text-[var(--text-primary)] disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">Capital ($)</label>
          <input
            type="number" min={100} step={1000} value={capital}
            onChange={e => setCapital(Math.max(100, +e.target.value))}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border-default)] rounded text-[var(--text-primary)] disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">Run Name</label>
          <input
            type="text" value={name} placeholder="optional"
            onChange={e => setName(e.target.value)}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border-default)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />
        </div>
      </div>

      {/* Run button + progress */}
      <div className="space-y-2">
        <button
          onClick={handleRun}
          disabled={running || coins.length === 0 || timeframes.length === 0}
          className="w-full py-2 text-sm font-semibold rounded bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {running ? 'Running...' : 'Run Backtest'}
        </button>

        {/* Progress bar */}
        {running && progress && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-[var(--bg-surface)] overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-[var(--text-tertiary)]">
              <span>{progress.phase}</span>
              <span>{progress.pct}%{progress.total > 0 ? ` (${progress.bar}/${progress.total})` : ''}</span>
            </div>
          </div>
        )}

        {/* Done summary */}
        {!running && progress?.phase === 'done' && (
          <div className="rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-400">
            Done: {progress.totalTrades} trades, PnL {progress.netPnl !== undefined ? (progress.netPnl >= 0 ? '+' : '') + '$' + progress.netPnl.toFixed(2) : '—'}, WR {progress.winRate !== undefined ? (progress.winRate * 100).toFixed(1) + '%' : '—'}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPnl(v: number): string {
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

function pnlColor(v: number): string {
  if (v > 0) return 'text-emerald-400'
  if (v < 0) return 'text-red-400'
  return 'text-[var(--text-secondary)]'
}

function formatDate(d: string | number): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTs(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function MetricCard({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
      <div className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold font-mono ${className ?? 'text-[var(--text-primary)]'}`}>{value}</div>
    </div>
  )
}

function EquityCurveChart({ curve }: { curve: EquityPoint[] }) {
  if (curve.length < 2) return null

  const minE = Math.min(...curve.map((p) => p.equity))
  const maxE = Math.max(...curve.map((p) => p.equity))
  const range = maxE - minE || 1
  const w = 800
  const h = 200

  const points = curve.map((p, i) => {
    const x = (i / (curve.length - 1)) * w
    const y = h - ((p.equity - minE) / range) * h
    return `${x},${y}`
  }).join(' ')

  const isProfit = curve[curve.length - 1].equity >= curve[0].equity

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
      <h4 className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Equity Curve</h4>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48">
        <polyline
          points={points}
          fill="none"
          stroke={isProfit ? '#34d399' : '#f87171'}
          strokeWidth="2"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
        <span>{formatDate(curve[0].ts)}</span>
        <span>${minE.toFixed(0)} — ${maxE.toFixed(0)}</span>
        <span>{formatDate(curve[curve.length - 1].ts)}</span>
      </div>
    </div>
  )
}

function RunDetail({ run }: { run: FullRun }) {
  const [showAllTrades, setShowAllTrades] = useState(false)
  const m = run.metrics

  const tradesByOutcome = useMemo(() => {
    const wins = run.trades.filter((t) => t.pnl > 0).length
    const losses = run.trades.filter((t) => t.pnl < 0).length
    const breakeven = run.trades.filter((t) => t.pnl === 0).length
    return { wins, losses, breakeven }
  }, [run.trades])

  const visibleTrades = showAllTrades ? run.trades : run.trades.slice(0, 50)

  return (
    <div className="space-y-4">
      {/* ── Metrics grid ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <MetricCard label="Total Trades" value={String(m.totalTrades)} />
        <MetricCard label="Win Rate" value={formatPct(m.winRate)} className={m.winRate >= 0.5 ? 'text-emerald-400' : 'text-red-400'} />
        <MetricCard label="Net PnL" value={formatPnl(m.netPnl)} className={pnlColor(m.netPnl)} />
        <MetricCard label="Profit Factor" value={m.profitFactor.toFixed(2)} className={m.profitFactor >= 1 ? 'text-emerald-400' : 'text-red-400'} />
        <MetricCard label="Sharpe" value={m.sharpeRatio.toFixed(2)} className={m.sharpeRatio >= 1 ? 'text-emerald-400' : 'text-[var(--text-primary)]'} />
        <MetricCard label="Sortino" value={m.sortinoRatio.toFixed(2)} />
        <MetricCard label="Max Drawdown" value={formatPct(m.maxDrawdown)} className="text-red-400" />
        <MetricCard label="DD Duration" value={`${m.maxDrawdownDuration} bars`} />
        <MetricCard label="Avg Win" value={formatPnl(m.avgWin)} className="text-emerald-400" />
        <MetricCard label="Avg Loss" value={formatPnl(m.avgLoss)} className="text-red-400" />
        <MetricCard label="Avg R:R" value={m.avgRR.toFixed(2)} />
        <MetricCard label="Expectancy" value={formatPnl(m.expectancy)} className={pnlColor(m.expectancy)} />
      </div>

      {/* ── Win/Loss bar ──────────────────────────────────────── */}
      {m.totalTrades > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
          <div className="flex gap-1 h-4 rounded overflow-hidden">
            <div
              className="bg-emerald-500 rounded-l"
              style={{ width: `${(tradesByOutcome.wins / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.wins} wins`}
            />
            <div
              className="bg-[var(--text-muted)]"
              style={{ width: `${(tradesByOutcome.breakeven / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.breakeven} breakeven`}
            />
            <div
              className="bg-red-500 rounded-r"
              style={{ width: `${(tradesByOutcome.losses / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.losses} losses`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-[var(--text-tertiary)] mt-1">
            <span>{tradesByOutcome.wins}W</span>
            <span>{tradesByOutcome.breakeven}BE</span>
            <span>{tradesByOutcome.losses}L</span>
          </div>
        </div>
      )}

      {/* ── Equity curve ──────────────────────────────────────── */}
      <EquityCurveChart curve={run.equityCurve} />

      {/* ── Trades table ──────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-[var(--text-secondary)]">Trades ({run.trades.length})</h4>
          {run.trades.length > 50 && (
            <button
              onClick={() => setShowAllTrades(!showAllTrades)}
              className="text-xs text-amber-400 hover:text-amber-300"
            >
              {showAllTrades ? 'Show less' : `Show all ${run.trades.length}`}
            </button>
          )}
        </div>
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900 border-b border-[var(--border-default)]">
              <tr className="text-left text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">
                <th className="px-2 py-1.5">Entry</th>
                <th className="px-2 py-1.5">Coin</th>
                <th className="px-2 py-1.5">Side</th>
                <th className="px-2 py-1.5">Pattern</th>
                <th className="px-2 py-1.5 text-right">PnL</th>
                <th className="px-2 py-1.5 text-right">PnL%</th>
                <th className="px-2 py-1.5">Exit</th>
                <th className="px-2 py-1.5 text-right">Bars</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {visibleTrades.map((t, i) => (
                <tr key={i} className="hover:bg-[var(--bg-surface-hover)]">
                  <td className="px-2 py-1 font-mono text-[var(--text-secondary)] whitespace-nowrap">{formatTs(t.entryTime)}</td>
                  <td className="px-2 py-1 font-mono text-[var(--text-primary)]">{t.coin}</td>
                  <td className={`px-2 py-1 font-semibold ${t.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.side.toUpperCase()}
                  </td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">
                    {t.patternType}
                    {t.confluenceGrade && <span className="ml-1 text-[var(--text-muted)]">[{t.confluenceGrade}]</span>}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${pnlColor(t.pnl)}`}>
                    {formatPnl(t.pnl)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${pnlColor(t.pnlPct)}`}>
                    {(t.pnlPct * 100).toFixed(1)}%
                  </td>
                  <td className="px-2 py-1 text-[var(--text-tertiary)]">{t.exitReason}</td>
                  <td className="px-2 py-1 text-right text-[var(--text-tertiary)]">{t.holdingBars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Comparison Components ─────────────────────────────────────────────────

/** Color-code delta: green = better, red = worse. Inverted for maxDrawdown. */
function deltaColor(key: string, value: number): string {
  if (value === 0) return 'text-[var(--text-tertiary)]'
  // For maxDrawdown, lower (more negative delta) is better
  const inverted = key === 'maxDrawdown'
  const positive = inverted ? value < 0 : value > 0
  return positive ? 'text-emerald-400' : 'text-red-400'
}

function formatDelta(value: number, isPct = false): string {
  const prefix = value > 0 ? '+' : ''
  if (isPct) return `${prefix}${(value * 100).toFixed(1)}pp`
  return `${prefix}${value.toFixed(2)}`
}

function ComparisonMetricRow({ label, valA, valB, delta, format, deltaKey }: {
  label: string
  valA: string
  valB: string
  delta: number
  format?: 'pct' | 'pnl' | 'number'
  deltaKey: string
}) {
  const isPct = format === 'pct'
  return (
    <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
      <td className="px-3 py-2 text-xs text-[var(--text-secondary)]">{label}</td>
      <td className="px-3 py-2 text-xs font-mono text-zinc-200 text-right">{valA}</td>
      <td className="px-3 py-2 text-xs font-mono text-zinc-200 text-right">{valB}</td>
      <td className={`px-3 py-2 text-xs font-mono text-right ${deltaColor(deltaKey, delta)}`}>
        {formatDelta(delta, isPct)}
      </td>
    </tr>
  )
}

function OverlaidEquityCurve({ curveA, curveB, nameA, nameB }: {
  curveA: EquityPoint[]
  curveB: EquityPoint[]
  nameA: string
  nameB: string
}) {
  if (curveA.length < 2 && curveB.length < 2) return null

  const allEquities = [...curveA.map(p => p.equity), ...curveB.map(p => p.equity)]
  const minE = Math.min(...allEquities)
  const maxE = Math.max(...allEquities)
  const range = maxE - minE || 1
  const w = 800
  const h = 200

  const toPoints = (curve: EquityPoint[]) =>
    curve.map((p, i) => {
      const x = (i / (Math.max(curve.length - 1, 1))) * w
      const y = h - ((p.equity - minE) / range) * h
      return `${x},${y}`
    }).join(' ')

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
      <h4 className="text-xs text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Equity Curves (Overlaid)</h4>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48">
        {curveA.length >= 2 && (
          <polyline points={toPoints(curveA)} fill="none" stroke="#60a5fa" strokeWidth="2" opacity="0.8" />
        )}
        {curveB.length >= 2 && (
          <polyline points={toPoints(curveB)} fill="none" stroke="#f59e0b" strokeWidth="2" opacity="0.8" />
        )}
      </svg>
      <div className="flex gap-4 mt-2 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-400 rounded" />
          <span className="text-[var(--text-secondary)]">A: {nameA}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber-500 rounded" />
          <span className="text-[var(--text-secondary)]">B: {nameB}</span>
        </span>
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
        <span>${minE.toFixed(0)}</span>
        <span>${maxE.toFixed(0)}</span>
      </div>
    </div>
  )
}

function ComparisonView({ comparison, equityA, equityB }: {
  comparison: ComparisonResult
  equityA: EquityPoint[]
  equityB: EquityPoint[]
}) {
  const { metricsA: a, metricsB: b, delta: d, runA, runB } = comparison
  const nameA = runA.name ?? runA.id.slice(0, 8)
  const nameB = runB.name ?? runB.id.slice(0, 8)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-blue-400 font-semibold">A: {nameA}</span>
        <span className="text-[var(--text-muted)]">vs</span>
        <span className="text-amber-400 font-semibold">B: {nameB}</span>
        <span className="text-[10px] text-[var(--text-muted)] ml-auto">Delta = B - A</span>
      </div>

      {/* Side-by-side metrics table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-zinc-700">
            <tr className="text-left text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">
              <th className="px-3 py-2">Metric</th>
              <th className="px-3 py-2 text-right text-blue-400">Run A</th>
              <th className="px-3 py-2 text-right text-amber-400">Run B</th>
              <th className="px-3 py-2 text-right">Delta</th>
            </tr>
          </thead>
          <tbody>
            <ComparisonMetricRow label="Total Trades" valA={String(a.totalTrades)} valB={String(b.totalTrades)} delta={d.totalTrades} deltaKey="totalTrades" />
            <ComparisonMetricRow label="Win Rate" valA={formatPct(a.winRate)} valB={formatPct(b.winRate)} delta={d.winRate} format="pct" deltaKey="winRate" />
            <ComparisonMetricRow label="Net PnL" valA={formatPnl(a.netPnl)} valB={formatPnl(b.netPnl)} delta={d.netPnl} deltaKey="netPnl" />
            <ComparisonMetricRow label="Profit Factor" valA={a.profitFactor.toFixed(2)} valB={b.profitFactor.toFixed(2)} delta={d.profitFactor} deltaKey="profitFactor" />
            <ComparisonMetricRow label="Sharpe" valA={a.sharpeRatio.toFixed(2)} valB={b.sharpeRatio.toFixed(2)} delta={d.sharpeRatio} deltaKey="sharpeRatio" />
            <ComparisonMetricRow label="Sortino" valA={a.sortinoRatio.toFixed(2)} valB={b.sortinoRatio.toFixed(2)} delta={d.sortinoRatio} deltaKey="sortinoRatio" />
            <ComparisonMetricRow label="Calmar" valA={a.calmarRatio.toFixed(2)} valB={b.calmarRatio.toFixed(2)} delta={d.calmarRatio} deltaKey="calmarRatio" />
            <ComparisonMetricRow label="Max Drawdown" valA={formatPct(a.maxDrawdown)} valB={formatPct(b.maxDrawdown)} delta={d.maxDrawdown} format="pct" deltaKey="maxDrawdown" />
            <ComparisonMetricRow label="Avg R:R" valA={a.avgRR.toFixed(2)} valB={b.avgRR.toFixed(2)} delta={d.avgRR} deltaKey="avgRR" />
            <ComparisonMetricRow label="Expectancy" valA={formatPnl(a.expectancy)} valB={formatPnl(b.expectancy)} delta={d.expectancy} deltaKey="expectancy" />
            <ComparisonMetricRow label="Avg Win" valA={formatPnl(a.avgWin)} valB={formatPnl(b.avgWin)} delta={b.avgWin - a.avgWin} deltaKey="avgWin" />
            <ComparisonMetricRow label="Avg Loss" valA={formatPnl(a.avgLoss)} valB={formatPnl(b.avgLoss)} delta={b.avgLoss - a.avgLoss} deltaKey="avgLoss" />
          </tbody>
        </table>
      </div>

      {/* Overlaid equity curves */}
      <OverlaidEquityCurve curveA={equityA} curveB={equityB} nameA={nameA} nameB={nameB} />
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function BacktestPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  const { runs, loading, error } = useBacktestRuns(refreshKey)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState(false)
  const [compareIds, setCompareIds] = useState<[string | null, string | null]>([null, null])
  const { run: detail, loading: detailLoading, error: detailError } = useBacktestDetail(
    compareMode ? null : selectedId,
  )
  const {
    comparison, equityA, equityB,
    loading: compLoading, error: compError,
  } = useBacktestComparison(compareIds[0], compareIds[1])

  const handleBacktestComplete = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])

  const { run: startRun, running, progress, error: runError } = useBacktestRunner(handleBacktestComplete)

  const toggleCompareMode = useCallback(() => {
    setCompareMode(prev => {
      if (!prev) { setSelectedId(null) }
      else { setCompareIds([null, null]) }
      return !prev
    })
  }, [])

  const handleRunClick = useCallback((id: string) => {
    if (compareMode) {
      setCompareIds(prev => {
        // Toggle: if already selected, deselect
        if (prev[0] === id) return [prev[1], null]
        if (prev[1] === id) return [prev[0], null]
        // Fill first empty slot, or replace second
        if (!prev[0]) return [id, prev[1]]
        if (!prev[1]) return [prev[0], id]
        return [prev[0], id]
      })
    } else {
      setSelectedId(id === selectedId ? null : id)
    }
  }, [compareMode, selectedId])

  const isSelected = useCallback((id: string) => {
    if (compareMode) return compareIds[0] === id || compareIds[1] === id
    return id === selectedId
  }, [compareMode, compareIds, selectedId])

  const getRunLabel = useCallback((id: string) => {
    if (!compareMode) return null
    if (compareIds[0] === id) return 'A'
    if (compareIds[1] === id) return 'B'
    return null
  }, [compareMode, compareIds])

  if (loading) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 text-[var(--text-tertiary)]">
        Loading backtest runs...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-red-400">
        Error: {error}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Backtest Results</h2>
        <div className="flex items-center gap-3">
          {runs.length >= 2 && (
            <button
              onClick={toggleCompareMode}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                compareMode
                  ? 'bg-blue-900/50 border-blue-700 text-blue-300'
                  : 'bg-zinc-800 border-zinc-700 text-[var(--text-secondary)] hover:text-zinc-200'
              }`}
            >
              {compareMode ? 'Exit Compare' : 'Compare'}
            </button>
          )}
          <span className="text-xs text-[var(--text-muted)]">{runs.length} runs</span>
        </div>
      </div>

      {/* Config editor */}
      <ConfigEditor onRun={startRun} running={running} progress={progress} error={runError} />

      {compareMode && (
        <div className="rounded border border-blue-900/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-300">
          Select 2 runs to compare. {compareIds[0] && !compareIds[1] ? '1 selected — pick another.' : ''}
        </div>
      )}

      {runs.length === 0 ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 text-center text-[var(--text-tertiary)]">
          <p className="text-lg mb-2">No backtest runs</p>
          <p className="text-sm">Run a backtest via CLI to see results here</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* ── Run list ─────────────────────────────────────────── */}
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-auto max-h-[80vh]">
            {runs.map((r) => {
              const label = getRunLabel(r.id)
              return (
                <button
                  key={r.id}
                  onClick={() => handleRunClick(r.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)] last:border-b-0 transition-colors ${
                    isSelected(r.id) ? 'bg-zinc-800' : 'hover:bg-[var(--bg-surface-hover)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-200 truncate flex items-center gap-1.5">
                      {label && (
                        <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold ${
                          label === 'A' ? 'bg-blue-900 text-blue-300' : 'bg-amber-900 text-amber-300'
                        }`}>{label}</span>
                      )}
                      {r.name ?? r.id.slice(0, 8)}
                    </span>
                    <span className={`text-sm font-mono ${pnlColor(r.netPnl)}`}>
                      {formatPnl(r.netPnl)}
                    </span>
                  </div>
                  <div className="flex gap-3 mt-1 text-[10px] text-[var(--text-tertiary)]">
                    <span>{r.totalTrades} trades</span>
                    <span>WR: {formatPct(r.winRate)}</span>
                    <span>Sharpe: {r.sharpeRatio.toFixed(2)}</span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    {formatDate(r.createdAt)}
                  </div>
                </button>
              )
            })}
          </div>

          {/* ── Detail / Comparison panel ─────────────────────────── */}
          <div>
            {/* Detail mode */}
            {!compareMode && !selectedId && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 text-center text-[var(--text-tertiary)]">
                Select a run to view details
              </div>
            )}

            {!compareMode && selectedId && detailLoading && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 text-[var(--text-tertiary)]">
                Loading run details...
              </div>
            )}

            {!compareMode && selectedId && detailError && (
              <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-red-400">
                Error: {detailError}
              </div>
            )}

            {!compareMode && detail && <RunDetail run={detail} />}

            {/* Compare mode */}
            {compareMode && (!compareIds[0] || !compareIds[1]) && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 text-center text-[var(--text-tertiary)]">
                Select 2 runs from the list to compare
              </div>
            )}

            {compareMode && compareIds[0] && compareIds[1] && compLoading && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 text-[var(--text-tertiary)]">
                Loading comparison...
              </div>
            )}

            {compareMode && compError && (
              <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-red-400">
                Error: {compError}
              </div>
            )}

            {compareMode && comparison && (
              <ComparisonView comparison={comparison} equityA={equityA} equityB={equityB} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
