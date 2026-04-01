/**
 * Trade Journal page — filterable table of journal entries.
 *
 * Data source: REST /api/agent/journal?limit=N&type=T
 * Filters: coin, event type, date range (client-side filter on fetched data)
 */

import { useEffect, useState, useMemo } from 'react'

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

// ─── Page ───────────────────────────────────────────────────────────────────

export function JournalPage() {
  const { entries, loading, error } = useJournal(500)

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
                <th className="px-3 py-2 w-44">Time</th>
                <th className="px-3 py-2 w-20">Event</th>
                <th className="px-3 py-2 w-16">Coin</th>
                <th className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {filtered.map((e) => (
                <tr key={e.id} className="hover:bg-zinc-800/30">
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
