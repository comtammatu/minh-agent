import { startTransition, useEffect, useEffectEvent, useState } from 'react'
import type {
  ChartOverlayResponse,
  ChartResolution,
  ChartSymbolInfo,
  DashboardEventType,
  DashboardJournalRow,
  DashboardSnapshotResponse,
} from './dashboard-types'

export async function fetchJson<T>(input: string): Promise<T> {
  const response = await fetch(input)
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

interface PollingState<T> {
  data: T | null
  isLoading: boolean
  error: string | null
}

export function usePollingJson<T>(url: string | null, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useEffectEvent(async () => {
    if (!url) return
    try {
      const next = await fetchJson<T>(url)
      startTransition(() => {
        setData(next)
        setError(null)
        setIsLoading(false)
      })
    } catch (err) {
      startTransition(() => {
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      })
    }
  })

  useEffect(() => {
    if (!url) return
    setIsLoading(true)
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs, url])

  return { data, isLoading, error }
}

export function useDashboardSnapshot(): PollingState<DashboardSnapshotResponse> {
  return usePollingJson<DashboardSnapshotResponse>('/api/dashboard/snapshot', 1_000)
}

export function useJournalRows(coin: string | 'ALL' | null, eventType: DashboardEventType | 'ALL', limit = 200) {
  if (coin === null) {
    return usePollingJson<{ rows: DashboardJournalRow[] }>(null, 5_000)
  }
  const params = new URLSearchParams()
  if (coin !== 'ALL') params.set('coin', coin)
  if (eventType !== 'ALL') params.set('eventType', eventType)
  params.set('limit', String(limit))
  return usePollingJson<{ rows: DashboardJournalRow[] }>(`/api/dashboard/journal?${params.toString()}`, 5_000)
}

export function useChartOverlays(ticker: string | null) {
  return usePollingJson<ChartOverlayResponse>(
    ticker ? `/api/chart/overlays?ticker=${encodeURIComponent(ticker)}` : null,
    1_000,
  )
}

export async function fetchSymbols(): Promise<ChartSymbolInfo[]> {
  const payload = await fetchJson<{ symbols: ChartSymbolInfo[] }>('/api/chart/symbols')
  return payload.symbols
}

export async function fetchSymbolInfo(ticker: string): Promise<ChartSymbolInfo> {
  return fetchJson<ChartSymbolInfo>(`/api/chart/symbols/${encodeURIComponent(ticker)}`)
}

export const CHART_RESOLUTIONS: ChartResolution[] = ['1', '5', '15', '60', '240', '1D']
