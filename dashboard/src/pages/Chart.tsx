/**
 * Chart page — candles + zones + structure + signals overlay.
 *
 * Data sources:
 *   - REST /api/candles/:coin/:tf — OHLCV candle data
 *   - REST /api/structure/:coin/:tf — swings + demand/supply zones
 *   - REST /api/setups — active setups filtered by coin
 *   - REST /api/health — coin list for selector
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChartControls } from '../components/chart/ChartControls'
import { CandleChart } from '../components/chart/CandleChart'

// ─── Types (aligned with server) ────────────────────────────────────────────

interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface KeyZone {
  type: 'demand' | 'supply'
  top: number
  bottom: number
  strength: number
  origin: string
  createdAtIdx: number
}

interface SwingPoint {
  type: 'HH' | 'HL' | 'LH' | 'LL'
  price: number
  index: number
}

interface Structure {
  bias: string
  biasConfidence: number
  swings: SwingPoint[]
  demandZones: KeyZone[]
  supplyZones: KeyZone[]
}

interface ActiveSetup {
  id: string
  coin: string
  interval: string
  type: string
  side: 'long' | 'short'
  entryPrice: number
  slPrice: number
  tpPrice: number
  confidence: number
  confluenceGrade?: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_COIN = 'BTC'
const DEFAULT_TF = '15m'
const CANDLE_COUNT = 200
const REFRESH_INTERVAL_MS = 15_000

// ─── Data fetching ──────────────────────────────────────────────────────────

async function fetchCandles(coin: string, tf: string): Promise<Candle[]> {
  const res = await fetch(`/api/candles/${coin}/${tf}?count=${CANDLE_COUNT}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.candles ?? []
}

async function fetchStructure(coin: string, tf: string): Promise<Structure> {
  const empty: Structure = { bias: 'neutral', biasConfidence: 0, swings: [], demandZones: [], supplyZones: [] }
  try {
    const res = await fetch(`/api/structure/${coin}/${tf}?count=${CANDLE_COUNT}`)
    if (!res.ok) return empty
    const data = await res.json()
    return data.structure ?? empty
  } catch {
    return empty
  }
}

async function fetchSetups(coin: string): Promise<ActiveSetup[]> {
  try {
    const res = await fetch('/api/setups')
    if (!res.ok) return []
    const data = await res.json()
    const all: ActiveSetup[] = data.setups ?? []
    return all.filter((s) => s.coin === coin)
  } catch {
    return []
  }
}

async function fetchCoins(): Promise<string[]> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return [DEFAULT_COIN]
    const data = await res.json()
    return data.coinList ?? [DEFAULT_COIN]
  } catch {
    return [DEFAULT_COIN]
  }
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ChartPage() {
  const { coin: paramCoin, tf: paramTf } = useParams<{ coin?: string; tf?: string }>()
  const navigate = useNavigate()

  const coin = paramCoin?.toUpperCase() || DEFAULT_COIN
  const tf = paramTf || DEFAULT_TF

  // Redirect bare /chart to /chart/BTC/15m
  useEffect(() => {
    if (!paramCoin || !paramTf) {
      navigate(`/chart/${DEFAULT_COIN}/${DEFAULT_TF}`, { replace: true })
    }
  }, [paramCoin, paramTf, navigate])

  const [coins, setCoins] = useState<string[]>([DEFAULT_COIN])
  const [candles, setCandles] = useState<Candle[]>([])
  const [structure, setStructure] = useState<Structure>({
    bias: 'neutral', biasConfidence: 0, swings: [], demandZones: [], supplyZones: [],
  })
  const [setups, setSetups] = useState<ActiveSetup[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<number>(0)

  // Fetch coin list once
  useEffect(() => {
    fetchCoins().then(setCoins)
  }, [])

  // Fetch chart data when coin/tf changes
  const loadData = useCallback(async () => {
    setLoading(true)
    const [c, s, a] = await Promise.all([
      fetchCandles(coin, tf),
      fetchStructure(coin, tf),
      fetchSetups(coin),
    ])
    setCandles(c)
    setStructure(s)
    setSetups(a)
    setLoading(false)
    setLastRefresh(Date.now())
  }, [coin, tf])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-refresh
  useEffect(() => {
    const id = setInterval(loadData, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [loadData])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold">Chart</h2>
          <ChartControls coin={coin} tf={tf} coins={coins} />
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          {loading && <span className="text-amber-400">Loading...</span>}
          {lastRefresh > 0 && (
            <span>Updated: {new Date(lastRefresh).toLocaleTimeString()}</span>
          )}
          <button
            onClick={loadData}
            className="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Chart area */}
      {candles.length === 0 && !loading ? (
        <div className="flex-1 flex items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)]">
          <div className="text-center text-[var(--text-tertiary)]">
            <p className="text-lg mb-1">No candle data</p>
            <p className="text-sm">Waiting for {coin} {tf} data from feed...</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
          <CandleChart
            candles={candles}
            demandZones={structure.demandZones}
            supplyZones={structure.supplyZones}
            swings={structure.swings}
            setups={setups}
            bias={structure.bias}
            biasConfidence={structure.biasConfidence}
          />
        </div>
      )}
    </div>
  )
}
