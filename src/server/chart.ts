import type { JournalEntry, PositionState } from '../agent/types.js'
import type { ActiveSetup, Candle, CandleInterval, ExchangeId } from '../types.js'
import type {
  ChartBar,
  ChartLine,
  ChartMark,
  ChartResolution,
  ChartSymbolInfo,
} from './contracts.js'

export const CHART_RESOLUTION_TO_INTERVAL: Record<ChartResolution, CandleInterval> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  '1D': '1d',
}

export const CHART_INTERVAL_TO_RESOLUTION: Record<CandleInterval, ChartResolution> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
}

export const CHART_SUPPORTED_RESOLUTIONS = Object.keys(CHART_RESOLUTION_TO_INTERVAL) as ChartResolution[]

export function buildTicker(exchange: ExchangeId, coin: string): string {
  return `${exchange}:${coin}`
}

export function parseTicker(ticker: string, activeExchange: ExchangeId): { exchange: ExchangeId; coin: string } {
  const [rawExchange, coin] = ticker.split(':')
  if (!coin || (rawExchange !== 'HL' && rawExchange !== 'BB')) {
    throw new Error(`Invalid ticker "${ticker}". Expected EXCHANGE:COIN`)
  }
  if (rawExchange !== activeExchange) {
    throw new Error(`Ticker exchange ${rawExchange} does not match active runtime exchange ${activeExchange}`)
  }
  return { exchange: rawExchange, coin }
}

export function resolutionToInterval(resolution: string): CandleInterval {
  if (resolution in CHART_RESOLUTION_TO_INTERVAL) {
    return CHART_RESOLUTION_TO_INTERVAL[resolution as ChartResolution]
  }
  throw new Error(`Unsupported chart resolution "${resolution}"`)
}

export function buildChartSymbolInfo(exchange: ExchangeId, coin: string): ChartSymbolInfo {
  return {
    ticker: buildTicker(exchange, coin),
    name: coin,
    description: `${coin} perpetual futures`,
    exchange,
    listed_exchange: exchange,
    type: 'crypto',
    session: '24x7',
    timezone: 'Etc/UTC',
    minmov: 1,
    pricescale: 100_000_000,
    volume_precision: 4,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: CHART_SUPPORTED_RESOLUTIONS,
    data_status: 'streaming',
  }
}

export function candleToChartBar(candle: Candle): ChartBar {
  return {
    time: Math.floor(candle.t / 1000),
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volume: candle.v,
  }
}

export function mergeCandlesForHistory(
  persistedCandles: Candle[],
  hotCandles: Candle[],
  fromMs: number,
  toMs: number,
  countBack: number,
): Candle[] {
  const merged = new Map<number, Candle>()
  for (const candle of persistedCandles) {
    if (candle.t < toMs) merged.set(candle.t, candle)
  }
  for (const candle of hotCandles) {
    if (candle.t < toMs) merged.set(candle.t, candle)
  }

  const all = [...merged.values()].sort((a, b) => a.t - b.t)
  const inRange = all.filter(candle => candle.t >= fromMs)
  if (countBack <= 0) return inRange
  if (inRange.length >= countBack) return inRange.slice(-countBack)
  return all.slice(-countBack)
}

function eventLabel(eventType: JournalEntry['eventType']): string {
  switch (eventType) {
    case 'signal':
      return 'S'
    case 'enter':
      return 'E'
    case 'exit':
      return 'X'
    case 'invalidate':
      return 'I'
    default:
      return '•'
  }
}

function eventColor(eventType: JournalEntry['eventType']): string {
  switch (eventType) {
    case 'signal':
      return '#22c55e'
    case 'enter':
      return '#14b8a6'
    case 'exit':
      return '#f59e0b'
    case 'invalidate':
      return '#ef4444'
    default:
      return '#94a3b8'
  }
}

function buildMarkText(entry: JournalEntry): string {
  const side = typeof entry.details['side'] === 'string' ? entry.details['side'] : null
  const interval = typeof entry.details['interval'] === 'string' ? entry.details['interval'] : null
  const pnl = typeof entry.details['pnl'] === 'number' ? entry.details['pnl'] : null

  if (entry.eventType === 'exit' && pnl !== null) {
    return `${entry.eventType.toUpperCase()} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
  }

  const suffix = [side, interval].filter((value): value is string => value !== null).join(' ')
  return suffix.length > 0 ? `${entry.eventType.toUpperCase()} ${suffix}` : entry.eventType.toUpperCase()
}

export function buildChartMarks(entries: JournalEntry[]): ChartMark[] {
  return entries
    .filter(entry =>
      entry.eventType === 'signal' ||
      entry.eventType === 'enter' ||
      entry.eventType === 'exit' ||
      entry.eventType === 'invalidate',
    )
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
    .map(entry => ({
      id: entry.id,
      time: Math.floor(entry.ts.getTime() / 1000),
      color: eventColor(entry.eventType),
      text: buildMarkText(entry),
      label: eventLabel(entry.eventType),
      minSize: 18,
    }))
}

function lineText(prefix: string, price: number, suffix?: string): string {
  return suffix ? `${prefix} ${price.toFixed(4)} · ${suffix}` : `${prefix} ${price.toFixed(4)}`
}

export function buildChartLines(setups: ActiveSetup[], positions: PositionState[]): ChartLine[] {
  const lines: ChartLine[] = []

  for (const setup of setups) {
    lines.push(
      {
        id: `${setup.id}:entry`,
        price: setup.entryPrice,
        text: lineText('Setup Entry', setup.entryPrice, `${setup.coin} ${setup.interval}`),
        color: '#38bdf8',
        source: 'setup',
      },
      {
        id: `${setup.id}:sl`,
        price: setup.slPrice,
        text: lineText('Setup SL', setup.slPrice, setup.side.toUpperCase()),
        color: '#fb7185',
        source: 'setup',
      },
      {
        id: `${setup.id}:tp`,
        price: setup.tpPrice,
        text: lineText('Setup TP', setup.tpPrice, setup.side.toUpperCase()),
        color: '#22c55e',
        source: 'setup',
      },
    )
  }

  for (const position of positions) {
    lines.push(
      {
        id: `${position.positionId}:entry`,
        price: position.entryPrice,
        text: lineText('Position Entry', position.entryPrice, `${position.coin} ${position.side.toUpperCase()}`),
        color: '#f8fafc',
        source: 'position',
      },
      {
        id: `${position.positionId}:sl`,
        price: position.slPrice,
        text: lineText('Position SL', position.slPrice),
        color: '#f97316',
        source: 'position',
      },
      {
        id: `${position.positionId}:tp`,
        price: position.tpPrice,
        text: lineText('Position TP', position.tpPrice),
        color: '#10b981',
        source: 'position',
      },
    )
  }

  return lines
}

