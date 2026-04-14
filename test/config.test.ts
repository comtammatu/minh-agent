import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  getActiveExchange,
  tryGetActiveExchange,
  getBybitTradingEnv,
  getDefaultCoins,
  getFocusedTrackedCoinsOverride,
  BYBIT_STATIC_COINS,
} from '../src/config.js'

describe('getDefaultCoins', () => {
  it('BB returns BYBIT_STATIC_COINS', () => {
    const coins = getDefaultCoins('BB')
    expect(coins).toEqual(BYBIT_STATIC_COINS)
    expect(coins.length).toBeGreaterThan(10)
    expect(coins).toContain('BTC')
    expect(coins).toContain('BNB')  // not on HL
  })

  it('HL returns empty (dynamic)', () => {
    const coins = getDefaultCoins('HL')
    expect(coins).toEqual([])
  })
})

describe('getActiveExchange', () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env['ACTIVE_EXCHANGE']
  })

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['ACTIVE_EXCHANGE']
    } else {
      process.env['ACTIVE_EXCHANGE'] = origEnv
    }
  })

  it('throws when ACTIVE_EXCHANGE not set', () => {
    delete process.env['ACTIVE_EXCHANGE']
    expect(() => getActiveExchange()).toThrow('ACTIVE_EXCHANGE')
  })

  it('throws on unknown value', () => {
    process.env['ACTIVE_EXCHANGE'] = 'OKX'
    expect(() => getActiveExchange()).toThrow('OKX')
  })

  it('returns HL when set to HL', () => {
    process.env['ACTIVE_EXCHANGE'] = 'HL'
    expect(getActiveExchange()).toBe('HL')
  })

  it('returns BB when set to BB', () => {
    process.env['ACTIVE_EXCHANGE'] = 'BB'
    expect(getActiveExchange()).toBe('BB')
  })
})

describe('tryGetActiveExchange', () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env['ACTIVE_EXCHANGE']
  })

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['ACTIVE_EXCHANGE']
    } else {
      process.env['ACTIVE_EXCHANGE'] = origEnv
    }
  })

  it('returns null when ACTIVE_EXCHANGE is not set', () => {
    delete process.env['ACTIVE_EXCHANGE']
    expect(tryGetActiveExchange()).toBeNull()
  })

  it('returns null on unknown value', () => {
    process.env['ACTIVE_EXCHANGE'] = 'OKX'
    expect(tryGetActiveExchange()).toBeNull()
  })

  it('returns HL when set to HL', () => {
    process.env['ACTIVE_EXCHANGE'] = 'HL'
    expect(tryGetActiveExchange()).toBe('HL')
  })

  it('returns BB when set to BB', () => {
    process.env['ACTIVE_EXCHANGE'] = 'BB'
    expect(tryGetActiveExchange()).toBe('BB')
  })
})

describe('getFocusedTrackedCoinsOverride', () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env['FOCUSED_TRACKED_COINS']
  })

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['FOCUSED_TRACKED_COINS']
    } else {
      process.env['FOCUSED_TRACKED_COINS'] = origEnv
    }
  })

  it('returns null when env is unset', () => {
    delete process.env['FOCUSED_TRACKED_COINS']
    expect(getFocusedTrackedCoinsOverride()).toBeNull()
  })

  it('parses uppercase unique coins from CSV', () => {
    process.env['FOCUSED_TRACKED_COINS'] = 'btc, ETH ,btc, sol'
    expect(getFocusedTrackedCoinsOverride()).toEqual(['BTC', 'ETH', 'SOL'])
  })

  it('returns null when env has only blanks', () => {
    process.env['FOCUSED_TRACKED_COINS'] = ' ,  , '
    expect(getFocusedTrackedCoinsOverride()).toBeNull()
  })
})

describe('getBybitTradingEnv', () => {
  let origTestnet: string | undefined
  let origDemo: string | undefined

  beforeEach(() => {
    origTestnet = process.env['BYBIT_TESTNET']
    origDemo = process.env['BYBIT_DEMO_TRADING']
  })

  afterEach(() => {
    if (origTestnet === undefined) {
      delete process.env['BYBIT_TESTNET']
    } else {
      process.env['BYBIT_TESTNET'] = origTestnet
    }

    if (origDemo === undefined) {
      delete process.env['BYBIT_DEMO_TRADING']
    } else {
      process.env['BYBIT_DEMO_TRADING'] = origDemo
    }
  })

  it('defaults to mainnet', () => {
    delete process.env['BYBIT_TESTNET']
    delete process.env['BYBIT_DEMO_TRADING']
    expect(getBybitTradingEnv()).toBe('mainnet')
  })

  it('returns testnet when BYBIT_TESTNET=true', () => {
    process.env['BYBIT_TESTNET'] = 'true'
    delete process.env['BYBIT_DEMO_TRADING']
    expect(getBybitTradingEnv()).toBe('testnet')
  })

  it('returns demo when BYBIT_DEMO_TRADING=true', () => {
    delete process.env['BYBIT_TESTNET']
    process.env['BYBIT_DEMO_TRADING'] = 'true'
    expect(getBybitTradingEnv()).toBe('demo')
  })

  it('throws when both demo and testnet are enabled', () => {
    process.env['BYBIT_TESTNET'] = 'true'
    process.env['BYBIT_DEMO_TRADING'] = 'true'
    expect(() => getBybitTradingEnv()).toThrow('BYBIT_TESTNET and BYBIT_DEMO_TRADING')
  })
})
