/**
 * Polling hook for /api/metrics — fetches LiveMetrics every 30s.
 *
 * Separate from SSE because metrics are expensive (DB queries)
 * and don't need sub-second freshness.
 */

import { useEffect, useRef, useState } from 'react'

// ─── Types (aligned with src/analytics/types.ts LiveMetrics) ────────────────

export interface PatternMetric {
  patternType: string
  signalGrade: string
  trades: number
  wins: number
  winRate: number
  totalPnl: number
  avgPnl: number
}

export interface CoinMetric {
  coin: string
  trades: number
  wins: number
  winRate: number
  totalPnl: number
  avgPnl: number
}

export interface LiveMetrics {
  winRate: { daily: number; weekly: number; monthly: number; allTime: number }
  pnl: { daily: number; weekly: number; monthly: number; allTime: number }
  trades: { daily: number; weekly: number; monthly: number; allTime: number }
  patternMetrics: PatternMetric[]
  coinMetrics: CoinMetric[]
  currentDrawdown: number
  maxDrawdown: number
  openPositionCount: number
}

// ─── Hook ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000

export function useMetrics() {
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetch_() {
      try {
        const res = await fetch('/api/metrics')
        if (!res.ok) {
          setError(`HTTP ${res.status}`)
          return
        }
        const data = await res.json()
        if (!cancelled) {
          setMetrics(data as LiveMetrics)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    // Initial fetch
    fetch_()

    // Poll
    intervalRef.current = setInterval(fetch_, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  return { metrics, error, loading }
}
