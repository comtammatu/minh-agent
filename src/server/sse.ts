/**
 * SSE Endpoints — real-time data streams for dashboard.
 *
 * Sprint 3 S7:
 *   GET /api/stream/status  — agent state + positions + PnL (periodic, every SSE_STATUS_INTERVAL_MS)
 *   GET /api/stream/signals — new signals as pipeline emits them (event-driven)
 *   GET /api/stream/trades  — order fills + position changes (event-driven)
 *
 * All SSE endpoints are read-only, no auth required (same as existing GET routes).
 * SSE keepalive every 30s to prevent proxy/browser timeout.
 */

import { Elysia } from 'elysia'
import { addClient, removeClient, broadcast, sendKeepalive, type SSEChannel } from './sse-manager.js'
import { getAgent } from '../agent/trading-agent.js'
import { getPositionMonitor } from '../agent/position-monitor.js'
import { getHealthMonitor } from '../agent/self-healing.js'
import { SSE_STATUS_INTERVAL_MS, SSE_KEEPALIVE_INTERVAL_MS } from '../config.js'
import { getCandles } from '../feed/store.js'
import { log } from '../lib/logger.js'

// ─── SSE Response Helper ────────────────────────────────────────────────────

/**
 * Create a ReadableStream for SSE with proper cleanup on disconnect.
 */
function createSSEStream(channel: SSEChannel): ReadableStream {
  let clientId: string | null = null

  return new ReadableStream({
    start(controller) {
      clientId = addClient(channel, controller)
    },
    cancel() {
      if (clientId) removeClient(clientId)
    },
  })
}

// ─── Status Push (Periodic) ─────────────────────────────────────────────────

/** Build status snapshot for SSE push. */
function buildStatusPayload(): object {
  const agent = getAgent()
  const snapshot = agent.getSnapshot()
  const pm = getPositionMonitor()
  const positions = Array.from(pm.getPositions().values())
  const health = getHealthMonitor().getReport()

  return {
    agent: snapshot,
    positions: positions.map(p => {
      // Compute unrealized PnL from latest candle price
      const candles = getCandles(p.coin, '1m', 1)
      const lastPrice = candles.length > 0 ? candles[candles.length - 1].c : p.entryPrice
      const direction = p.side === 'long' ? 1 : -1
      const unrealizedPnl = direction * (lastPrice - p.entryPrice) * p.currentSize

      return {
        id: p.positionId,
        coin: p.coin,
        side: p.side,
        size: p.currentSize,
        originalSize: p.originalSize,
        entryPrice: p.entryPrice,
        slPrice: p.slPrice,
        tpPrice: p.tpPrice,
        unrealizedPnl,
        trailingActive: p.trailingState?.active ?? false,
        openedAt: p.openedAt,
        partialClosesFired: p.partialClosesFired.length,
      }
    }),
    health: {
      overall: health.overall,
      rssBytes: health.rssBytes,
    },
    ts: Date.now(),
  }
}

let statusInterval: ReturnType<typeof setInterval> | null = null
let keepaliveInterval: ReturnType<typeof setInterval> | null = null

/** Start periodic status broadcast + keepalive. Call once at server startup. */
export function startSSEBroadcasts(): void {
  if (statusInterval) return // already running

  statusInterval = setInterval(() => {
    try {
      broadcast('status', 'status', buildStatusPayload())
    } catch (err) {
      log.error('sse', `Status broadcast error: ${(err as Error).message}`)
    }
  }, SSE_STATUS_INTERVAL_MS)

  keepaliveInterval = setInterval(() => {
    sendKeepalive()
  }, SSE_KEEPALIVE_INTERVAL_MS)

  log.info('sse', `SSE broadcasts started (status every ${SSE_STATUS_INTERVAL_MS / 1000}s, keepalive every ${SSE_KEEPALIVE_INTERVAL_MS / 1000}s)`)
}

/** Stop all SSE periodic broadcasts. */
export function stopSSEBroadcasts(): void {
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval)
    keepaliveInterval = null
  }
}

// ─── Signal & Trade Broadcasting (Event-Driven) ─────────────────────────────

/**
 * Wire pipeline + agent events to SSE channels.
 * Call once at startup after agent and pipeline are wired.
 * Accepts emitter as parameter (same pattern as agent/bridge wiring).
 */
export function wireSSEEvents(pipelineEmitter: import('events').EventEmitter): void {
  // Pipeline → signals channel
  pipelineEmitter.on('setup', (setup: unknown) => {
    broadcast('signals', 'setup', setup)
  })

  pipelineEmitter.on('invalidation', (id: string, reason: string) => {
    broadcast('signals', 'invalidation', { id, reason, ts: Date.now() })
  })

  // Agent → trades channel
  const agent = getAgent()
  agent.onAction((action: unknown) => {
    broadcast('trades', 'action', action)
  })

  log.info('sse', 'SSE events wired: pipeline→signals, agent→trades')
}

// ─── Elysia SSE Plugin ─────────────────────────────────────────────────────

/**
 * SSE route plugin for Elysia.
 * Mount via: app.use(sseRoutes())
 */
export function sseRoutes() {
  return new Elysia({ prefix: '/api/stream' })
    .get('/status', () => {
      return new Response(createSSEStream('status'), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    })

    .get('/signals', () => {
      return new Response(createSSEStream('signals'), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    })

    .get('/trades', () => {
      return new Response(createSSEStream('trades'), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    })
}
