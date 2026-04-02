/**
 * Elysia HTTP server — read endpoints + auth-protected execution endpoints.
 * R4: Bound to 127.0.0.1 only. No remote attack surface.
 *
 * Read endpoints (no auth):
 *   GET /api/health          — status, uptime, tracked coins
 *   GET /api/status          — pipeline status per coin/tf
 *   GET /api/setups          — active setups
 *   GET /api/candles/:coin/:tf — candle data with ?count
 *
 * Agent endpoints (no auth, read-only):
 *   GET /api/agent/state     — agent state
 *   GET /api/agent/journal   — trade journal from PG
 *   GET /api/agent/positions — open positions from PositionMonitor
 *
 * SSE endpoints (no auth, read-only):
 *   GET /api/stream/status   — agent state + positions + PnL (every 5s)
 *   GET /api/stream/signals  — new signals from pipeline (event-driven)
 *   GET /api/stream/trades   — order fills + position changes (event-driven)
 *
 * Execution endpoints (bearer auth required):
 *   POST /api/execution/override/pause     — pause agent
 *   POST /api/execution/override/resume    — resume agent
 *   POST /api/execution/override/close-all — emergency close all positions + cancel orders
 *   DELETE /api/execution/order/:id        — cancel specific order
 */

import { Elysia, t } from 'elysia'
import { cors } from '@elysiajs/cors'
import { bearer } from '@elysiajs/bearer'
import type { CandleInterval } from '../types.js'
import { TIMEFRAMES } from '../config.js'
import {
  SERVER_PORT,
  SERVER_HOSTNAME,
  API_TOKEN_ENV,
  API_MAX_CANDLES,
  API_DEFAULT_CANDLE_COUNT,
  API_DEFAULT_JOURNAL_LIMIT,
  API_MAX_JOURNAL_LIMIT,
} from '../config.js'
import { getCandles } from '../feed/store.js'
import { getStatus, getActiveSetups } from '../scanner/pipeline.js'
import { analyzeStructure } from '../indicators/structure.js'
import { sql } from '../db/connection.js'
import { getAgent } from '../agent/trading-agent.js'
import { getOrderManager } from '../agent/order-manager.js'
import { getPositionMonitor } from '../agent/position-monitor.js'
import { closeAllPositions } from '../agent/close-all.js'
import { getHealthMonitor } from '../agent/self-healing.js'
import { getLiveMetrics } from '../analytics/metrics-service.js'
import { sseRoutes, startSSEBroadcasts, stopSSEBroadcasts } from './sse.js'
import { getConnectionCounts, getTotalConnections, closeAllConnections, broadcast, addClient, removeClient } from './sse-manager.js'
import { listRuns, loadRun, saveRun, compareRuns } from '../backtest/results-store.js'
import { runBacktestAsync, type BacktestProgress } from '../backtest/engine.js'
import { BacktestDataManager, computeHTFIntervals, computeHTFWarmupMs } from '../backtest/data-manager.js'
import type { BacktestConfig } from '../backtest/types.js'
import {
  MAX_BACKTEST_MONTHS,
  BACKTEST_SLIPPAGE_PCT,
  BACKTEST_COMMISSION_PCT,
} from '../config.js'
import * as CONFIG from '../config.js'
import { staticPlugin } from '@elysiajs/static'
import { join } from 'path'

const startedAt = Date.now()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateTimeframe(tf: string): tf is CandleInterval {
  return (TIMEFRAMES as readonly string[]).includes(tf)
}

function getApiToken(): string | null {
  return process.env[API_TOKEN_ENV] ?? null
}

// ─── Backtest Runner (Browser-triggered) ────────────────────────────────────

/** Concurrency guard: only 1 backtest at a time. */
let activeBacktestRunId: string | null = null

/** Expose for testing. */
export function getActiveBacktestRunId(): string | null {
  return activeBacktestRunId
}

/** Create SSE stream for backtest progress channel. */
function createBacktestSSEStream(): ReadableStream {
  let clientId: string | null = null
  return new ReadableStream({
    start(controller) {
      clientId = addClient('backtest', controller)
    },
    cancel() {
      if (clientId) removeClient(clientId)
    },
  })
}

/**
 * Run a browser-triggered backtest asynchronously.
 * Downloads data → runs engine → saves result → broadcasts progress via SSE.
 */
async function runBrowserBacktest(
  runId: string,
  coins: string[],
  timeframes: string[],
  months: number,
  initialCapital: number,
  name: string | null,
  strategy: 'layered' | 'quant' = 'layered',
): Promise<void> {
  try {
    // Phase 1: Download data
    broadcast('backtest', 'progress', { runId, pct: 0, bar: 0, total: 0, phase: 'downloading' })

    const dm = new BacktestDataManager()
    const endDate = new Date()
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)

    const typedTFs = timeframes as import('../types.js').CandleInterval[]
    const extraHTFs = computeHTFIntervals(typedTFs)

    for (const coin of coins) {
      for (const tf of typedTFs) {
        await dm.downloadHistory(coin, tf, startDate, endDate)
      }
      for (const htf of extraHTFs) {
        const warmupMs = computeHTFWarmupMs(htf)
        const htfStart = new Date(startDate.getTime() - warmupMs)
        await dm.downloadHistory(coin, htf, htfStart, endDate)
      }
    }

    // Phase 2: Load candles
    broadcast('backtest', 'progress', { runId, pct: 5, bar: 0, total: 0, phase: 'loading' })
    const candles = await dm.loadForBacktest(coins, typedTFs, startDate, endDate)

    // Phase 3: Run backtest with progress
    const config: BacktestConfig = {
      coins,
      timeframes: typedTFs,
      initialCapital,
      slippagePct: BACKTEST_SLIPPAGE_PCT,
      commissionPct: BACKTEST_COMMISSION_PCT,
      strategy,
    }

    const result = await runBacktestAsync(candles, config, (p: BacktestProgress) => {
      // Scale progress: 5–95% for replay, 95–100 for compute/done
      const scaledPct = 5 + Math.round(p.pct * 0.9)
      broadcast('backtest', 'progress', { runId, pct: scaledPct, bar: p.bar, total: p.total, phase: p.phase })
    })

    // Phase 4: Save result
    broadcast('backtest', 'progress', { runId, pct: 98, bar: 0, total: 0, phase: 'saving' })
    const savedId = await saveRun(result, name ?? `Browser run ${new Date().toISOString().slice(0, 16)}`)

    broadcast('backtest', 'progress', {
      runId,
      savedRunId: savedId,
      pct: 100,
      bar: 0,
      total: 0,
      phase: 'done',
      totalTrades: result.trades.length,
      netPnl: result.metrics.netPnl,
      winRate: result.metrics.winRate,
    })
  } catch (err) {
    broadcast('backtest', 'progress', {
      runId,
      pct: 0,
      bar: 0,
      total: 0,
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    activeBacktestRunId = null
  }
}

// ─── App Builder ─────────────────────────────────────────────────────────────

/**
 * Build the Elysia app instance (without listening).
 * Exported for in-process testing via app.handle().
 */
export function buildApp(): ReturnType<typeof createApp> {
  return createApp()
}

function createApp() {
  const app = new Elysia()
    .use(cors())
    .use(bearer())
    .onError(({ code, error, set }) => {
      if (code === 'VALIDATION') {
        set.status = 400
        return { error: 'validation_error', message: error.message }
      }
      if (code === 'NOT_FOUND') {
        set.status = 404
        return { error: 'not_found', message: 'Endpoint not found' }
      }
      set.status = 500
      return { error: 'internal_error', message: 'Internal server error' }
    })

    // ── Read endpoints (no auth) ─────────────────────────────────────────

    .get('/api/health', () => {
      const uptime = Math.floor((Date.now() - startedAt) / 1000)
      const statuses = getStatus()
      const coins = [...new Set(statuses.map(s => s.coin))]
      const health = getHealthMonitor().getReport()
      return {
        status: health.overall,
        uptime,
        coins: coins.length,
        coinList: coins,
        rssBytes: health.rssBytes,
        components: {
          feed: { status: health.components.feed.status, errors: health.components.feed.consecutiveErrors },
          db: { status: health.components.db.status, errors: health.components.db.consecutiveErrors },
          exchange: { status: health.components.exchange.status, errors: health.components.exchange.consecutiveErrors },
        },
      }
    })

    .get('/api/status', () => {
      return { statuses: getStatus() }
    })

    .get('/api/setups', () => {
      return { setups: getActiveSetups() }
    })

    .get('/api/candles/:coin/:tf', ({ params, query, set }) => {
      const { coin, tf } = params
      if (!validateTimeframe(tf)) {
        set.status = 400
        return { error: 'invalid_timeframe', message: `Invalid timeframe: ${tf}. Valid: ${TIMEFRAMES.join(', ')}` }
      }
      const count = Math.min(
        Math.max(1, Number(query.count) || API_DEFAULT_CANDLE_COUNT),
        API_MAX_CANDLES,
      )
      const candles = getCandles(coin.toUpperCase(), tf, count)
      return { coin: coin.toUpperCase(), tf, count: candles.length, candles }
    }, {
      params: t.Object({
        coin: t.String(),
        tf: t.String(),
      }),
      query: t.Object({
        count: t.Optional(t.Numeric()),
      }),
    })

    .get('/api/structure/:coin/:tf', ({ params, query, set }) => {
      const { coin, tf } = params
      if (!validateTimeframe(tf)) {
        set.status = 400
        return { error: 'invalid_timeframe', message: `Invalid timeframe: ${tf}. Valid: ${TIMEFRAMES.join(', ')}` }
      }
      const count = Math.min(
        Math.max(1, Number(query.count) || API_DEFAULT_CANDLE_COUNT),
        API_MAX_CANDLES,
      )
      const candles = getCandles(coin.toUpperCase(), tf, count)
      if (candles.length < 50) {
        return { coin: coin.toUpperCase(), tf, structure: { bias: 'neutral', biasConfidence: 0, swings: [], demandZones: [], supplyZones: [] } }
      }
      const structure = analyzeStructure(candles)
      return { coin: coin.toUpperCase(), tf, structure }
    }, {
      params: t.Object({
        coin: t.String(),
        tf: t.String(),
      }),
      query: t.Object({
        count: t.Optional(t.Numeric()),
      }),
    })

    // ── Agent endpoints (no auth, read-only) ──────────────────────────────

    .get('/api/agent/state', () => {
      return getAgent().getSnapshot()
    })

    .get('/api/agent/journal', async ({ query, set }) => {
      const limit = Math.min(
        Math.max(1, Number(query.limit) || API_DEFAULT_JOURNAL_LIMIT),
        API_MAX_JOURNAL_LIMIT,
      )
      const eventType = query.type ?? null

      try {
        const entries = eventType
          ? await sql`
              SELECT id, ts, event_type, coin, details, agent_state
              FROM trade_journal
              WHERE event_type = ${eventType}
              ORDER BY ts DESC
              LIMIT ${limit}
            `
          : await sql`
              SELECT id, ts, event_type, coin, details, agent_state
              FROM trade_journal
              ORDER BY ts DESC
              LIMIT ${limit}
            `
        return { entries, count: entries.length }
      } catch (err) {
        set.status = 503
        return { error: 'db_error', message: 'Database unavailable' }
      }
    }, {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
        type: t.Optional(t.String()),
      }),
    })

    .get('/api/agent/positions', () => {
      const pm = getPositionMonitor()
      const posMap = pm.getPositions()
      const positions = Array.from(posMap.values())
      const totalExposure = positions.reduce((sum, p) => sum + (p.size * p.entryPrice), 0)
      return { positions, totalExposure, count: positions.length }
    })

    // ── SSE endpoints (no auth, read-only) ─────────────────────────────

    .use(sseRoutes())

    // ── Analytics endpoints (no auth, read-only) ─────────────────────────

    .get('/api/metrics', async ({ set }) => {
      try {
        return await getLiveMetrics()
      } catch (err) {
        set.status = 503
        return { error: 'metrics_unavailable', message: 'Failed to compute metrics' }
      }
    })

    // ── Config endpoint (read-only) ────────────────────────────────────────

    .get('/api/config', () => {
      // Export all non-function config values grouped by category
      const groups: Record<string, Record<string, unknown>> = {}
      const skip = new Set(['TIMEFRAMES', 'TIMEFRAME_MS', 'HTF_MAP', 'CORRELATION_GROUPS', 'PATTERN_TTL_BARS', 'BACKFILL_CANDLE_COUNTS'])
      const arrayLike = new Set(['TIMEFRAMES'])

      for (const [key, value] of Object.entries(CONFIG)) {
        if (typeof value === 'function') continue

        // Group by prefix
        let group = 'general'
        if (key.startsWith('RISK') || key === 'RISK') group = 'risk'
        else if (key.startsWith('CIRCUIT_BREAKER') || key === 'CIRCUIT_BREAKER') group = 'circuit_breaker'
        else if (key.startsWith('TRAILING') || key.startsWith('PARTIAL') || key.startsWith('ATR_') || key.startsWith('MULTI_TP') || key.startsWith('MIN_TP') || key.startsWith('TRAIL_') || key.startsWith('DEFAULT_RISK') || key.startsWith('STRUCTURE_STOP') || key.startsWith('MAX_STOP') || key.startsWith('MAX_LEVERAGE') || key.startsWith('STOP_SLIPPAGE') || key.startsWith('MIN_POSITION') || key.startsWith('ZONE_RISK')) group = 'exit_strategy'
        else if (key.startsWith('BACKTEST') || key.startsWith('WF_') || key === 'PAPER_TRADE' || key === 'PAPER_SLIPPAGE_PCT') group = 'backtest'
        else if (key.startsWith('DB_')) group = 'database'
        else if (key.startsWith('WS_')) group = 'websocket'
        else if (key.startsWith('SERVER_') || key.startsWith('API_') || key.startsWith('SSE_')) group = 'server'
        else if (key.startsWith('FUNDING') || key.startsWith('DELTA') || key.startsWith('BOOK_') || key === 'OI_SPIKE_THRESHOLD' || key === 'MARK_ORACLE_DIVERGENCE_THRESHOLD') group = 'order_flow'
        else if (key.startsWith('RETRY') || key === 'RETRY') group = 'retry'
        else if (key.startsWith('HEALTH') || key === 'HEALTH') group = 'health'
        else if (key.startsWith('TELEGRAM') || key === 'TELEGRAM') group = 'telegram'
        else if (key.startsWith('CONFLUENCE') || key.startsWith('ZONE_MAX') || key.startsWith('HTF_') || key === 'MIN_CONFIDENCE' || key === 'REGIME_MULTIPLIERS') group = 'pipeline'
        else if (key.startsWith('BACKFILL') || key.startsWith('REST_') || key.startsWith('STALENESS') || key.startsWith('STATUS_') || key.startsWith('COIN_') || key.startsWith('TOP_COINS') || key.startsWith('MIN_24H') || key.startsWith('HIP3') || key.startsWith('FALLBACK') || key === 'INDICATOR_WINDOW' || key === 'VP_BINS' || key === 'VP_VALUE_AREA_PCT' || key === 'MIN_CANDLES_FOR_SCAN') group = 'feed'
        else if (key.startsWith('ORDER_') || key.startsWith('MAX_ORDERS') || key.startsWith('SL_IS') || key.startsWith('TP_IS') || key.startsWith('EXCHANGE_SYNC') || key.startsWith('TRAIL_UPDATE')) group = 'orders'

        if (!groups[group]) groups[group] = {}
        groups[group][key] = value
      }

      return { groups }
    })

    // ── Backtest endpoints (read-only) ──────────────────────────────────────

    .get('/api/backtest/runs', async ({ query, set }) => {
      const limit = Math.min(Math.max(1, Number(query.limit) || 50), 200)
      try {
        const runs = await listRuns(limit)
        return { runs, count: runs.length }
      } catch {
        set.status = 503
        return { error: 'db_error', message: 'Database unavailable' }
      }
    }, {
      query: t.Object({
        limit: t.Optional(t.Numeric()),
      }),
    })

    .get('/api/backtest/runs/:id', async ({ params, set }) => {
      try {
        const run = await loadRun(params.id)
        if (!run) {
          set.status = 404
          return { error: 'not_found', message: `Run ${params.id} not found` }
        }
        return { run }
      } catch {
        set.status = 503
        return { error: 'db_error', message: 'Database unavailable' }
      }
    }, {
      params: t.Object({ id: t.String() }),
    })

    .get('/api/backtest/compare', async ({ query, set }) => {
      const { a, b } = query
      if (!a || !b) {
        set.status = 400
        return { error: 'missing_params', message: 'Both a and b run IDs are required' }
      }
      if (a === b) {
        set.status = 400
        return { error: 'same_runs', message: 'Cannot compare a run with itself' }
      }
      try {
        const result = await compareRuns(a, b)
        if (!result) {
          set.status = 404
          return { error: 'not_found', message: 'One or both runs not found' }
        }
        return { comparison: result }
      } catch {
        set.status = 503
        return { error: 'db_error', message: 'Database unavailable' }
      }
    }, {
      query: t.Object({
        a: t.String(),
        b: t.String(),
      }),
    })

    // ── Backtest run endpoint (no auth — U4: read-only computation) ──────

    .post('/api/backtest/run', async ({ body, set }) => {
      // Concurrency guard
      if (activeBacktestRunId) {
        set.status = 409
        return { error: 'backtest_running', message: `Backtest ${activeBacktestRunId} already in progress` }
      }

      const { coins, timeframes, months, initialCapital, name, strategy } = body

      // Validate months cap
      if (months > MAX_BACKTEST_MONTHS) {
        set.status = 400
        return { error: 'too_long', message: `Max ${MAX_BACKTEST_MONTHS} months allowed` }
      }

      if (coins.length === 0 || timeframes.length === 0) {
        set.status = 400
        return { error: 'invalid_config', message: 'coins and timeframes must not be empty' }
      }

      const runId = crypto.randomUUID()
      activeBacktestRunId = runId

      // Fire-and-forget — progress via SSE
      runBrowserBacktest(runId, coins, timeframes, months, initialCapital, name ?? null, (strategy as 'layered' | 'quant') ?? 'layered')

      return { runId }
    }, {
      body: t.Object({
        coins: t.Array(t.String(), { minItems: 1 }),
        timeframes: t.Array(t.String(), { minItems: 1 }),
        months: t.Number({ minimum: 1, maximum: 12 }),
        initialCapital: t.Number({ minimum: 100 }),
        name: t.Optional(t.String()),
        strategy: t.Optional(t.String()),
      }),
    })

    // ── Backtest progress SSE stream ────────────────────────────────────

    .get('/api/backtest/progress', () => {
      return new Response(createBacktestSSEStream(), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    })

    // ── Execution endpoints (bearer auth required) ────────────────────────

    .group('/api/execution', (app) =>
      app
        .onBeforeHandle(({ bearer: token, set }) => {
          const expected = getApiToken()
          if (!expected) {
            set.status = 503
            return { error: 'auth_not_configured', message: `Set ${API_TOKEN_ENV} environment variable` }
          }
          if (!token || token !== expected) {
            set.status = 401
            return { error: 'unauthorized', message: 'Invalid or missing bearer token' }
          }
        })

        .post('/override/pause', () => {
          getAgent().pauseAll('manual override via API')
          return { ok: true, action: 'pause' }
        })

        .post('/override/resume', () => {
          getAgent().resumeAll()
          return { ok: true, action: 'resume' }
        })

        .post('/override/close-all', async () => {
          const result = await closeAllPositions('emergency close-all via API')
          return { ok: true, action: 'close-all', ...result }
        })

        .delete('/order/:id', async ({ params, set }) => {
          try {
            const om = getOrderManager()
            const order = await om.getOrder(params.id)
            if (!order) {
              set.status = 404
              return { ok: false, error: 'not_found', orderId: params.id }
            }
            if (order.status !== 'pending' && order.status !== 'submitted') {
              set.status = 409
              return { ok: false, error: 'not_cancellable', orderId: params.id, status: order.status }
            }
            await om.cancelOrder(params.id, 'cancelled via API')
            return { ok: true, action: 'cancel', orderId: params.id }
          } catch {
            set.status = 404
            return { ok: false, error: 'not_found', orderId: params.id }
          }
        }, {
          params: t.Object({ id: t.String() }),
        })
    )

    // ── Dashboard static files (serve built React app) ──────────────────
    // Serves from dashboard/dist/ — Vite build output
    // Falls back to index.html for client-side routing

  try {
    const dashboardPath = join(import.meta.dir, '../../dashboard/dist')
    app.use(staticPlugin({
      assets: dashboardPath,
      prefix: '/',
      alwaysStatic: false,
    }))
  } catch {
    // Dashboard not built yet — skip static serving
  }

  return app
}

// ─── Start Server ────────────────────────────────────────────────────────────

/**
 * Start the Elysia server (binds to port).
 * Call from index.ts after DB + feed are initialized.
 */
export async function startServer(): Promise<void> {
  const app = buildApp()
  app.listen({ port: SERVER_PORT, hostname: SERVER_HOSTNAME })
  startSSEBroadcasts()
  console.log(`[SERVER] Elysia listening on http://${SERVER_HOSTNAME}:${SERVER_PORT}`)
}

/** Stop SSE broadcasts + close connections (for graceful shutdown). */
export function stopServer(): void {
  stopSSEBroadcasts()
  closeAllConnections()
}
