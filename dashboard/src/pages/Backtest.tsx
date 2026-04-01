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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-zinc-300">Run Backtest</h3>

      {/* Coins */}
      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Coins</label>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {AVAILABLE_COINS.map(c => (
            <button
              key={c}
              onClick={() => toggleItem(coins, c, setCoins)}
              disabled={running}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                coins.includes(c)
                  ? 'bg-amber-900/50 border-amber-700 text-amber-300'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300'
              } disabled:opacity-50`}
            >{c}</button>
          ))}
        </div>
      </div>

      {/* Timeframes */}
      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Timeframes</label>
        <div className="flex gap-1.5 mt-1">
          {AVAILABLE_TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => toggleItem(timeframes, tf, setTimeframes)}
              disabled={running}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                timeframes.includes(tf)
                  ? 'bg-amber-900/50 border-amber-700 text-amber-300'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300'
              } disabled:opacity-50`}
            >{tf}</button>
          ))}
        </div>
      </div>

      {/* Params row */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Months</label>
          <input
            type="number" min={1} max={6} value={months}
            onChange={e => setMonths(Math.min(6, Math.max(1, +e.target.value)))}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Capital ($)</label>
          <input
            type="number" min={100} step={1000} value={capital}
            onChange={e => setCapital(Math.max(100, +e.target.value))}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Run Name</label>
          <input
            type="text" value={name} placeholder="optional"
            onChange={e => setName(e.target.value)}
            disabled={running}
            className="w-full mt-1 px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder:text-zinc-600 disabled:opacity-50"
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
            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-amber-500 transition-all duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-zinc-500">
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
  return 'text-zinc-400'
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold font-mono ${className ?? 'text-zinc-100'}`}>{value}</div>
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h4 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Equity Curve</h4>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48">
        <polyline
          points={points}
          fill="none"
          stroke={isProfit ? '#34d399' : '#f87171'}
          strokeWidth="2"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
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
        <MetricCard label="Sharpe" value={m.sharpeRatio.toFixed(2)} className={m.sharpeRatio >= 1 ? 'text-emerald-400' : 'text-zinc-300'} />
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
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <div className="flex gap-1 h-4 rounded overflow-hidden">
            <div
              className="bg-emerald-500 rounded-l"
              style={{ width: `${(tradesByOutcome.wins / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.wins} wins`}
            />
            <div
              className="bg-zinc-600"
              style={{ width: `${(tradesByOutcome.breakeven / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.breakeven} breakeven`}
            />
            <div
              className="bg-red-500 rounded-r"
              style={{ width: `${(tradesByOutcome.losses / m.totalTrades) * 100}%` }}
              title={`${tradesByOutcome.losses} losses`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
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
          <h4 className="text-sm font-semibold text-zinc-400">Trades ({run.trades.length})</h4>
          {run.trades.length > 50 && (
            <button
              onClick={() => setShowAllTrades(!showAllTrades)}
              className="text-xs text-amber-400 hover:text-amber-300"
            >
              {showAllTrades ? 'Show less' : `Show all ${run.trades.length}`}
            </button>
          )}
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
              <tr className="text-left text-[10px] text-zinc-500 uppercase tracking-wider">
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
                <tr key={i} className="hover:bg-zinc-800/30">
                  <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{formatTs(t.entryTime)}</td>
                  <td className="px-2 py-1 font-mono text-zinc-300">{t.coin}</td>
                  <td className={`px-2 py-1 font-semibold ${t.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.side.toUpperCase()}
                  </td>
                  <td className="px-2 py-1 text-zinc-400">
                    {t.patternType}
                    {t.confluenceGrade && <span className="ml-1 text-zinc-600">[{t.confluenceGrade}]</span>}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${pnlColor(t.pnl)}`}>
                    {formatPnl(t.pnl)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${pnlColor(t.pnlPct)}`}>
                    {(t.pnlPct * 100).toFixed(1)}%
                  </td>
                  <td className="px-2 py-1 text-zinc-500">{t.exitReason}</td>
                  <td className="px-2 py-1 text-right text-zinc-500">{t.holdingBars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function BacktestPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  const { runs, loading, error } = useBacktestRuns(refreshKey)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { run: detail, loading: detailLoading, error: detailError } = useBacktestDetail(selectedId)

  const handleBacktestComplete = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])

  const { run: startRun, running, progress, error: runError } = useBacktestRunner(handleBacktestComplete)

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-500">
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
        <span className="text-xs text-zinc-600">{runs.length} runs</span>
      </div>

      {/* Config editor */}
      <ConfigEditor onRun={startRun} running={running} progress={progress} error={runError} />

      {runs.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-500">
          <p className="text-lg mb-2">No backtest runs</p>
          <p className="text-sm">Run a backtest via CLI to see results here</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* ── Run list ─────────────────────────────────────────── */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-auto max-h-[80vh]">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/50 last:border-b-0 transition-colors ${
                  r.id === selectedId ? 'bg-zinc-800' : 'hover:bg-zinc-800/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-200 truncate">
                    {r.name ?? r.id.slice(0, 8)}
                  </span>
                  <span className={`text-sm font-mono ${pnlColor(r.netPnl)}`}>
                    {formatPnl(r.netPnl)}
                  </span>
                </div>
                <div className="flex gap-3 mt-1 text-[10px] text-zinc-500">
                  <span>{r.totalTrades} trades</span>
                  <span>WR: {formatPct(r.winRate)}</span>
                  <span>Sharpe: {r.sharpeRatio.toFixed(2)}</span>
                </div>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {formatDate(r.createdAt)}
                </div>
              </button>
            ))}
          </div>

          {/* ── Detail panel ──────────────────────────────────────── */}
          <div>
            {!selectedId && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-500">
                Select a run to view details
              </div>
            )}

            {selectedId && detailLoading && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-500">
                Loading run details...
              </div>
            )}

            {selectedId && detailError && (
              <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-red-400">
                Error: {detailError}
              </div>
            )}

            {detail && <RunDetail run={detail} />}
          </div>
        </div>
      )}
    </div>
  )
}
