import { useSSEStore } from '../stores/sse-store'

export function OverviewPage() {
  const status = useSSEStore((s) => s.status)
  const signals = useSSEStore((s) => s.signals)
  const trades = useSSEStore((s) => s.trades)

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Overview</h2>

      {/* Connection status */}
      {!status ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-500">
          Waiting for data...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Health */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Health</div>
            <div className="text-2xl font-bold">
              <span className={status.health.overall === 'healthy' ? 'text-emerald-400' : 'text-amber-400'}>
                {status.health.overall}
              </span>
            </div>
            <div className="text-xs text-zinc-600 mt-1">
              RSS: {(status.health.rssBytes / 1024 / 1024).toFixed(0)} MB
            </div>
          </div>

          {/* Positions */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Positions</div>
            <div className="text-2xl font-bold">{status.positions.length}</div>
            <div className="text-xs text-zinc-600 mt-1">
              {status.positions.length > 0
                ? status.positions.map(p => `${p.coin} ${p.side}`).join(', ')
                : 'No open positions'
              }
            </div>
          </div>

          {/* Recent activity */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Activity</div>
            <div className="text-2xl font-bold">{signals.length + trades.length}</div>
            <div className="text-xs text-zinc-600 mt-1">
              {signals.length} signals, {trades.length} trades
            </div>
          </div>
        </div>
      )}

      {/* Recent signals feed */}
      {signals.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-zinc-400 mb-2">Recent Signals</h3>
          <div className="space-y-1 max-h-64 overflow-auto">
            {signals.slice(-10).reverse().map((s, i) => (
              <div key={i} className="text-xs font-mono bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-zinc-400">
                <span className={s.type === 'setup' ? 'text-emerald-400' : 'text-red-400'}>
                  {s.type}
                </span>
                {' '}
                {JSON.stringify(s.data).slice(0, 120)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
