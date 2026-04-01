/**
 * Config page — read-only grouped display of all agent configuration.
 *
 * Data source: REST /api/config → grouped config constants
 */

import { useEffect, useState } from 'react'

// ─── Types ──────────────────────────────────────────────────────────────────

type ConfigGroups = Record<string, Record<string, unknown>>

// ─── Hook ───────────────────────────────────────────────────────────────────

function useConfig() {
  const [groups, setGroups] = useState<ConfigGroups | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/config')
        if (!res.ok) {
          setError(`HTTP ${res.status}`)
          return
        }
        const data = await res.json()
        if (!cancelled) {
          setGroups(data.groups ?? {})
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
  }, [])

  return { groups, loading, error }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const GROUP_LABELS: Record<string, string> = {
  risk: 'Risk Management',
  circuit_breaker: 'Circuit Breakers',
  exit_strategy: 'Exit Strategy',
  pipeline: 'Pipeline / Scanner',
  feed: 'Feed / Data',
  orders: 'Order Lifecycle',
  order_flow: 'Order Flow',
  backtest: 'Backtest',
  server: 'Server / API / SSE',
  database: 'Database',
  websocket: 'WebSocket',
  retry: 'Retry / Self-Healing',
  health: 'Health Monitor',
  telegram: 'Telegram',
  general: 'General',
}

const GROUP_ORDER = [
  'risk', 'circuit_breaker', 'exit_strategy', 'pipeline', 'feed',
  'orders', 'order_flow', 'backtest', 'server', 'database',
  'websocket', 'retry', 'health', 'telegram', 'general',
]

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    // Format large numbers with commas
    if (value >= 10000) return value.toLocaleString()
    // Format small decimals
    if (value < 1 && value > 0) return value.toString()
    return value.toString()
  }
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function valueColor(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'text-emerald-400' : 'text-red-400'
  if (typeof value === 'number') return 'text-blue-400'
  if (typeof value === 'string') return 'text-amber-400'
  if (typeof value === 'object') return 'text-zinc-400'
  return 'text-zinc-300'
}

function isObjectValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ConfigGroup({ name, entries }: { name: string; entries: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(true)
  const keys = Object.keys(entries).sort()

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-zinc-800/30 transition-colors"
      >
        <h3 className="text-sm font-semibold text-zinc-200">
          {GROUP_LABELS[name] ?? name}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{keys.length} values</span>
          <span className="text-zinc-500 text-xs">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 divide-y divide-zinc-800/50">
          {keys.map((key) => {
            const val = entries[key]
            if (isObjectValue(val)) {
              // Render nested object as sub-table
              return (
                <div key={key} className="px-4 py-2">
                  <div className="text-xs font-mono text-zinc-300 mb-1">{key}</div>
                  <div className="pl-4 space-y-0.5">
                    {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
                      <div key={k} className="flex items-baseline gap-2">
                        <span className="text-xs font-mono text-zinc-500 w-48 shrink-0">{k}</span>
                        <span className={`text-xs font-mono ${valueColor(v)}`}>{formatValue(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            }
            return (
              <div key={key} className="flex items-baseline gap-2 px-4 py-2">
                <span className="text-xs font-mono text-zinc-400 w-64 shrink-0">{key}</span>
                <span className={`text-xs font-mono ${valueColor(val)}`}>{formatValue(val)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ConfigPage() {
  const { groups, loading, error } = useConfig()

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-500">
        Loading config...
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

  if (!groups) return null

  // Sort groups by predefined order
  const sortedGroups = GROUP_ORDER
    .filter((g) => groups[g])
    .map((g) => [g, groups[g]] as [string, Record<string, unknown>])

  // Add any remaining groups not in ORDER
  for (const [g, entries] of Object.entries(groups)) {
    if (!GROUP_ORDER.includes(g)) {
      sortedGroups.push([g, entries])
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Agent Configuration</h2>
        <span className="text-xs text-zinc-600">Read-only view of config.ts</span>
      </div>

      <div className="space-y-3">
        {sortedGroups.map(([name, entries]) => (
          <ConfigGroup key={name} name={name} entries={entries} />
        ))}
      </div>
    </div>
  )
}
