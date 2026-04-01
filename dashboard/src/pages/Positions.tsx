/**
 * Positions page — open positions with full details.
 *
 * Data: SSE status.positions (updated every 5s)
 * Shows: coin, side, size, entry, SL, TP, uPnL, PnL %, hold time, trailing, partials.
 */

import { useSSEStore, type Position } from '../stores/sse-store'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPnl(value: number): string {
  if (value >= 0) return `+$${value.toFixed(2)}`
  return `-$${Math.abs(value).toFixed(2)}`
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-emerald-400'
  if (value < 0) return 'text-red-400'
  return 'text-zinc-400'
}

function formatHoldTime(openedAt: number): string {
  const elapsed = Date.now() - openedAt
  const h = Math.floor(elapsed / 3_600_000)
  const m = Math.floor((elapsed % 3_600_000) / 60_000)
  if (h > 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function pnlPercent(p: Position): number {
  if (p.entryPrice === 0 || p.size === 0) return 0
  const notional = p.size * p.entryPrice
  return notional !== 0 ? p.unrealizedPnl / notional : 0
}

function riskRewardRatio(p: Position): string {
  const risk = Math.abs(p.entryPrice - p.slPrice)
  const reward = Math.abs(p.tpPrice - p.entryPrice)
  if (risk === 0) return '-'
  return `1:${(reward / risk).toFixed(1)}`
}

// ─── Summary Bar ────────────────────────────────────────────────────────────

function PositionsSummary({ positions }: { positions: Position[] }) {
  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0)
  const totalExposure = positions.reduce((s, p) => s + p.size * p.entryPrice, 0)
  const longCount = positions.filter(p => p.side === 'long').length
  const shortCount = positions.filter(p => p.side === 'short').length
  const trailingCount = positions.filter(p => p.trailingActive).length

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Total uPnL</div>
        <div className={`text-lg font-bold font-mono ${pnlColor(totalPnl)}`}>
          {formatPnl(totalPnl)}
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Exposure</div>
        <div className="text-lg font-bold font-mono text-[var(--text-primary)]">
          ${totalExposure.toFixed(0)}
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Bias</div>
        <div className="text-lg font-bold">
          <span className="text-emerald-400">{longCount}L</span>
          {' / '}
          <span className="text-red-400">{shortCount}S</span>
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Trailing</div>
        <div className="text-lg font-bold text-amber-400">{trailingCount}/{positions.length}</div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
        <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Positions</div>
        <div className="text-lg font-bold text-[var(--text-primary)]">{positions.length}</div>
      </div>
    </div>
  )
}

// ─── Position Row ───────────────────────────────────────────────────────────

function PositionRow({ p }: { p: Position }) {
  const pctPnl = pnlPercent(p)
  const rr = riskRewardRatio(p)
  const holdTime = p.openedAt ? formatHoldTime(p.openedAt) : '-'

  return (
    <tr className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-surface-hover)] transition-colors">
      <td className="py-2.5 px-3">
        <span className="font-mono text-sm text-[var(--text-primary)]">{p.coin}</span>
      </td>
      <td className="py-2.5 px-3">
        <span className={`text-xs font-bold ${p.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`}>
          {p.side.toUpperCase()}
        </span>
      </td>
      <td className="py-2.5 px-3 text-right font-mono text-sm text-[var(--text-primary)]">
        {p.size.toFixed(4)}
        {p.size < p.originalSize && (
          <span className="text-zinc-600 text-[10px] ml-1">
            ({p.partialClosesFired}x partial)
          </span>
        )}
      </td>
      <td className="py-2.5 px-3 text-right font-mono text-sm text-[var(--text-primary)]">
        ${p.entryPrice.toFixed(2)}
      </td>
      <td className="py-2.5 px-3 text-right font-mono text-sm text-red-400/80">
        ${p.slPrice.toFixed(2)}
      </td>
      <td className="py-2.5 px-3 text-right font-mono text-sm text-emerald-400/80">
        ${p.tpPrice.toFixed(2)}
      </td>
      <td className={`py-2.5 px-3 text-right font-mono text-sm ${pnlColor(p.unrealizedPnl)}`}>
        {formatPnl(p.unrealizedPnl)}
      </td>
      <td className={`py-2.5 px-3 text-right font-mono text-sm ${pnlColor(pctPnl)}`}>
        {(pctPnl * 100).toFixed(2)}%
      </td>
      <td className="py-2.5 px-3 text-right text-xs text-[var(--text-tertiary)]">
        {rr}
      </td>
      <td className="py-2.5 px-3 text-right text-xs text-[var(--text-tertiary)]">
        {holdTime}
      </td>
      <td className="py-2.5 px-3 text-center">
        {p.trailingActive ? (
          <span className="text-amber-400 text-xs font-semibold">ACTIVE</span>
        ) : (
          <span className="text-zinc-700 text-xs">-</span>
        )}
      </td>
    </tr>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function PositionsPage() {
  const status = useSSEStore((s) => s.status)
  const positions = status?.positions ?? []

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Positions</h2>

      {positions.length === 0 ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 text-[var(--text-tertiary)]">
          No open positions
        </div>
      ) : (
        <>
          <PositionsSummary positions={positions} />

          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900 border-b border-zinc-800 text-zinc-500 text-[10px] uppercase tracking-wider">
                  <th className="text-left py-2 px-3">Coin</th>
                  <th className="text-left py-2 px-3">Side</th>
                  <th className="text-right py-2 px-3">Size</th>
                  <th className="text-right py-2 px-3">Entry</th>
                  <th className="text-right py-2 px-3">SL</th>
                  <th className="text-right py-2 px-3">TP</th>
                  <th className="text-right py-2 px-3">uPnL</th>
                  <th className="text-right py-2 px-3">PnL %</th>
                  <th className="text-right py-2 px-3">R:R</th>
                  <th className="text-right py-2 px-3">Hold</th>
                  <th className="text-center py-2 px-3">Trail</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <PositionRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
