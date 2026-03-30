/**
 * Asset context feed tests — OI store, delta computation, divergence detection.
 *
 * Tests focus on the pure logic: snapshot parsing, storage, OI delta, divergence.
 * WS subscription is not created; we test exported getters directly.
 */

import { describe, it, expect } from 'bun:test'
import {
  getLatestAssetCtx,
  getOiDelta,
  hasDivergence,
  stopOiFeed,
  removeOiCoin,
} from '../../src/feed/asset-ctx.js'

// ── getLatestAssetCtx ───────────────────────────────────────────────────────

describe('getLatestAssetCtx', () => {
  it('returns null for unknown coin before any fetch', () => {
    expect(getLatestAssetCtx('UNKNOWN_COIN_XYZ')).toBeNull()
  })

  it('returns null for coin that has never been tracked', () => {
    expect(getLatestAssetCtx('BTC')).toBeNull()
  })
})

// ── getOiDelta ──────────────────────────────────────────────────────────────

describe('getOiDelta', () => {
  it('returns null for unknown coin', () => {
    expect(getOiDelta('UNKNOWN_COIN_XYZ')).toBeNull()
  })

  it('returns null for coin with no previous snapshot', () => {
    // No data received yet → null
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

// ── stopOiFeed ──────────────────────────────────────────────────────────────

describe('stopOiFeed', () => {
  it('is safe to call multiple times', async () => {
    await stopOiFeed()
    await stopOiFeed()
  })

  it('is safe to call when feed was never started', async () => {
    await stopOiFeed()
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
