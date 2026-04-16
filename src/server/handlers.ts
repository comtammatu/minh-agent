import path from 'node:path'
import type { JournalEntry, JournalEventType, PositionState } from '../agent/types.js'
import { getJournalEntries } from '../agent/journal.js'
import { type LiveMetrics, } from '../analytics/types.js'
import { getLiveMetrics } from '../analytics/metrics-service.js'
import { DASHBOARD_CHART_HISTORY_BATCH_SIZE, HOT_CACHE_CAP_BARS } from '../config.js'
import { loadCandlesBefore, loadLatestCandle } from '../db/candle-repo.js'
import { getCandles } from '../feed/store.js'
import { log } from '../lib/logger.js'
import type {
  ChartHistoryResponse,
  ChartOverlayResponse,
  DashboardAccountSnapshot,
  DashboardJournalRow,
  DashboardPositionRow,
  DashboardServerState,
  DashboardSnapshotResponse,
  DashboardWatchlistRow,
} from './contracts.js'
import {
  buildChartLines,
  buildChartMarks,
  buildChartSymbolInfo,
  mergeCandlesForHistory,
  parseTicker,
  resolutionToInterval,
  candleToChartBar,
  buildTicker,
} from './chart.js'

const DASHBOARD_DIST_DIR = path.resolve(import.meta.dir, '..', '..', 'dashboard', 'dist')
const JOURNAL_EVENTS: JournalEventType[] = [
  'signal',
  'enter',
  'exit',
  'skip',
  'invalidate',
  'circuit_break',
  'pause',
  'resume',
  'error',
  'operator',
]

type AccountStateLike = {
  effectiveBalance: number
  accountValue: number
  spotUsdcBalance: number
  totalMarginUsed: number
  withdrawable: number
}

export interface DashboardFetchHandlerOptions {
  state: DashboardServerState
  getSummaryMetrics?: () => Promise<LiveMetrics>
  readJournal?: typeof getJournalEntries
  readCandlesBefore?: typeof loadCandlesBefore
  readLatestCandle?: typeof loadLatestCandle
  distDir?: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function notFound(message: string): Response {
  return json({ error: message }, 404)
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

function clampLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function parseTimestampMs(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed * 1000 : fallback
}

function serializeJournal(entries: JournalEntry[]): DashboardJournalRow[] {
  return entries.map(entry => ({
    id: entry.id,
    ts: entry.ts.toISOString(),
    eventType: entry.eventType,
    coin: entry.coin,
    details: entry.details,
    agentState: entry.agentState,
    exchange: entry.exchange,
  }))
}

function computeUnrealizedPnl(position: {
  side: 'long' | 'short'
  entryPrice: number
  currentSize: number
}, markPrice: number | null): number | null {
  if (markPrice === null) return null
  const direction = position.side === 'long' ? 1 : -1
  return (markPrice - position.entryPrice) * Math.abs(position.currentSize) * direction
}

function serializePositions(state: DashboardServerState): DashboardPositionRow[] {
  return [...state.sources.getPositions().values()].map(position => {
    const asset = state.sources.getAssetPrice(position.coin)
    return {
      positionId: position.positionId ?? position.rowKey ?? `${position.coin}:${position.side}`,
      coin: position.coin,
      side: position.side,
      leverage: position.leverage,
      entryPrice: position.entryPrice,
      currentSize: position.currentSize,
      slPrice: position.slPrice,
      tpPrice: position.tpPrice,
      exchangeOnly: position.exchangeOnly === true,
      markPrice: asset?.markPrice ?? null,
      unrealizedPnl: computeUnrealizedPnl(position, asset?.markPrice ?? null),
    }
  })
}

function serializeWatchlist(state: DashboardServerState): DashboardWatchlistRow[] {
  return state.sources.getStatus().map(status => {
    const asset = state.sources.getAssetPrice(status.coin)
    return {
      coin: status.coin,
      interval: status.interval,
      regime: status.regime,
      bias: status.bias,
      biasConfidence: status.biasConfidence,
      confluenceGrade: status.confluenceGrade,
      activeCount: status.activeCount,
      lastUpdateAt: status.lastUpdateAt,
      markPrice: asset?.markPrice ?? null,
      funding: asset?.funding ?? null,
      dayChangePctUtc: asset?.dayChangePctUtc ?? null,
    }
  })
}

function serializeSetups(state: DashboardServerState) {
  return state.sources.getActiveSetups().map(setup => ({
    id: setup.id,
    coin: setup.coin,
    interval: setup.interval,
    side: setup.side,
    confidence: setup.confidence,
    entryPrice: setup.entryPrice,
    slPrice: setup.slPrice,
    tpPrice: setup.tpPrice,
    detectedAt: setup.detectedAt,
  }))
}

function buildAccountSnapshot(
  state: DashboardServerState,
  positions: DashboardPositionRow[],
  accountState: AccountStateLike | null,
): DashboardAccountSnapshot {
  const liveWalletStats = state.sources.getLiveWalletStats()
  const unrealizedPnl = positions.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0), 0)

  return {
    source: 'live',
    balance: accountState?.effectiveBalance ?? null,
    equity: accountState?.accountValue ?? null,
    available: accountState?.withdrawable ?? null,
    marginUsed: accountState?.totalMarginUsed ?? null,
    withdrawable: accountState?.withdrawable ?? null,
    spotUsdcBalance: accountState?.spotUsdcBalance ?? null,
    unrealizedPnl,
    wins: liveWalletStats?.wins ?? 0,
    losses: liveWalletStats?.losses ?? 0,
    tradeCount: liveWalletStats?.tradeCount ?? 0,
    winRate: liveWalletStats?.winRate ?? 0,
  }
}

async function serveStaticFile(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  return new Response(file)
}

function relativePathFromPrefix(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null
  const relative = pathname.slice(prefix.length)
  const segments = relative.split('/').filter(Boolean)
  if (segments.some(segment => segment === '..')) return null
  return segments
}

async function serveDashboardApp(pathname: string, distDir: string): Promise<Response> {
  const segments = relativePathFromPrefix(pathname, '/dashboard')
  if (segments === null) return notFound('Invalid dashboard path')

  if (pathname === '/dashboard') {
    return Response.redirect(new URL('/dashboard/', 'http://localhost').toString(), 307)
  }

  if (pathname === '/dashboard/' || segments.length === 0) {
    const fileResponse = await serveStaticFile(path.join(distDir, 'index.html'))
    return fileResponse ?? html(`
      <!doctype html>
      <html lang="en">
        <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Minh Dashboard</title></head>
        <body><main style="padding:32px;font-family:ui-monospace;background:#09090b;color:#f4f4f5;">Run <code>bun run dashboard:build</code> to generate the dashboard bundle.</main></body>
      </html>
    `)
  }

  const rel = segments.join('/')
  const requestPath = pathname === '/dashboard/' ? 'index.html' : rel
  const hasExtension = requestPath.includes('.')
  const candidatePath = hasExtension
    ? path.join(distDir, requestPath)
    : path.join(distDir, 'index.html')

  const fileResponse = await serveStaticFile(candidatePath)
  if (fileResponse !== null) return fileResponse

  return html(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Minh Dashboard</title>
        <style>
          body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #09090b; color: #f4f4f5; display: grid; place-items: center; min-height: 100vh; margin: 0; }
          main { max-width: 720px; padding: 32px; border: 1px solid #27272a; border-radius: 20px; background: linear-gradient(180deg, rgba(24,24,27,0.96), rgba(9,9,11,0.98)); }
          code { color: #86efac; }
        </style>
      </head>
      <body>
        <main>
          <h1>Dashboard build not found</h1>
          <p>Run <code>bun run dashboard:build</code> to generate the web UI bundle. API routes remain available under <code>/api/*</code>.</p>
        </main>
      </body>
    </html>
  `)
}

async function serveDistAsset(pathname: string, prefix: string, distDir: string): Promise<Response> {
  const segments = relativePathFromPrefix(pathname, prefix)
  if (segments === null || segments.length === 0) return notFound('Asset not found')
  const response = await serveStaticFile(path.join(distDir, prefix.slice(1), ...segments))
  return response ?? notFound('Asset not found')
}

export function createDashboardFetchHandler(options: DashboardFetchHandlerOptions) {
  const readJournal = options.readJournal ?? getJournalEntries
  const getSummaryMetrics = options.getSummaryMetrics ?? getLiveMetrics
  const readCandlesBefore = options.readCandlesBefore ?? loadCandlesBefore
  const readLatest = options.readLatestCandle ?? loadLatestCandle
  const distDir = options.distDir ?? DASHBOARD_DIST_DIR

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname === '/') {
      return Response.redirect(new URL('/dashboard/', request.url).toString(), 307)
    }

    try {
      if (pathname === '/api/dashboard/snapshot') {
        const [metrics, journal, maybeAccountState] = await Promise.all([
          getSummaryMetrics(),
          readJournal({ limit: 12, exchange: options.state.activeExchange }),
          options.state.sources.getAccountState()?.catch(() => null) ?? Promise.resolve(null),
        ])

        const positions = serializePositions(options.state)
        const snapshot: DashboardSnapshotResponse = {
          bootstrap: {
            phase: options.state.getBootstrapPhase(),
            trackedCoins: options.state.sources.getTrackedCoins(),
          },
          mode: {
            exchange: options.state.activeExchange,
            paperTrade: false,
          },
          health: options.state.sources.getHealthReport(),
          account: buildAccountSnapshot(options.state, positions, maybeAccountState),
          positions,
          watchlist: serializeWatchlist(options.state),
          activeSetups: serializeSetups(options.state),
          summaryMetrics: metrics,
          recentJournal: serializeJournal(journal),
        }
        return json(snapshot)
      }

      if (pathname === '/api/dashboard/journal') {
        const coin = url.searchParams.get('coin')?.trim() || undefined
        const eventType = url.searchParams.get('eventType')?.trim()
        if (eventType && !JOURNAL_EVENTS.includes(eventType as JournalEventType)) {
          return badRequest(`Unsupported journal event type "${eventType}"`)
        }
        const limit = clampLimit(url.searchParams.get('limit'), 100, 500)
        const filter = {
          limit,
          exchange: options.state.activeExchange,
          ...(coin ? { coin } : {}),
          ...(eventType ? { eventType: eventType as JournalEventType } : {}),
        }
        const rows = await readJournal(filter)
        return json({ rows: serializeJournal(rows) })
      }

      if (pathname === '/api/chart/symbols') {
        const symbols = options.state.sources
          .getTrackedCoins()
          .map(coin => buildChartSymbolInfo(options.state.activeExchange, coin))
        return json({ symbols })
      }

      if (pathname.startsWith('/api/chart/symbols/')) {
        const ticker = decodeURIComponent(pathname.slice('/api/chart/symbols/'.length))
        const parsed = parseTicker(ticker, options.state.activeExchange)
        if (!options.state.sources.getTrackedCoins().includes(parsed.coin)) {
          return notFound(`Unknown ticker "${ticker}"`)
        }
        return json(buildChartSymbolInfo(parsed.exchange, parsed.coin))
      }

      if (pathname === '/api/chart/history') {
        const ticker = url.searchParams.get('ticker')
        const resolution = url.searchParams.get('resolution')
        if (!ticker || !resolution) {
          return badRequest('ticker and resolution are required')
        }

        const { coin } = parseTicker(ticker, options.state.activeExchange)
        const interval = resolutionToInterval(resolution)
        // Keep history responses bounded so TradingView back-scroll loads in stable 300-bar chunks.
        const countBack = DASHBOARD_CHART_HISTORY_BATCH_SIZE
        const toMs = parseTimestampMs(url.searchParams.get('to'), Date.now())
        const fromMs = parseTimestampMs(url.searchParams.get('from'), Math.max(0, toMs - 7 * 24 * 60 * 60 * 1000))
        const hotCandles = getCandles(
          coin,
          interval,
          HOT_CACHE_CAP_BARS[interval],
          options.state.activeExchange,
        )
        const persisted = await readCandlesBefore(
          coin,
          interval,
          toMs,
          Math.max(countBack + hotCandles.length + 8, countBack),
        )
        const merged = mergeCandlesForHistory(persisted, hotCandles, fromMs, toMs, countBack)
        const response: ChartHistoryResponse = {
          bars: merged.map(candleToChartBar),
          noData: merged.length === 0,
        }
        return json(response)
      }

      if (pathname === '/api/chart/latest') {
        const ticker = url.searchParams.get('ticker')
        const resolution = url.searchParams.get('resolution')
        if (!ticker || !resolution) {
          return badRequest('ticker and resolution are required')
        }

        const { coin } = parseTicker(ticker, options.state.activeExchange)
        const interval = resolutionToInterval(resolution)
        const hot = getCandles(coin, interval, 1, options.state.activeExchange)
        const latest = hot[hot.length - 1] ?? await readLatest(coin, interval)
        return json({ bar: latest ? candleToChartBar(latest) : null })
      }

      if (pathname === '/api/chart/overlays') {
        const ticker = url.searchParams.get('ticker')
        if (!ticker) return badRequest('ticker is required')

        const { coin } = parseTicker(ticker, options.state.activeExchange)
        const journal = await readJournal({ coin, limit: 200, exchange: options.state.activeExchange })
        const positions = [...options.state.sources.getPositions().values()]
          .filter(position => position.coin === coin)
          .map(position => ({
            positionId: position.positionId ?? position.rowKey ?? `${position.coin}:${position.side}`,
            coin: position.coin,
            side: position.side,
            entryPrice: position.entryPrice,
            currentSize: position.currentSize,
            originalSize: position.currentSize,
            slPrice: position.slPrice,
            tpPrice: position.tpPrice,
            entryOrderId: '',
            leverage: position.leverage,
            trailingState: null,
            partialClosesFired: [],
            lastSyncAt: Date.now(),
            openedAt: Date.now(),
            thesis: null,
            lastThesisCheckAt: 0,
          } satisfies PositionState))
        const activeSetups = options.state.sources.getActiveSetups().filter(setup => setup.coin === coin)
        const overlays: ChartOverlayResponse = {
          marks: buildChartMarks(journal),
          lines: buildChartLines(activeSetups, positions),
        }
        return json(overlays)
      }

      if (pathname.startsWith('/charting_library/')) {
        return serveDistAsset(pathname, '/charting_library/', distDir)
      }

      if (pathname.startsWith('/datafeeds/')) {
        return serveDistAsset(pathname, '/datafeeds/', distDir)
      }

      if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
        return serveDashboardApp(pathname, distDir)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('dashboard', `Request failed ${pathname}: ${message}`)
      return json({ error: message }, 500)
    }

    return notFound(`No route for ${pathname}`)
  }
}
