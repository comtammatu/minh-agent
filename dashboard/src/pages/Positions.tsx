import { useSSEStore } from '../stores/sse-store'

export function PositionsPage() {
  const status = useSSEStore((s) => s.status)
  const positions = status?.positions ?? []

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Positions</h2>

      {positions.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-500">
          No open positions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase">
                <th className="text-left py-2 px-3">Coin</th>
                <th className="text-left py-2 px-3">Side</th>
                <th className="text-right py-2 px-3">Size</th>
                <th className="text-right py-2 px-3">Entry</th>
                <th className="text-right py-2 px-3">uPnL</th>
                <th className="text-center py-2 px-3">Trail</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                  <td className="py-2 px-3 font-mono">{p.coin}</td>
                  <td className="py-2 px-3">
                    <span className={p.side === 'long' ? 'text-emerald-400' : 'text-red-400'}>
                      {p.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right font-mono">{p.size}</td>
                  <td className="py-2 px-3 text-right font-mono">${p.entryPrice.toFixed(2)}</td>
                  <td className={`py-2 px-3 text-right font-mono ${p.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${p.unrealizedPnl.toFixed(2)}
                  </td>
                  <td className="py-2 px-3 text-center">
                    {p.trailingActive ? (
                      <span className="text-amber-400 text-xs">ACTIVE</span>
                    ) : (
                      <span className="text-zinc-600 text-xs">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
