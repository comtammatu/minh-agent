/**
 * Global strategy selector — fetches registered strategies from /api/strategies
 * and stores selection in a shared Zustand store so all pages can filter.
 */

import { useEffect } from 'react'
import { create } from 'zustand'

// ─── Types ──────────────────────────────────────────────────────────────────

interface StrategyInfo {
  id: string
  name: string
  enabled: boolean
  patternTypes: string[]
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface StrategyStore {
  strategies: StrategyInfo[]
  selected: string  // '' = All
  setSelected: (id: string) => void
  setStrategies: (s: StrategyInfo[]) => void
}

export const useStrategyStore = create<StrategyStore>((set) => ({
  strategies: [],
  selected: '',
  setSelected: (id) => set({ selected: id }),
  setStrategies: (strategies) => set({ strategies }),
}))

// ─── Component ──────────────────────────────────────────────────────────────

export function StrategySelector() {
  const strategies = useStrategyStore((s) => s.strategies)
  const selected = useStrategyStore((s) => s.selected)
  const setSelected = useStrategyStore((s) => s.setSelected)
  const setStrategies = useStrategyStore((s) => s.setStrategies)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/strategies')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && Array.isArray(data.strategies)) {
          setStrategies(data.strategies)
        }
      } catch {
        // Silently fail — selector just won't populate
      }
    }
    load()
    return () => { cancelled = true }
  }, [setStrategies])

  // Don't render if only 1 strategy (no point filtering)
  if (strategies.length <= 1) return null

  return (
    <div className="px-4 py-2 border-b border-[var(--border-default)]">
      <label className="block text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider mb-1">
        Strategy
      </label>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded px-2 py-1 text-xs text-[var(--text-primary)]"
      >
        <option value="">All</option>
        {strategies.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}{s.enabled ? '' : ' (disabled)'}
          </option>
        ))}
      </select>
    </div>
  )
}
