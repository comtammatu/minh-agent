import { render, screen, waitFor } from '@testing-library/react'
import { App } from '@/app'

describe('App', () => {
  it('renders overview shell from snapshot API', async () => {
    window.history.pushState({}, '', '/dashboard/')
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/dashboard/snapshot')) {
        return new Response(JSON.stringify({
          bootstrap: { phase: 'ready', trackedCoins: ['BTC'] },
          mode: { exchange: 'HL', paperTrade: false },
          health: {
            overall: 'ok',
            uptime: 120,
            rssBytes: 1_000_000,
            components: {
              feed: { status: 'ok', consecutiveErrors: 0 },
              db: { status: 'ok', consecutiveErrors: 0 },
              exchange: { status: 'ok', consecutiveErrors: 0 },
            },
          },
          account: {
            source: 'live',
            balance: 1000,
            equity: 1010,
            available: 900,
            marginUsed: 100,
            withdrawable: null,
            spotUsdcBalance: null,
            unrealizedPnl: 10,
            wins: 2,
            losses: 1,
            tradeCount: 3,
            winRate: 2 / 3,
          },
          positions: [],
          watchlist: [],
          activeSetups: [],
          summaryMetrics: {
            winRate: { daily: 0.5, weekly: 0.5, monthly: 0.5, allTime: 0.5 },
            pnl: { daily: 10, weekly: 20, monthly: 30, allTime: 40 },
            trades: { daily: 1, weekly: 2, monthly: 3, allTime: 4 },
            currentDrawdown: 0.1,
            maxDrawdown: 0.2,
            openPositionCount: 0,
          },
          recentJournal: [],
        }))
      }
      return new Response(JSON.stringify({ rows: [] }))
    }) as typeof fetch

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Read-only ops console')).toBeInTheDocument()
      expect(screen.getByText('Live exposure')).toBeInTheDocument()
    })
  })
})
