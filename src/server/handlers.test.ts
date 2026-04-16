import { describe, expect, it } from 'bun:test'
import { DASHBOARD_CHART_HISTORY_BATCH_SIZE } from '../config.js'
import { clearStore } from '../feed/store.js'
import type { TuiDataSources } from '../ui/tui.jsx'
import { createDashboardFetchHandler } from './handlers.js'
import type { DashboardServerState } from './contracts.js'

function createSources(): TuiDataSources {
  return {
    getAgentSnapshot: () => ({
      global: { dailyPnl: 10, totalConsecutiveLosses: 0, globalPaused: false, globalPauseReason: null, uptime: 1_000 },
      coins: {},
    }),
    getPositions: () => new Map([
      ['pos-1', {
        positionId: 'pos-1',
        coin: 'BTC',
        side: 'long' as const,
        leverage: 3,
        currentSize: 1,
        entryPrice: 100,
        slPrice: 95,
        tpPrice: 110,
      }],
    ]),
    getStatus: () => [{
      coin: 'BTC',
      interval: '1h',
      regime: 'BULL' as const,
      bias: 'bullish',
      biasConfidence: 0.7,
      confluenceGrade: 'A' as const,
      activeCount: 1,
      lastUpdateAt: Date.now(),
    }],
    getHealthReport: () => ({
      overall: 'ok',
      uptime: 10,
      rssBytes: 100_000,
      components: {
        feed: { status: 'ok', lastSuccessAt: 1, lastErrorAt: 0, lastError: null, consecutiveErrors: 0 },
        db: { status: 'ok', lastSuccessAt: 1, lastErrorAt: 0, lastError: null, consecutiveErrors: 0 },
        exchange: { status: 'ok', lastSuccessAt: 1, lastErrorAt: 0, lastError: null, consecutiveErrors: 0 },
      },
    }),
    getAccountState: () => Promise.resolve({
      effectiveBalance: 1_000,
      accountValue: 1_050,
      spotUsdcBalance: 500,
      totalMarginUsed: 100,
      withdrawable: 900,
    }),
    getSubscriptionCount: () => 12,
    getTrackedCoins: () => ['BTC'],
    getPaperStats: () => null,
    getLiveWalletStats: () => ({
      wallets: [{ label: 'smc-sd', wins: 2, losses: 1, tradeCount: 3, winRate: 2 / 3 }],
      wins: 2,
      losses: 1,
      tradeCount: 3,
      winRate: 2 / 3,
    }),
    getLiveAccountStates: () => null,
    getAssetPrice: () => ({ markPrice: 102, funding: 0.001, dayChangePctUtc: 1.5 }),
    getActiveSetups: () => [{
      id: 'BTC|1h|smc-sd',
      coin: 'BTC',
      interval: '1h',
      type: 'smc-sd',
      side: 'long' as const,
      confidence: 0.85,
      entryPrice: 100,
      slPrice: 95,
      tpPrice: 110,
      patternData: {},
      detectedAt: Date.now(),
      detectedAtBar: 10,
      expiresAtBar: 20,
      exchange: 'HL' as const,
    }],
    getInvalidationStats: () => ({ total: 0, matched: 0, skipped: 0, parseFailed: 0, actions: {}, byStrategy: {} }),
  }
}

function createState(): DashboardServerState {
  return {
    activeExchange: 'HL',
    getBootstrapPhase: () => 'warming_up',
    sources: createSources(),
  }
}

describe('createDashboardFetchHandler', () => {
  const handler = createDashboardFetchHandler({
    state: createState(),
    getSummaryMetrics: async () => ({
      winRate: { daily: 0.5, weekly: 0.5, monthly: 0.5, allTime: 0.5 },
      pnl: { daily: 10, weekly: 20, monthly: 30, allTime: 40 },
      trades: { daily: 1, weekly: 2, monthly: 3, allTime: 4 },
      patternMetrics: [],
      coinMetrics: [],
      currentDrawdown: 0.1,
      maxDrawdown: 0.2,
      openPositionCount: 1,
    }),
    readJournal: async (filter) => [{
      id: 1,
      ts: new Date('2026-04-16T00:00:00Z'),
      eventType: filter?.eventType ?? 'signal',
      coin: filter?.coin ?? 'BTC',
      details: { side: 'long', interval: '1h', pnl: 12 },
      agentState: 'WATCHING',
      exchange: 'HL',
    }],
    readCandlesBefore: async () => [
      { t: 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 2_000, o: 2, h: 3, l: 1.5, c: 2.5, v: 10 },
    ],
    readLatestCandle: async () => ({ t: 2_000, o: 2, h: 3, l: 1.5, c: 2.5, v: 10 }),
    distDir: '/tmp/does-not-matter',
  })

  it('serves snapshot route with warming_up state', async () => {
    const response = await handler(new Request('http://localhost/api/dashboard/snapshot'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.bootstrap.phase).toBe('warming_up')
    expect(body.positions).toHaveLength(1)
  })

  it('filters journal rows by coin and eventType', async () => {
    const response = await handler(new Request('http://localhost/api/dashboard/journal?coin=BTC&eventType=exit&limit=5'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.rows[0].eventType).toBe('exit')
    expect(body.rows[0].coin).toBe('BTC')
  })

  it('returns chart history in ascending order', async () => {
    const response = await handler(new Request('http://localhost/api/chart/history?ticker=HL:BTC&resolution=60&from=0&to=10&countBack=2'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.bars.map((bar: { time: number }) => bar.time)).toEqual([1, 2])
  })

  it('uses the fixed chart history batch size even when the client requests more', async () => {
    clearStore()
    let requestedCount = 0
    const batchedHandler = createDashboardFetchHandler({
      state: createState(),
      readJournal: async () => [],
      readCandlesBefore: async (_coin, _interval, _beforeMs, count) => {
        requestedCount = count
        return [
          { t: 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
          { t: 2_000, o: 2, h: 3, l: 1.5, c: 2.5, v: 10 },
        ]
      },
      readLatestCandle: async () => null,
      distDir: '/tmp/does-not-matter',
    })

    const response = await batchedHandler(
      new Request('http://localhost/api/chart/history?ticker=HL:BTC&resolution=60&from=0&to=10&countBack=5000'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.bars).toHaveLength(2)
    expect(requestedCount).toBe(DASHBOARD_CHART_HISTORY_BATCH_SIZE + 8)
  })

  it('returns latest bar route', async () => {
    const response = await handler(new Request('http://localhost/api/chart/latest?ticker=HL:BTC&resolution=60'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.bar.time).toBeGreaterThan(0)
  })

  it('returns marks and lines overlay route', async () => {
    const response = await handler(new Request('http://localhost/api/chart/overlays?ticker=HL:BTC'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.marks.length).toBeGreaterThan(0)
    expect(body.lines.length).toBeGreaterThan(0)
  })
})
