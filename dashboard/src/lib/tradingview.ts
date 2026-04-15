import type {
  ChartBar,
  ChartMark,
  ChartResolution,
  ChartSymbolInfo,
} from './dashboard-types'
import { fetchJson, fetchSymbolInfo, fetchSymbols } from './api'

type ResolutionString = ChartResolution | string

type TradingViewSymbolSearchResult = {
  symbol: string
  full_name: string
  description: string
  exchange: string
  ticker: string
  type: string
}

type TradingViewWidgetOptions = {
  symbol: string
  interval: ResolutionString
  container: HTMLElement
  library_path: string
  locale: string
  datafeed: TradingViewDatafeed
  autosize: boolean
  timezone: string
  theme: 'dark' | 'light'
  disabled_features?: string[]
  enabled_features?: string[]
  overrides?: Record<string, unknown>
}

type ShapeEntityId = string | number

export interface TradingViewChartApi {
  createShape: (
    point: { time: number; price?: number },
    options: {
      shape: 'horizontal_line'
      text?: string
      lock?: boolean
      disableSelection?: boolean
      disableSave?: boolean
      disableUndo?: boolean
      overrides?: Record<string, unknown>
    }
  ) => Promise<ShapeEntityId>
  removeEntity: (entityId: ShapeEntityId) => void
  refreshMarks: () => void
  clearMarks: () => void
}

export interface TradingViewWidget {
  onChartReady: (handler: () => void) => void
  activeChart: () => TradingViewChartApi
  remove: () => void
}

export interface TradingViewConstructor {
  widget: new (options: TradingViewWidgetOptions) => TradingViewWidget
}

declare global {
  interface Window {
    TradingView?: TradingViewConstructor
  }
}

interface TradingViewDatafeed {
  onReady: (callback: (configuration: Record<string, unknown>) => void) => void
  searchSymbols: (
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: (results: TradingViewSymbolSearchResult[]) => void,
  ) => void
  resolveSymbol: (
    symbolName: string,
    onResolve: (symbolInfo: ChartSymbolInfo) => void,
    onError: (reason: string) => void,
  ) => void
  getBars: (
    symbolInfo: ChartSymbolInfo,
    resolution: ResolutionString,
    periodParams: { from: number; to: number; countBack: number },
    onHistory: (bars: ChartBar[], meta: { noData: boolean }) => void,
    onError: (reason: string) => void,
  ) => void
  subscribeBars: (
    symbolInfo: ChartSymbolInfo,
    resolution: ResolutionString,
    onRealtime: (bar: ChartBar) => void,
    subscriberUID: string,
    onResetCacheNeededCallback: () => void,
  ) => void
  unsubscribeBars: (subscriberUID: string) => void
  getMarks: (
    symbolInfo: ChartSymbolInfo,
    from: number,
    to: number,
    onData: (marks: ChartMark[]) => void,
    resolution: ResolutionString,
  ) => void
}

const subscribers = new Map<string, number>()

export async function ensureTradingView(): Promise<TradingViewConstructor> {
  if (window.TradingView) return window.TradingView

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/charting_library/charting_library.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load TradingView library'))
    document.head.appendChild(script)
  })

  if (!window.TradingView) {
    throw new Error('TradingView library did not initialize')
  }

  return window.TradingView
}

export function createTradingViewDatafeed(): TradingViewDatafeed {
  return {
    onReady(callback) {
      window.setTimeout(() => {
        callback({
          supports_search: true,
          supports_group_request: false,
          supports_marks: true,
          supported_resolutions: ['1', '5', '15', '60', '240', '1D'],
        })
      }, 0)
    },
    searchSymbols(userInput, _exchange, _symbolType, onResult) {
      void fetchSymbols()
        .then(symbols => {
          const needle = userInput.trim().toLowerCase()
          const matches = symbols
            .filter(symbol =>
              needle.length === 0 ||
              symbol.name.toLowerCase().includes(needle) ||
              symbol.ticker.toLowerCase().includes(needle),
            )
            .map(symbol => ({
              symbol: symbol.ticker,
              full_name: symbol.ticker,
              description: symbol.description,
              exchange: symbol.exchange,
              ticker: symbol.ticker,
              type: symbol.type,
            }))
          onResult(matches)
        })
        .catch(() => onResult([]))
    },
    resolveSymbol(symbolName, onResolve, onError) {
      void fetchSymbolInfo(symbolName).then(onResolve).catch(err => onError(err instanceof Error ? err.message : String(err)))
    },
    getBars(symbolInfo, resolution, periodParams, onHistory, onError) {
      const params = new URLSearchParams({
        ticker: symbolInfo.ticker,
        resolution: String(resolution),
        from: String(periodParams.from),
        to: String(periodParams.to),
        countBack: String(periodParams.countBack),
      })
      void fetchJson<{ bars: ChartBar[]; noData: boolean }>(`/api/chart/history?${params.toString()}`)
        .then(payload => onHistory(payload.bars, { noData: payload.noData }))
        .catch(err => onError(err instanceof Error ? err.message : String(err)))
    },
    subscribeBars(symbolInfo, resolution, onRealtime, subscriberUID, onResetCacheNeededCallback) {
      let lastBarTime = 0
      const poll = async (): Promise<void> => {
        try {
          const payload = await fetchJson<{ bar: ChartBar | null }>(
            `/api/chart/latest?ticker=${encodeURIComponent(symbolInfo.ticker)}&resolution=${encodeURIComponent(String(resolution))}`,
          )
          const next = payload.bar
          if (!next) return
          if (lastBarTime > 0 && next.time < lastBarTime) {
            onResetCacheNeededCallback()
            return
          }
          if (next.time !== lastBarTime) {
            lastBarTime = next.time
            onRealtime(next)
          }
        } catch {
          // Polling errors are non-fatal; next interval will retry.
        }
      }
      void poll()
      const timer = window.setInterval(() => {
        void poll()
      }, 1_000)
      subscribers.set(subscriberUID, timer)
    },
    unsubscribeBars(subscriberUID) {
      const timer = subscribers.get(subscriberUID)
      if (timer !== undefined) {
        window.clearInterval(timer)
        subscribers.delete(subscriberUID)
      }
    },
    getMarks(symbolInfo, from, to, onData) {
      void fetchJson<{ marks: ChartMark[] }>(`/api/chart/overlays?ticker=${encodeURIComponent(symbolInfo.ticker)}`)
        .then(payload => onData(payload.marks.filter(mark => mark.time >= from && mark.time <= to)))
        .catch(() => onData([]))
    },
  }
}

