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
import { sql } from '../db/connection.js'
import { getAgent } from '../agent/trading-agent.js'
import { getOrderManager } from '../agent/order-manager.js'
import { getPositionMonitor } from '../agent/position-monitor.js'
import { getHealthMonitor } from '../agent/self-healing.js'

const startedAt = Date.now()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateTimeframe(tf: string): tf is CandleInterval {
  return (TIMEFRAMES as readonly string[]).includes(tf)
}

function getApiToken(): string | null {
  return process.env[API_TOKEN_ENV] ?? null
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
          const agent = getAgent()
          const om = getOrderManager()
          const pm = getPositionMonitor()

          // Pause agent first to prevent new entries
          agent.pauseAll('emergency close-all via API')

          // Cancel all pending orders
          const orders = om.getOrders()
          let cancelled = 0
          for (const [id, order] of orders) {
            if (order.status === 'pending' || order.status === 'submitted') {
              await om.cancelOrder(id, 'emergency close-all')
              cancelled++
            }
          }

          // Close all open positions via OrderManager
          const positions = pm.getPositions()
          let closed = 0
          for (const [posId] of positions) {
            await om.handleAction({ type: 'close_position', positionId: posId, reason: 'emergency close-all' })
            closed++
          }

          return { ok: true, action: 'close-all', cancelled, closed }
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
  console.log(`[SERVER] Elysia listening on http://${SERVER_HOSTNAME}:${SERVER_PORT}`)
}
