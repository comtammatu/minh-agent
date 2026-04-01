/**
 * Overview page — agent state at a glance.
 *
 * Data sources:
 *   - SSE /api/stream/status → agent snapshot, positions, health (every 5s)
 *   - REST /api/metrics → LiveMetrics (polled every 30s)
 *   - SSE /api/stream/signals → recent signals ring buffer
 *   - SSE /api/stream/trades → recent trades ring buffer
 */

import { useSSEStore, type CoinState } from '../stores/sse-store'
import { useMetrics } from '../hooks/useMetrics'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPnl(value: number): string {
  if (value >= 0) return `+$${value.toFixed(2)}`
  return `-$${Math.abs(value).toFixed(2)}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-emerald-400'
  if (value < 0) return 'text-red-400'
  return 'text-zinc-400'
}

const STATE_COLORS: Record<string, string> = {
  IDLE: 'bg-zinc-700',
  WATCHING: 'bg-amber-600',
  ENTERING: 'bg-blue-600',
  IN_POSITION: 'bg-emerald-600',
  EXITING: 'bg-orange-600',
  PAUSED: 'bg-red-600',
}

function stateBadge(state: string) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider text-white ${STATE_COLORS[state] ?? 'bg-zinc-600'}`}>
      {state}
    </span>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, className }: {
  label: string
  value: string | number
  sub?: string
  className?: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono ${className ?? 'text-zinc-100'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-zinc-600 mt-1">{sub}</div>}
    </div>
  )
}

function CoinStateRow({ coin, state }: { coin: string; state: CoinState }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/50 last:border-b-0">
      <span className="font-mono text-sm text-zinc-300">{coin}</span>
      <div className="flex items-center gap-2">
        {stateBadge(state.state)}
        {state.consecutiveLosses > 0 && (
          <span className="text-[10px] text-red-400">{state.consecutiveLosses}L</span>
        )}
      </div>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function OverviewPage() {
  const status = useSSEStore((s) => s.status)
  const signals = useSSEStore((s) => s.signals)
  const trades = useSSEStore((s) => s.trades)
  const { metrics, loading: metricsLoading } = useMetrics()

  if (!status) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-500">
        Waiting for agent data...
      </div>
    )
  }

  const { agent, positions, health } = status
  const coinEntries = Object.entries(agent.coins)
  const inPositionCount = coinEntries.filter(([, s]) => s.state === 'IN_POSITION').length
  const watchingCount = coinEntries.filter(([, s]) => s.state === 'WATCHING').length
  const pausedCount = coinEntries.filter(([, s]) => s.state === 'PAUSED').length

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Overview</h2>

      {/* ── Top stat cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Health"
          value={health.overall}
          sub={`RSS: ${(health.rssBytes / 1024 / 1024).toFixed(0)} MB`}
          className={health.overall === 'healthy' || health.overall === 'ok' ? 'text-emerald-400' : 'text-amber-400'}
        />
        <StatCard
          label="Daily PnL"
          value={formatPnl(agent.global.dailyPnl)}
          sub={metrics ? `W: ${formatPnl(metrics.pnl.weekly)} | M: ${formatPnl(metrics.pnl.monthly)}` : undefined}
          className={pnlColor(agent.global.dailyPnl)}
        />
        <StatCard
          label="Win Rate"
          value={metricsLoading ? '...' : metrics ? formatPercent(metrics.winRate.allTime) : 'N/A'}
          sub={metrics ? `D: ${formatPercent(metrics.winRate.daily)} | W: ${formatPercent(metrics.winRate.weekly)}` : undefined}
        />
        <StatCard
          label="Positions"
          value={positions.length}
          sub={`${watchingCount} watching, ${pausedCount} paused`}
        />
      </div>

      {/* ── Global status bar ───────────────────────────────────────── */}
      {agent.global.globalPaused && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-red-400 text-sm">
          Agent PAUSED: {agent.global.globalPauseReason ?? 'unknown reason'}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Coin States ─────────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-400 mb-2">
            Coin States ({coinEntries.length})
          </h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 max-h-72 overflow-auto">
            {coinEntries.length === 0 ? (
              <div className="p-4 text-zinc-600 text-sm">No coins tracked</div>
            ) : (
              coinEntries.map(([coin, state]) => (
                <CoinStateRow key={coin} coin={coin} state={state} />
              ))
            )}
          </div>
          <div className="mt-2 flex gap-3 text-[10px] text-zinc-600">
            <span>Uptime: {formatUptime(agent.global.uptime)}</span>
            <span>Losses: {agent.global.totalConsecutiveLosses}</span>
          </div>
        </div>

        {/* ── Open Positions Summary ──────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-400 mb-2">
            Open Positions ({positions.length})
          </h3>
          {positions.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-600 text-sm">
              No open positions
            </div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800/50">
              {positions.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-zinc-300">{p.coin}</span>
                    <span className={`text-xs font-semibold ${p.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.side.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-mono text-sm ${pnlColor(p.unrealizedPnl)}`}>
                      {formatPnl(p.unrealizedPnl)}
                    </span>
                    {p.trailingActive && (
                      <span className="text-[10px] text-amber-400 font-semibold">TRAIL</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Metrics extras */}
          {metrics && (
            <div className="mt-2 flex gap-3 text-[10px] text-zinc-600">
              <span>Drawdown: {formatPercent(metrics.currentDrawdown)}</span>
              <span>Max DD: {formatPercent(metrics.maxDrawdown)}</span>
              <span>Trades (all): {metrics.trades.allTime}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent Signals ──────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-400 mb-2">
          Recent Signals ({signals.length})
        </h3>
        {signals.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-600 text-sm">
            No signals yet
          </div>
        ) : (
          <div className="space-y-1 max-h-48 overflow-auto">
            {signals.slice(-15).reverse().map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5">
                <span className="text-zinc-600 w-16 shrink-0">
                  {new Date(s.ts).toLocaleTimeString()}
                </span>
                <span className={`w-20 shrink-0 font-semibold ${s.type === 'setup' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {s.type}
                </span>
                <span className="text-zinc-400 truncate">
                  {formatSignalData(s)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recent Trades ───────────────────────────────────────────── */}
      {trades.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-400 mb-2">
            Recent Trades ({trades.length})
          </h3>
          <div className="space-y-1 max-h-32 overflow-auto">
            {trades.slice(-10).reverse().map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5">
                <span className="text-zinc-600 w-16 shrink-0">
                  {new Date(t.ts).toLocaleTimeString()}
                </span>
                <span className="text-blue-400 w-16 shrink-0">{t.type}</span>
                <span className="text-zinc-400 truncate">
                  {JSON.stringify(t.data).slice(0, 100)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatSignalData(s: { type: string; data: Record<string, unknown> }): string {
  const d = s.data
  if (s.type === 'setup') {
    const coin = d.coin ?? d.symbol ?? ''
    const tf = d.timeframe ?? d.tf ?? ''
    const grade = d.confluenceGrade ?? d.grade ?? ''
    const pattern = d.patternType ?? d.pattern ?? ''
    const side = d.side ?? ''
    return `${coin} ${tf} ${side} ${pattern} [${grade}]`
  }
  if (s.type === 'invalidation') {
    return `${d.id ?? ''} — ${d.reason ?? ''}`
  }
  return JSON.stringify(d).slice(0, 100)
}
