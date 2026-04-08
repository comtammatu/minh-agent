/**
 * BybitExchangeService tests.
 *
 * Mocks bybit-api RestClientV5 — no real network calls.
 * Tests: init (with/without env vars), exchangeId, placeOrder, cancelOrder, getPositions, getAccountState.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

// ── Mock bybit-api ────────────────────────────────────────────────────────────

let mockSubmitOrder = mock(() =>
  Promise.resolve({ retCode: 0, retMsg: 'OK', result: { orderId: 'bb-123', orderLinkId: '' } }),
)
let mockCancelOrder = mock(() =>
  Promise.resolve({ retCode: 0, retMsg: 'OK', result: { orderId: 'bb-123', orderLinkId: '' } }),
)
let mockGetPositionInfo = mock(() =>
  Promise.resolve({
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          side: 'Buy',
          size: '0.1',
          avgPrice: '50000',
          unrealisedPnl: '500',
          liqPrice: '45000',
          leverage: '5',
          positionIdx: 0,
        },
      ],
    },
  }),
)
let mockGetWalletBalance = mock(() =>
  Promise.resolve({
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          accountType: 'UNIFIED',
          totalEquity: '10000',
          totalWalletBalance: '9500',
          totalMarginBalance: '9800',
          totalAvailableBalance: '8000',
          totalPerpUPL: '500',
          totalInitialMargin: '1500',
          totalMaintenanceMargin: '750',
          accountLTV: '0.1',
          accountIMRate: '0.15',
          accountMMRate: '0.075',
          accountIMRateByMp: '0.15',
          accountMMRateByMp: '0.075',
          totalInitialMarginByMp: '1500',
          totalMaintenanceMarginByMp: '750',
          coin: [
            {
              coin: 'USDC',
              equity: '300',
              usdValue: '300',
              walletBalance: '300',
              free: '300',
              locked: '0',
              borrowAmount: '0',
              availableToBorrow: '0',
              availableToWithdraw: '300',
              accruedInterest: '0',
              totalOrderIM: '0',
              totalPositionIM: '0',
              totalPositionMM: '0',
              unrealisedPnl: '0',
              cumRealisedPnl: '0',
              bonus: '0',
              marginCollateral: true,
              collateralSwitch: true,
              spotBorrow: '0',
            },
          ],
        },
      ],
    },
  }),
)

mock.module('bybit-api', () => ({
  RestClientV5: class MockRestClientV5 {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock constructor params
    constructor(_params: any) {}
    submitOrder = mockSubmitOrder
    cancelOrder = mockCancelOrder
    getPositionInfo = mockGetPositionInfo
    getWalletBalance = mockGetWalletBalance
  },
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BybitExchangeService', () => {
  beforeEach(() => {
    process.env['BYBIT_API_KEY'] = 'test-key'
    process.env['BYBIT_API_SECRET'] = 'test-secret'
    process.env['BYBIT_TESTNET'] = 'true'

    // Reset mocks to defaults
    mockSubmitOrder = mock(() =>
      Promise.resolve({ retCode: 0, retMsg: 'OK', result: { orderId: 'bb-123', orderLinkId: '' } }),
    )
    mockCancelOrder = mock(() =>
      Promise.resolve({ retCode: 0, retMsg: 'OK', result: { orderId: 'bb-123', orderLinkId: '' } }),
    )
    mockGetPositionInfo = mock(() =>
      Promise.resolve({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [
            {
              symbol: 'BTCUSDT',
              side: 'Buy',
              size: '0.1',
              avgPrice: '50000',
              unrealisedPnl: '500',
              liqPrice: '45000',
              leverage: '5',
              positionIdx: 0,
            },
          ],
        },
      }),
    )
    mockGetWalletBalance = mock(() =>
      Promise.resolve({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [
            {
              accountType: 'UNIFIED',
              totalEquity: '10000',
              totalWalletBalance: '9500',
              totalMarginBalance: '9800',
              totalAvailableBalance: '8000',
              totalPerpUPL: '500',
              totalInitialMargin: '1500',
              totalMaintenanceMargin: '750',
              accountLTV: '0.1',
              accountIMRate: '0.15',
              accountMMRate: '0.075',
              accountIMRateByMp: '0.15',
              accountMMRateByMp: '0.075',
              totalInitialMarginByMp: '1500',
              totalMaintenanceMarginByMp: '750',
              coin: [
                {
                  coin: 'USDC',
                  equity: '300',
                  usdValue: '300',
                  walletBalance: '300',
                  free: '300',
                  locked: '0',
                  borrowAmount: '0',
                  availableToBorrow: '0',
                  availableToWithdraw: '300',
                  accruedInterest: '0',
                  totalOrderIM: '0',
                  totalPositionIM: '0',
                  totalPositionMM: '0',
                  unrealisedPnl: '0',
                  cumRealisedPnl: '0',
                  bonus: '0',
                  marginCollateral: true,
                  collateralSwitch: true,
                  spotBorrow: '0',
                },
              ],
            },
          ],
        },
      }),
    )
  })

  // ── Init ──────────────────────────────────────────────────────────────────

  describe('init', () => {
    it('succeeds with valid env', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()
      expect(svc.exchangeId).toBe('BB')
    })

    it('throws when BYBIT_API_KEY missing', async () => {
      delete process.env['BYBIT_API_KEY']
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await expect(svc.init()).rejects.toThrow('BYBIT_API_KEY')
    })

    it('throws when BYBIT_API_SECRET missing', async () => {
      delete process.env['BYBIT_API_SECRET']
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await expect(svc.init()).rejects.toThrow('BYBIT_API_SECRET')
    })

    it('is idempotent (safe to call multiple times)', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()
      await svc.init() // should not throw
      expect(svc.exchangeId).toBe('BB')
    })
  })

  // ── exchangeId ────────────────────────────────────────────────────────────

  it('exchangeId is BB', async () => {
    const { BybitExchangeService } = await import('./bybit-exchange-service.js')
    const svc = new BybitExchangeService()
    expect(svc.exchangeId).toBe('BB')
  })

  // ── placeOrder ────────────────────────────────────────────────────────────

  describe('placeOrder', () => {
    it('places a market long order and returns orderId', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.placeOrder({
        coin: 'BTC',
        side: 'long',
        type: 'market',
        price: 50000,
        size: 0.1,
        reduceOnly: false,
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeNull()
      expect(result.status).toBe('submitted')
    })

    it('places a limit short order', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.placeOrder({
        coin: 'ETH',
        side: 'short',
        type: 'limit',
        price: 3000,
        size: 1,
        reduceOnly: true,
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeNull()
    })

    it('returns error when Bybit API returns non-zero retCode', async () => {
      mockSubmitOrder = mock(() =>
        Promise.resolve({ retCode: 10001, retMsg: 'Insufficient margin', result: { orderId: '', orderLinkId: '' } }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.placeOrder({
        coin: 'BTC',
        side: 'long',
        type: 'market',
        price: 50000,
        size: 0.1,
        reduceOnly: false,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Insufficient margin')
    })

    it('includes SL/TP when BybitOrderParams are provided', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.placeOrder({
        coin: 'BTC',
        side: 'long',
        type: 'limit',
        price: 50000,
        size: 0.1,
        reduceOnly: false,
        slPrice: 49000,
        tpPrice: 52000,
      })

      expect(result.success).toBe(true)
    })
  })

  // ── cancelOrder ───────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('cancels by orderId successfully', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.cancelOrder('BTC', 'bb-123')
      expect(result.success).toBe(true)
      expect(result.status).toBe('cancelled')
    })

    it('returns error on cancel failure', async () => {
      mockCancelOrder = mock(() =>
        Promise.resolve({ retCode: 20001, retMsg: 'Order not found', result: { orderId: '', orderLinkId: '' } }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.cancelOrder('BTC', 'nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Order not found')
    })
  })

  // ── getPositions ──────────────────────────────────────────────────────────

  describe('getPositions', () => {
    it('returns open positions with normalized fields', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const positions = await svc.getPositions()

      expect(positions).toHaveLength(1)
      expect(positions[0]!.coin).toBe('BTC')
      expect(positions[0]!.size).toBe(0.1)   // positive = long
      expect(positions[0]!.entryPrice).toBe(50000)
      expect(positions[0]!.unrealizedPnl).toBe(500)
      expect(positions[0]!.liquidationPrice).toBe(45000)
      expect(positions[0]!.leverage).toBe(5)
    })

    it('filters out zero-size positions', async () => {
      mockGetPositionInfo = mock(() =>
        Promise.resolve({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                symbol: 'ETHUSDT',
                side: 'Buy',
                size: '0',
                avgPrice: '3000',
                unrealisedPnl: '0',
                liqPrice: '',
                leverage: '1',
                positionIdx: 0,
              },
            ],
          },
        }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const positions = await svc.getPositions()
      expect(positions).toHaveLength(0)
    })

    it('assigns negative size to short positions', async () => {
      mockGetPositionInfo = mock(() =>
        Promise.resolve({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                symbol: 'SOLUSDT',
                side: 'Sell',
                size: '10',
                avgPrice: '150',
                unrealisedPnl: '-50',
                liqPrice: '200',
                leverage: '3',
                positionIdx: 0,
              },
            ],
          },
        }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const positions = await svc.getPositions()
      expect(positions).toHaveLength(1)
      expect(positions[0]!.size).toBe(-10)   // negative = short
      expect(positions[0]!.coin).toBe('SOL')
    })

    it('throws on API error (so caller can skip reconciliation)', async () => {
      mockGetPositionInfo = mock(() =>
        Promise.resolve({ retCode: 10001, retMsg: 'Internal error', result: { list: [] } }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      await expect(svc.getPositions()).rejects.toThrow('Internal error')
    })
  })

  // ── getPosition (single) ──────────────────────────────────────────────────

  describe('getPosition', () => {
    it('returns position for known coin', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const pos = await svc.getPosition('BTC')
      expect(pos).not.toBeNull()
      expect(pos!.coin).toBe('BTC')
    })

    it('returns null for unknown coin', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const pos = await svc.getPosition('UNKNOWN')
      expect(pos).toBeNull()
    })
  })

  // ── getAccountState ───────────────────────────────────────────────────────

  describe('getAccountState', () => {
    it('parses wallet balance response into AccountState shape', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const state = await svc.getAccountState()

      expect(state.accountValue).toBe(10000)
      expect(state.totalMarginUsed).toBe(1500)
      expect(state.withdrawable).toBe(8000)
      expect(state.spotUsdcBalance).toBe(300)
      expect(state.effectiveBalance).toBe(10000)
    })

    it('updates cachedAccountValue', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      await svc.getAccountState()
      expect(svc.getCachedAccountValue()).toBe(10000)
    })

    it('throws on API error', async () => {
      mockGetWalletBalance = mock(() =>
        Promise.resolve({ retCode: 10001, retMsg: 'Auth failed', result: { list: [] } }),
      )

      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      await expect(svc.getAccountState()).rejects.toThrow('Auth failed')
    })
  })

  // ── scheduleCancel (no-op) ────────────────────────────────────────────────

  it('scheduleCancel is a no-op (logs warning only)', async () => {
    const { BybitExchangeService } = await import('./bybit-exchange-service.js')
    const svc = new BybitExchangeService()
    await svc.init()
    // Should not throw
    expect(() => svc.scheduleCancel(Date.now() + 60_000)).not.toThrow()
  })

  // ── cancelByCloid ─────────────────────────────────────────────────────────

  describe('cancelByCloid', () => {
    it('cancels by orderLinkId successfully', async () => {
      const { BybitExchangeService } = await import('./bybit-exchange-service.js')
      const svc = new BybitExchangeService()
      await svc.init()

      const result = await svc.cancelByCloid('BTC', 'my-client-order-id')
      expect(result.success).toBe(true)
      expect(result.status).toBe('cancelled')
    })
  })
})
