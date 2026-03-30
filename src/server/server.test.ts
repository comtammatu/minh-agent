/**
 * Elysia HTTP server tests.
 * Uses app.handle() for in-process testing — no port binding, no flaky conflicts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { buildApp } from './index.js'
import { setCandles, clearStore } from '../feed/store.js'
import { clearPipelineState } from '../scanner/pipeline.js'
import { resetAgent } from '../agent/trading-agent.js'
import type { Candle } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandle(t: number, c = 100): Candle {
  return { t, o: c - 1, h: c + 1, l: c - 2, c, v: 1000 }
}

async function get(app: ReturnType<typeof buildApp>, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`))
}

async function post(app: ReturnType<typeof buildApp>, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers }))
}

async function del(app: ReturnType<typeof buildApp>, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return app.handle(new Request(`http://localhost${path}`, { method: 'DELETE', headers }))
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Elysia HTTP Server', () => {
  let app: ReturnType<typeof buildApp>

  beforeAll(() => {
    app = buildApp()
  })

  beforeEach(() => {
    clearStore()
    clearPipelineState()
    resetAgent()
  })

  // ── Health endpoint ──────────────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('returns status ok with uptime', async () => {
      const res = await get(app, '/api/health')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.status).toBe('ok')
      expect(typeof body.uptime).toBe('number')
      expect(body.coins).toBe(0)
      expect(body.coinList).toEqual([])
    })
  })

  // ── Status endpoint ──────────────────────────────────────────────────────

  describe('GET /api/status', () => {
    it('returns empty statuses when no data', async () => {
      const res = await get(app, '/api/status')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.statuses).toEqual([])
    })
  })

  // ── Setups endpoint ──────────────────────────────────────────────────────

  describe('GET /api/setups', () => {
    it('returns empty setups when none active', async () => {
      const res = await get(app, '/api/setups')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.setups).toEqual([])
    })
  })

  // ── Candles endpoint ─────────────────────────────────────────────────────

  describe('GET /api/candles/:coin/:tf', () => {
    it('returns candles for valid coin/tf', async () => {
      const candles = Array.from({ length: 10 }, (_, i) => makeCandle(1000 + i * 60000, 100 + i))
      setCandles('BTC', '1h', candles)

      const res = await get(app, '/api/candles/BTC/1h')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.coin).toBe('BTC')
      expect(body.tf).toBe('1h')
      expect(body.count).toBe(10)
      expect(Array.isArray(body.candles)).toBe(true)
    })

    it('respects ?count parameter', async () => {
      const candles = Array.from({ length: 50 }, (_, i) => makeCandle(1000 + i * 60000))
      setCandles('ETH', '5m', candles)

      const res = await get(app, '/api/candles/ETH/5m?count=5')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.count).toBe(5)
    })

    it('uppercases coin name', async () => {
      setCandles('SOL', '1h', [makeCandle(1000)])

      const res = await get(app, '/api/candles/sol/1h')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.coin).toBe('SOL')
      expect(body.count).toBe(1)
    })

    it('returns empty array for unknown coin', async () => {
      const res = await get(app, '/api/candles/UNKNOWN/1h')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.count).toBe(0)
      expect(body.candles).toEqual([])
    })

    it('rejects invalid timeframe', async () => {
      const res = await get(app, '/api/candles/BTC/3m')
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toBe('invalid_timeframe')
    })

    it('clamps count to max', async () => {
      const candles = Array.from({ length: 10 }, (_, i) => makeCandle(1000 + i * 60000))
      setCandles('BTC', '1h', candles)

      const res = await get(app, '/api/candles/BTC/1h?count=99999')
      expect(res.status).toBe(200)
      const body = await json(res)
      // Should return all 10 (clamped to API_MAX_CANDLES=5000, but only 10 exist)
      expect(body.count).toBe(10)
    })
  })

  // ── Agent state endpoint ─────────────────────────────────────────────────

  describe('GET /api/agent/state', () => {
    it('returns agent snapshot', async () => {
      const res = await get(app, '/api/agent/state')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.coins).toBeDefined()
      expect(body.global).toBeDefined()
      const global = body.global as Record<string, unknown>
      expect(global.dailyPnl).toBe(0)
      expect(global.globalPaused).toBe(false)
      expect(typeof global.uptime).toBe('number')
    })
  })

  // ── Agent positions endpoint ─────────────────────────────────────────────

  describe('GET /api/agent/positions', () => {
    it('returns stub positions', async () => {
      const res = await get(app, '/api/agent/positions')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.positions).toEqual([])
      expect(body.totalExposure).toBe(0)
    })
  })

  // ── Execution endpoints (auth) ───────────────────────────────────────────

  describe('Execution endpoints (bearer auth)', () => {
    const TEST_TOKEN = 'test-secret-token-12345'

    describe('when MINH_API_TOKEN is not set', () => {
      beforeEach(() => {
        delete process.env.MINH_API_TOKEN
      })

      it('returns 503 when token env not configured', async () => {
        const res = await post(app, '/api/execution/override/pause', 'any-token')
        expect(res.status).toBe(503)
        const body = await json(res)
        expect(body.error).toBe('auth_not_configured')
      })
    })

    describe('when MINH_API_TOKEN is set', () => {
      beforeEach(() => {
        process.env.MINH_API_TOKEN = TEST_TOKEN
      })

      afterAll(() => {
        delete process.env.MINH_API_TOKEN
      })

      it('rejects request without token', async () => {
        const res = await post(app, '/api/execution/override/pause')
        expect(res.status).toBe(401)
        const body = await json(res)
        expect(body.error).toBe('unauthorized')
      })

      it('rejects request with wrong token', async () => {
        const res = await post(app, '/api/execution/override/pause', 'wrong-token')
        expect(res.status).toBe(401)
      })

      it('accepts request with correct token — pause', async () => {
        const res = await post(app, '/api/execution/override/pause', TEST_TOKEN)
        expect(res.status).toBe(200)
        const body = await json(res)
        expect(body.ok).toBe(true)
        expect(body.action).toBe('pause')
      })

      it('accepts request with correct token — resume', async () => {
        const res = await post(app, '/api/execution/override/resume', TEST_TOKEN)
        expect(res.status).toBe(200)
        const body = await json(res)
        expect(body.action).toBe('resume')
      })

      it('accepts request with correct token — close-all', async () => {
        const res = await post(app, '/api/execution/override/close-all', TEST_TOKEN)
        expect(res.status).toBe(200)
        const body = await json(res)
        expect(body.action).toBe('close-all')
      })

      it('accepts DELETE /api/execution/order/:id with correct token', async () => {
        const res = await del(app, '/api/execution/order/abc-123', TEST_TOKEN)
        expect(res.status).toBe(200)
        const body = await json(res)
        expect(body.action).toBe('cancel')
        expect(body.orderId).toBe('abc-123')
      })

      it('rejects DELETE /api/execution/order/:id without token', async () => {
        const res = await del(app, '/api/execution/order/abc-123')
        expect(res.status).toBe(401)
      })
    })
  })

  // ── 404 handling ─────────────────────────────────────────────────────────

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await get(app, '/api/nonexistent')
      expect(res.status).toBe(404)
    })
  })
})
