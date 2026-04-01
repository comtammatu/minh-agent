/**
 * Chart controls — coin + timeframe selector.
 * Navigates to /chart/:coin/:tf on change.
 */

import { useNavigate } from 'react-router-dom'

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

interface ChartControlsProps {
  coin: string
  tf: string
  coins: string[]
}

export function ChartControls({ coin, tf, coins }: ChartControlsProps) {
  const navigate = useNavigate()

  return (
    <div className="flex items-center gap-3">
      {/* Coin selector */}
      <select
        value={coin}
        onChange={(e) => navigate(`/chart/${e.target.value}/${tf}`)}
        className="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-amber-500 focus:outline-none"
      >
        {coins.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      {/* Timeframe buttons */}
      <div className="flex rounded border border-[var(--border-default)] overflow-hidden">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => navigate(`/chart/${coin}/${t}`)}
            className={`px-3 py-1.5 text-xs font-mono transition-colors ${
              t === tf
                ? 'bg-amber-600 text-white'
                : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}
