/**
 * CandleChart — Lightweight Charts wrapper with zone/structure/signal overlays.
 *
 * Renders:
 *   - Candlestick series (OHLCV)
 *   - Volume histogram (bottom pane)
 *   - Demand zones (green horizontal bands)
 *   - Supply zones (red horizontal bands)
 *   - Swing points as markers (HH/HL/LH/LL)
 *   - Active signals as arrow markers
 */

import { useEffect, useRef, useCallback } from 'react'
import {
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type HistogramData,
  type SeriesMarkerBar,
  type Time,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
} from 'lightweight-charts'

// ─── Types ──────────────────────────────────────────────────────────────────

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

interface CandleChartProps {
  candles: Candle[]
  demandZones: KeyZone[]
  supplyZones: KeyZone[]
  swings: SwingPoint[]
  setups: ActiveSetup[]
  bias: string
  biasConfidence: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toTime(ts: number): Time {
  return (ts / 1000) as Time
}

function swingColor(type: string): string {
  switch (type) {
    case 'HH': return '#22c55e'
    case 'HL': return '#4ade80'
    case 'LH': return '#ef4444'
    case 'LL': return '#f87171'
    default: return '#a1a1aa'
  }
}

function swingShape(type: string): SeriesMarkerBar<Time>['shape'] {
  return type === 'HH' || type === 'LH' ? 'arrowDown' : 'arrowUp'
}

function swingPosition(type: string): SeriesMarkerBar<Time>['position'] {
  return type === 'HH' || type === 'LH' ? 'aboveBar' : 'belowBar'
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CandleChart({
  candles,
  demandZones,
  supplyZones,
  swings,
  setups,
  bias,
  biasConfidence,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const priceLinesRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([])

  // ── Create chart ────────────────────────────────────────────────────────
  const initChart = useCallback(() => {
    if (!containerRef.current) return

    // Clean up previous chart
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      markersRef.current = null
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#09090b' },
        textColor: '#a1a1aa',
        fontSize: 12,
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      crosshair: {
        vertLine: { color: '#52525b', labelBackgroundColor: '#3f3f46' },
        horzLine: { color: '#52525b', labelBackgroundColor: '#3f3f46' },
      },
      rightPriceScale: {
        borderColor: '#27272a',
      },
      timeScale: {
        borderColor: '#27272a',
        timeVisible: true,
        secondsVisible: false,
      },
    })

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    })

    // Volume histogram
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    })

    // Series markers plugin (LC v5)
    const seriesMarkers = createSeriesMarkers(candleSeries)

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    markersRef.current = seriesMarkers

    // Handle resize
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        chart.applyOptions({ width, height })
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      chart.remove()
    }
  }, [])

  // ── Init chart on mount ─────────────────────────────────────────────────
  useEffect(() => {
    const cleanup = initChart()
    return () => cleanup?.()
  }, [initChart])

  // ── Update data ─────────────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!chart || !candleSeries || !volumeSeries || candles.length === 0) return

    // Set candle data
    const candleData: CandlestickData<Time>[] = candles.map((c) => ({
      time: toTime(c.t),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }))
    candleSeries.setData(candleData)

    // Set volume data
    const volumeData: HistogramData<Time>[] = candles.map((c) => ({
      time: toTime(c.t),
      value: c.v,
      color: c.c >= c.o ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
    }))
    volumeSeries.setData(volumeData)

    // ── Swing markers ───────────────────────────────────────────────────
    const markers: SeriesMarkerBar<Time>[] = []

    for (const sw of swings) {
      if (sw.index < 0 || sw.index >= candles.length) continue
      markers.push({
        time: toTime(candles[sw.index].t),
        position: swingPosition(sw.type),
        color: swingColor(sw.type),
        shape: swingShape(sw.type),
        text: sw.type,
      })
    }

    // ── Signal markers ──────────────────────────────────────────────────
    for (const setup of setups) {
      const lastCandle = candles[candles.length - 1]
      if (!lastCandle) continue

      markers.push({
        time: toTime(lastCandle.t),
        position: setup.side === 'long' ? 'belowBar' : 'aboveBar',
        color: setup.side === 'long' ? '#22c55e' : '#ef4444',
        shape: setup.side === 'long' ? 'arrowUp' : 'arrowDown',
        text: `${setup.type} ${setup.confluenceGrade ?? ''}`.trim(),
      })
    }

    // Sort markers by time (required by LC)
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    if (markersRef.current) {
      markersRef.current.setMarkers(markers)
    }

    // ── Zone price lines ────────────────────────────────────────────────
    // Remove old price lines before creating new ones (prevent accumulation on refresh)
    for (const line of priceLinesRef.current) {
      candleSeries.removePriceLine(line)
    }
    priceLinesRef.current = []

    // Demand zones (green bands — top and bottom lines)
    for (const zone of demandZones) {
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: zone.top,
        color: 'rgba(34, 197, 94, 0.4)',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: false,
        title: '',
      }))
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: zone.bottom,
        color: 'rgba(34, 197, 94, 0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: `D ${zone.origin}`,
      }))
    }

    // Supply zones (red bands — top and bottom lines)
    for (const zone of supplyZones) {
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: zone.top,
        color: 'rgba(239, 68, 68, 0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: `S ${zone.origin}`,
      }))
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: zone.bottom,
        color: 'rgba(239, 68, 68, 0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: '',
      }))
    }

    // ── Setup entry/SL/TP lines ─────────────────────────────────────────
    for (const setup of setups) {
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: setup.entryPrice,
        color: '#f59e0b',
        lineWidth: 1,
        lineStyle: 0, // solid
        axisLabelVisible: true,
        title: `Entry ${setup.type}`,
      }))
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: setup.slPrice,
        color: '#ef4444',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'SL',
      }))
      priceLinesRef.current.push(candleSeries.createPriceLine({
        price: setup.tpPrice,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'TP',
      }))
    }

    // Fit content
    chart.timeScale().fitContent()
  }, [candles, demandZones, supplyZones, swings, setups])

  // ── Bias indicator ──────────────────────────────────────────────────────
  const biasColor = bias === 'bullish' ? 'text-emerald-400' : bias === 'bearish' ? 'text-red-400' : 'text-zinc-400'

  return (
    <div className="flex flex-col h-full">
      {/* Bias bar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800 text-xs">
        <span className="text-zinc-500">Bias:</span>
        <span className={`font-semibold uppercase ${biasColor}`}>{bias}</span>
        <span className="text-zinc-600">({(biasConfidence * 100).toFixed(0)}%)</span>
        <span className="text-zinc-700">|</span>
        <span className="text-zinc-500">Zones:</span>
        <span className="text-emerald-400/70">{demandZones.length}D</span>
        <span className="text-red-400/70">{supplyZones.length}S</span>
        <span className="text-zinc-700">|</span>
        <span className="text-zinc-500">Setups:</span>
        <span className="text-amber-400">{setups.length}</span>
      </div>

      {/* Chart container */}
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  )
}
