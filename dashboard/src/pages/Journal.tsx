/**
 * Trade Journal page — filterable table of journal entries.
 *
 * Data source: REST /api/agent/journal?limit=N&type=T
 * Filters: coin, event type, date range (client-side filter on fetched data)
 */

import { Fragment, useEffect, useState, useMemo, useCallback } from 'react'

// ─── Types ──────────────────────────────────────────────────────────────────

interface JournalEntry {
  id: number
  ts: string
  event_type: string
  coin: string | null
  details: Record<string, unknown>
  agent_state: string | null
}

// ─── Hook ───────────────────────────────────────────────────────────────────

function useJournal(limit: number) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/agent/journal?limit=${limit}`)
        if (!res.ok) {
          setError(`HTTP ${res.status}`)
          return
        }
        const data = await res.json()
        if (!cancelled) {
          setEntries(data.entries ?? [])
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
  }, [limit])

  return { entries, loading, error }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTs(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const EVENT_COLORS: Record<string, string> = {
  enter: 'text-emerald-400',
  exit: 'text-red-400',
  signal: 'text-blue-400',
  pause: 'text-amber-400',
  resume: 'text-amber-400',
  circuit_break: 'text-red-500',
  error: 'text-red-500',
}

function detailSummary(entry: JournalEntry): string {
  const d = entry.details
  const parts: string[] = []

  if (d.side) parts.push(String(d.side).toUpperCase())
  if (d.pattern_type ?? d.patternType) parts.push(String(d.pattern_type ?? d.patternType))
  if (d.confluence_grade ?? d.confluenceGrade ?? d.signal_grade) {
    parts.push(`[${d.confluence_grade ?? d.confluenceGrade ?? d.signal_grade}]`)
  }
  if (d.entry_price ?? d.entryPrice) parts.push(`@${Number(d.entry_price ?? d.entryPrice).toFixed(2)}`)
  if (d.exit_price ?? d.exitPrice) parts.push(`→${Number(d.exit_price ?? d.exitPrice).toFixed(2)}`)
  if (d.pnl != null || d.realized_pnl != null) {
    const pnl = Number(d.pnl ?? d.realized_pnl)
    parts.push(pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
  }
  if (d.exit_reason ?? d.exitReason) parts.push(`(${d.exit_reason ?? d.exitReason})`)
  if (d.reason) parts.push(String(d.reason))

  return parts.join(' ') || JSON.stringify(d).slice(0, 120)
}

// ─── Detail Panel ──────────────────────────────────────────────────────────

/** Format a single detail value for display */
function formatValue(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    // Prices / PnL: show decimals; timestamps: show date
    if (value > 1e12) return new Date(value).toISOString().replace('T', ' ').slice(0, 19)
    return Number.isInteger(value) ? String(value) : value.toFixed(4)
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Human-readable label from camelCase or snake_case key */
function labelFromKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Ordered field groups by event type — fields listed first get priority placement */
const FIELD_ORDER: Record<string, string[]> = {
  signal: ['setupId', 'setup_id', 'grade', 'confluence_grade', 'confluenceGrade', 'signal_grade', 'confidence', 'side', 'replaced'],
  enter: ['orderId', 'order_id', 'positionId', 'position_id', 'fillPrice', 'fill_price', 'entry_price', 'entryPrice', 'setupId', 'setup_id', 'side'],
  exit: ['positionId', 'position_id', 'closePrice', 'close_price', 'exit_price', 'exitPrice', 'pnl', 'realized_pnl', 'reason', 'exit_reason', 'exitReason'],
  skip: ['orderId', 'order_id', 'reason'],
  invalidate: ['setupId', 'setup_id', 'reason', 'positionId', 'position_id'],
  circuit_break: ['reason', 'dailyPnl', 'daily_pnl', 'accountValue', 'account_value', 'peakAccountValue', 'peak_account_value', 'pauseUntil', 'pause_until'],
  pause: ['reason'],
  resume: ['reason'],
  error: ['reason', 'message', 'error'],
}

function DetailPanel({ entry }: { entry: JournalEntry }) {
  const d = entry.details
  const keys = Object.keys(d)
  if (keys.length === 0) {
    return <div className="text-zinc-600 text-xs italic">No details</div>
  }

  // Order: priority fields first, then remaining alphabetically
  const priority = FIELD_ORDER[entry.event_type] ?? []
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const k of priority) {
    if (k in d) { ordered.push(k); seen.add(k) }
  }
  for (const k of keys.sort()) {
    if (!seen.has(k)) ordered.push(k)
  }

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
      {ordered.map((key) => (
        <div key={key} className="contents">
          <span className="text-zinc-500 text-xs">{labelFromKey(key)}</span>
          <span className="text-zinc-300 text-xs font-mono break-all">{formatValue(d[key])}</span>
        </div>
      ))}
    </div>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function JournalPage() {
  const { entries, loading, error } = useJournal(500)

  // Expand state
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const toggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  // Filters
  const [coinFilter, setCoinFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Derive filter options from data
  const coins = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) if (e.coin) set.add(e.coin)
    return Array.from(set).sort()
  }, [entries])

  const eventTypes = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) set.add(e.event_type)
    return Array.from(set).sort()
  }, [entries])

  // Apply filters
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (coinFilter && e.coin !== coinFilter) return false
      if (typeFilter && e.event_type !== typeFilter) return false
      if (dateFrom) {
        const from = new Date(dateFrom)
        if (new Date(e.ts) < from) return false
      }
      if (dateTo) {
        const to = new Date(dateTo)
        to.setDate(to.getDate() + 1) // include full day
        if (new Date(e.ts) >= to) return false
      }
      return true
    })
  }, [entries, coinFilter, typeFilter, dateFrom, dateTo])

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-zinc-500">
        Loading journal...
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
      <h2 className="text-xl font-semibold">Trade Journal</h2>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Coin</label>
          <select
            value={coinFilter}
            onChange={(e) => setCoinFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 w-28"
          >
            <option value="">All</option>
            {coins.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">Event</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 w-32"
          >
            <option value="">All</option>
            {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
          />
        </div>

        <div>
          <label className="block text-xs text-zinc-500 mb-1">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
          />
        </div>

        <div className="text-xs text-zinc-600 self-end pb-1.5">
          {filtered.length} / {entries.length} entries
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-500">
          No journal entries{entries.length > 0 ? ' matching filters' : ''}
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
              <tr className="text-left text-xs text-zinc-500 uppercase tracking-wider">
                <th className="px-1 py-2 w-8"></th>
                <th className="px-3 py-2 w-44">Time</th>
                <th className="px-3 py-2 w-20">Event</th>
                <th className="px-3 py-2 w-16">Coin</th>
                <th className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {filtered.map((e) => {
                const isExpanded = expandedId === e.id
                return (
                  <Fragment key={e.id}>
                    <tr
                      className="hover:bg-zinc-800/30 cursor-pointer"
                      onClick={() => toggleExpand(e.id)}
                    >
                      <td className="pl-2 pr-0 py-2">
                        <ChevronIcon expanded={isExpanded} />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-400 whitespace-nowrap">
                        {formatTs(e.ts)}
                      </td>
                      <td className={`px-3 py-2 text-xs font-semibold ${EVENT_COLORS[e.event_type] ?? 'text-zinc-400'}`}>
                        {e.event_type}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                        {e.coin ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400 font-mono truncate max-w-md">
                        {detailSummary(e)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-zinc-800/20">
                        <td></td>
                        <td colSpan={4} className="px-4 py-3">
                          <DetailPanel entry={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
