/**
 * ExchangePool tests (Sprint 4.5 S4).
 *
 * Tests: multi-wallet mode, single-wallet fallback, routing correctness,
 * unknown strategyId fallback, pool lifecycle.
 *
 * Mocks: HL SDK, viem, rate-limiter (same as exchange-service.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ── Mock setup (same mocks as exchange-service.test.ts) ─────────────────────

mock.module('viem/accounts', () => ({
  privateKeyToAccount: (key: string) => {
    // Return different addresses for different keys to verify routing
    const addressMap: Record<string, string> = {
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80': '0x1111111111111111111111111111111111111111',
      '0xaaaa000000000000000000000000000000000000000000000000000000000001': '0x2222222222222222222222222222222222222222',
      '0xbbbb000000000000000000000000000000000000000000000000000000000002': '0x3333333333333333333333333333333333333333',
    }
    const address = addressMap[key] ?? '0xDEAD000000000000000000000000000000000000'
    return {
      address: address as `0x${string}`,
      signMessage: () => Promise.resolve('0x'),
      signTypedData: () => Promise.resolve('0x'),
    }
  },
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
import { ExchangeService, resetExchangeService } from '../src/execution/exchange-service.js'
import { parseStrategyWallets, type WalletConfig } from '../src/config.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const SHARED_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const LAYERED_PK = '0xaaaa000000000000000000000000000000000000000000000000000000000001'
const QUANT_PK = '0xbbbb000000000000000000000000000000000000000000000000000000000002'
const ACCOUNT_ADDR = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'

const MULTI_WALLET_ENV = JSON.stringify({
  layered: { privateKey: LAYERED_PK, accountAddress: ACCOUNT_ADDR },
  quant: { privateKey: QUANT_PK, accountAddress: ACCOUNT_ADDR },
})

function deleteFlatWalletEnv(): void {
  delete process.env.PRIVATE_KEY_LAYERED
  delete process.env.ACCOUNT_ADDRESS_LAYERED
  delete process.env.PRIVATE_KEY_QUANT
  delete process.env.ACCOUNT_ADDRESS_QUANT
  delete process.env.PRIVATE_KEY_SMC_SD
  delete process.env.ACCOUNT_ADDRESS_SMC_SD
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseStrategyWallets', () => {
  afterEach(() => {
    delete process.env.STRATEGY_WALLETS
    deleteFlatWalletEnv()
  })

  it('should return empty Map when env not set', () => {
    delete process.env.STRATEGY_WALLETS
    deleteFlatWalletEnv()
    const result = parseStrategyWallets()
    expect(result.size).toBe(0)
  })

  it('should parse valid JSON into Map<strategyId, WalletConfig>', () => {
    process.env.STRATEGY_WALLETS = MULTI_WALLET_ENV
    const result = parseStrategyWallets()
    expect(result.size).toBe(2)
    expect(result.get('layered')?.privateKey).toBe(LAYERED_PK)
    expect(result.get('layered')?.accountAddress).toBe(ACCOUNT_ADDR)
    expect(result.get('quant')?.privateKey).toBe(QUANT_PK)
  })

  it('should throw on invalid JSON', () => {
    process.env.STRATEGY_WALLETS = 'not-json'
    expect(() => parseStrategyWallets()).toThrow('not valid JSON')
  })

  it('should throw on array instead of object', () => {
    process.env.STRATEGY_WALLETS = '[]'
    expect(() => parseStrategyWallets()).toThrow('must be a JSON object')
  })

  it('should throw on missing privateKey', () => {
    process.env.STRATEGY_WALLETS = JSON.stringify({
      layered: { accountAddress: ACCOUNT_ADDR },
    })
    expect(() => parseStrategyWallets()).toThrow('privateKey must be a 0x-prefixed')
  })

  it('should throw on invalid privateKey (no 0x prefix)', () => {
    process.env.STRATEGY_WALLETS = JSON.stringify({
      layered: { privateKey: 'deadbeef', accountAddress: ACCOUNT_ADDR },
    })
    expect(() => parseStrategyWallets()).toThrow('privateKey must be a 0x-prefixed')
  })

  it('should throw on invalid accountAddress (wrong length)', () => {
    process.env.STRATEGY_WALLETS = JSON.stringify({
      layered: { privateKey: LAYERED_PK, accountAddress: '0xshort' },
    })
    expect(() => parseStrategyWallets()).toThrow('accountAddress must be a valid')
  })

  it('should throw on non-object strategy entry', () => {
    process.env.STRATEGY_WALLETS = JSON.stringify({
      layered: 'not-an-object',
    })
    expect(() => parseStrategyWallets()).toThrow('must be an object')
  })

  it('should parse flat env vars when STRATEGY_WALLETS is unset', () => {
    process.env.PRIVATE_KEY_LAYERED = LAYERED_PK
    process.env.ACCOUNT_ADDRESS_LAYERED = ACCOUNT_ADDR
    process.env.PRIVATE_KEY_QUANT = QUANT_PK
    process.env.ACCOUNT_ADDRESS_QUANT = ACCOUNT_ADDR
    const result = parseStrategyWallets()
    expect(result.size).toBe(2)
    expect(result.get('layered')?.privateKey).toBe(LAYERED_PK)
    expect(result.get('quant')?.privateKey).toBe(QUANT_PK)
  })

  it('should prefer STRATEGY_WALLETS JSON over flat env when both set', () => {
    process.env.STRATEGY_WALLETS = MULTI_WALLET_ENV
    process.env.PRIVATE_KEY_LAYERED = '0xcccc0000000000000000000000000000000000000000000000000000000000cc'
    process.env.ACCOUNT_ADDRESS_LAYERED = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    const result = parseStrategyWallets()
    expect(result.get('layered')?.privateKey).toBe(LAYERED_PK)
  })

  it('should throw when flat env has only half of a pair', () => {
    process.env.PRIVATE_KEY_LAYERED = LAYERED_PK
    delete process.env.ACCOUNT_ADDRESS_LAYERED
    expect(() => parseStrategyWallets()).toThrow('Incomplete wallet env for strategy "layered"')
  })
})

describe('ExchangeService with WalletConfig', () => {
  beforeEach(() => {
    resetExchangeService()
    delete process.env.PRIVATE_KEY
    delete process.env.ACCOUNT_ADDRESS
    delete process.env.STRATEGY_WALLETS
    deleteFlatWalletEnv()
  })

  it('should init with injected WalletConfig (no env vars needed)', async () => {
    const config: WalletConfig = {
      privateKey: LAYERED_PK,
      accountAddress: ACCOUNT_ADDR,
    }
    const svc = new ExchangeService(config)
    await svc.init()

    expect(svc.getWalletAddress()).toBe('0x2222222222222222222222222222222222222222')
    expect(svc.getAccountAddress()).toBe(ACCOUNT_ADDR)
  })

  it('should fallback to env when no WalletConfig provided', async () => {
    process.env.PRIVATE_KEY = SHARED_PK
    const svc = new ExchangeService()
    await svc.init()

    expect(svc.getWalletAddress()).toBe('0x1111111111111111111111111111111111111111')
  })

  it('WalletConfig takes precedence over env vars', async () => {
    process.env.PRIVATE_KEY = SHARED_PK
    process.env.ACCOUNT_ADDRESS = '0x9999999999999999999999999999999999999999'

    const config: WalletConfig = {
      privateKey: LAYERED_PK,
      accountAddress: ACCOUNT_ADDR,
    }
    const svc = new ExchangeService(config)
    await svc.init()

    // Should use injected config, not env
    expect(svc.getWalletAddress()).toBe('0x2222222222222222222222222222222222222222')
    expect(svc.getAccountAddress()).toBe(ACCOUNT_ADDR)
  })
})

describe('ExchangePool', () => {
  beforeEach(() => {
    resetExchangePool()
    resetExchangeService()
    delete process.env.STRATEGY_WALLETS
    deleteFlatWalletEnv()
    // Set shared wallet env for fallback
    process.env.PRIVATE_KEY = SHARED_PK
    delete process.env.ACCOUNT_ADDRESS
    // Multi-exchange: default to HL for existing pool tests
    process.env.ACTIVE_EXCHANGE = 'HL'
  })

  afterEach(() => {
    delete process.env.STRATEGY_WALLETS
    delete process.env.PRIVATE_KEY
    delete process.env.ACCOUNT_ADDRESS
    delete process.env.ACTIVE_EXCHANGE
    deleteFlatWalletEnv()
  })

  // ── Single-wallet mode ────────────────────────────────────────────────

  describe('single-wallet mode (no STRATEGY_WALLETS)', () => {
    it('should create shared instance for all strategies', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const layered = pool.get('layered')
      const quant = pool.get('quant')
      const unknown = pool.get('unknown-strategy')

      // All return the same shared instance
      expect(layered).toBe(quant)
      expect(quant).toBe(unknown)
      expect(layered.getWalletAddress()).toBe('0x1111111111111111111111111111111111111111')
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

    it('should report no dedicated wallets', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.hasDedicatedWallet('layered')).toBe(false)
      expect(pool.getStrategyIds()).toEqual([])
    })

    it('getShared returns the shared instance', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.getShared()).toBe(pool.get('anything'))
    })
  })

  // ── Multi-wallet mode ─────────────────────────────────────────────────

  describe('multi-wallet mode (STRATEGY_WALLETS set)', () => {
    beforeEach(() => {
      process.env.STRATEGY_WALLETS = MULTI_WALLET_ENV
    })

    it('should create separate instances per strategy', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const layered = pool.get('layered')
      const quant = pool.get('quant')

      // Different instances
      expect(layered).not.toBe(quant)
    })

    it('should route to correct wallet per strategy', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const layered = pool.get('layered')
      const quant = pool.get('quant')

      expect(layered.getWalletAddress()).toBe('0x2222222222222222222222222222222222222222')
      expect(quant.getWalletAddress()).toBe('0x3333333333333333333333333333333333333333')
    })

    it('should return shared fallback for unknown strategyId', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const unknown = pool.get('future-strategy')
      const shared = pool.getShared()

      expect(unknown).toBe(shared)
      expect(unknown.getWalletAddress()).toBe('0x1111111111111111111111111111111111111111')
    })

    it('should init without PRIVATE_KEY env when strategy wallets are set (shared reuses layered)', async () => {
      delete process.env.PRIVATE_KEY
      delete process.env.ACCOUNT_ADDRESS
      const pool = new ExchangePool()
      await pool.init()

      const layered = pool.get('layered')
      const shared = pool.getShared()
      const unknown = pool.get('future-strategy')

      expect(shared).toBe(layered)
      expect(unknown).toBe(layered)
      expect(layered.getWalletAddress()).toBe('0x2222222222222222222222222222222222222222')
    })

    it('should report multi-wallet mode', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.isMultiWallet()).toBe(true)
    })

    it('should report dedicated wallets', async () => {
      const pool = new ExchangePool()
      await pool.init()
      expect(pool.hasDedicatedWallet('layered')).toBe(true)
      expect(pool.hasDedicatedWallet('quant')).toBe(true)
      expect(pool.hasDedicatedWallet('unknown')).toBe(false)
    })

    it('should list all strategy IDs', async () => {
      const pool = new ExchangePool()
      await pool.init()
      const ids = pool.getStrategyIds()
      expect(ids).toContain('layered')
      expect(ids).toContain('quant')
      expect(ids).toHaveLength(2)
    })

    it('all strategies share same accountAddress but different signing wallets', async () => {
      const pool = new ExchangePool()
      await pool.init()

      const layered = pool.get('layered')
      const quant = pool.get('quant')

      // Same account (main account)
      expect(layered.getAccountAddress()).toBe(ACCOUNT_ADDR)
      expect(quant.getAccountAddress()).toBe(ACCOUNT_ADDR)

      // Different signing wallets
      expect(layered.getWalletAddress()).not.toBe(quant.getWalletAddress())
    })
  })

  // ── Pool lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should throw if get() called before init()', () => {
      const pool = new ExchangePool()
      expect(() => pool.get('layered')).toThrow('not initialized')
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

  // ── Singleton ─────────────────────────────────────────────────────────

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
