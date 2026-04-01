/**
 * Backtest page — list runs + detail view with metrics, equity curve, trades.
 *
 * Data sources:
 *   - REST /api/backtest/runs → list all saved runs
 *   - REST /api/backtest/runs/:id → full run detail (metrics + trades + equity)
 *
 * No "run backtest" button in MVP — use CLI instead.
 */

import { useEffect, useState, useMemo } from 'react'

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

function useBacktestRuns() {
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
  }, [])

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
  const { runs, loading, error } = useBacktestRuns()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { run: detail, loading: detailLoading, error: detailError } = useBacktestDetail(selectedId)

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
