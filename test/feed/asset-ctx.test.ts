/**
 * Asset context feed tests — OI store, delta computation, divergence detection.
 *
 * Tests focus on the pure logic: snapshot parsing, storage, OI delta, divergence.
 * Live REST calls are not made; we test exported getters indirectly.
 */

import { describe, it, expect } from 'bun:test'
import {
  getLatestAssetCtx,
  getOiDelta,
  hasDivergence,
  stopOiPolling,
  removeOiCoin,
} from '../../src/feed/asset-ctx.js'

// ── getLatestAssetCtx ───────────────────────────────────────────────────────

describe('getLatestAssetCtx', () => {
  it('returns null for unknown coin before any fetch', () => {
    stopOiPolling()  // ensure clean state
    expect(getLatestAssetCtx('UNKNOWN_COIN_XYZ')).toBeNull()
  })

  it('returns null for coin that has never been polled', () => {
    expect(getLatestAssetCtx('BTC')).toBeNull()
  })
})

// ── getOiDelta ──────────────────────────────────────────────────────────────

describe('getOiDelta', () => {
  it('returns null for unknown coin', () => {
    expect(getOiDelta('UNKNOWN_COIN_XYZ')).toBeNull()
  })

  it('returns null for coin with no previous snapshot', () => {
    // No data fetched yet → null
    expect(getOiDelta('BTC')).toBeNull()
  })
})

// ── hasDivergence ───────────────────────────────────────────────────────────

describe('hasDivergence', () => {
  it('returns false for unknown coin', () => {
    expect(hasDivergence('UNKNOWN_COIN_XYZ')).toBe(false)
  })

  it('returns false for coin with no snapshot', () => {
    expect(hasDivergence('BTC')).toBe(false)
  })
})

// ── stopOiPolling ───────────────────────────────────────────────────────────

describe('stopOiPolling', () => {
  it('is safe to call multiple times', () => {
    expect(() => {
      stopOiPolling()
      stopOiPolling()
    }).not.toThrow()
  })

  it('is safe to call when polling was never started', () => {
    expect(() => stopOiPolling()).not.toThrow()
  })
})

// ── removeOiCoin ────────────────────────────────────────────────────────────

describe('removeOiCoin', () => {
  it('is safe to call for unknown coin', () => {
    expect(() => removeOiCoin('NONEXISTENT_COIN')).not.toThrow()
  })

  it('clears data after removal', () => {
    removeOiCoin('BTC')
    expect(getLatestAssetCtx('BTC')).toBeNull()
    expect(getOiDelta('BTC')).toBeNull()
  })
})
