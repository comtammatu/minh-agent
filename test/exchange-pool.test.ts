/**
 * ExchangePool tests (Sprint 4.5 S4).
 *
 * Both HL and Bybit use a single shared wallet for the whole runtime.
 * Tests: single-wallet routing, pool lifecycle, singleton.
 *
 * Mocks: HL SDK, viem, rate-limiter (same as exchange-service.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ── Mock setup ───────────────────────────────────────────────────────────────

mock.module('viem/accounts', () => ({
  privateKeyToAccount: () => ({
    address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    signMessage: () => Promise.resolve('0x'),
    signTypedData: () => Promise.resolve('0x'),
  }),
}))

mock.module('../src/feed/rate-limiter.js', () => ({
  acquire: () => Promise.resolve(),
}))

mock.module('@nktkas/hyperliquid', () => ({
  HttpTransport: class MockTransport {},
  ExchangeClient: class MockExchangeClient {
    constructor() {}
  },
}))

mock.module('@nktkas/hyperliquid/utils', () => ({
  SymbolConverter: {
    create: () =>
      Promise.resolve({
        getAssetId: (coin: string) => {
          const map: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2 }
          return map[coin]
        },
        getSzDecimals: (coin: string) => {
          const map: Record<string, number> = { BTC: 5, ETH: 4, SOL: 2 }
          return map[coin]
        },
        reload: () => Promise.resolve(),
      }),
  },
  formatPrice: (price: string | number) => String(price),
  formatSize: (size: string | number) => String(size),
}))

mock.module('../src/feed/rest.js', () => ({
  info: {
    meta: () => Promise.resolve({ universe: [] }),
    clearinghouseState: () =>
      Promise.resolve({
        marginSummary: { accountValue: '10000', totalNtlPos: '0', totalMarginUsed: '0' },
        withdrawable: '10000',
        assetPositions: [],
      }),
    spotClearinghouseState: () =>
      Promise.resolve({ balances: [] }),
  },
}))

import { ExchangePool, resetExchangePool, getExchangePool } from '../src/execution/exchange-pool.js'
import { resetExchangeService } from '../src/execution/exchange-service.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const SHARED_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ExchangePool', () => {
  beforeEach(() => {
    resetExchangePool()
    resetExchangeService()
    process.env.PRIVATE_KEY = SHARED_PK
    delete process.env.ACCOUNT_ADDRESS
    process.env.ACTIVE_EXCHANGE = 'HL'
  })

  afterEach(() => {
    delete process.env.PRIVATE_KEY
    delete process.env.ACCOUNT_ADDRESS
    delete process.env.ACTIVE_EXCHANGE
  })

  describe('single-wallet mode (HL)', () => {
    it('should create a shared instance for repeated lookups', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const first = pool.get()
      const override = pool.get('HL')
      const second = pool.get()

      // All return the same shared instance
      expect(first).toBe(override)
      expect(override).toBe(second)
    })

    it('isInitialized is false before init and true after', async () => {
      const pool = new ExchangePool()
      expect(pool.isInitialized()).toBe(false)
      await pool.init()
      expect(pool.isInitialized()).toBe(true)
    })

    it('should report not multi-wallet', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.isMultiWallet()).toBe(false)
    })

    it('getShared returns the shared instance', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.getShared()).toBe(pool.get())
    })

    it('getActiveExchangeId returns HL', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.getActiveExchangeId()).toBe('HL')
    })
  })

  describe('lifecycle', () => {
    it('should throw if get() called before init()', () => {
      const pool = new ExchangePool()
      expect(() => pool.get()).toThrow('not initialized')
    })

    it('should throw if getShared() called before init()', () => {
      const pool = new ExchangePool()
      expect(() => pool.getShared()).toThrow('not initialized')
    })

    it('init() is idempotent', async () => {
      const pool = new ExchangePool()
      await pool.init()
      await pool.init() // second call should be no-op
      expect(pool.getShared()).toBeTruthy()
    })
  })

  describe('singleton', () => {
    it('getExchangePool returns same instance', () => {
      const a = getExchangePool()
      const b = getExchangePool()
      expect(a).toBe(b)
    })

    it('resetExchangePool clears singleton', () => {
      const a = getExchangePool()
      resetExchangePool()
      const b = getExchangePool()
      expect(a).not.toBe(b)
    })
  })
})
