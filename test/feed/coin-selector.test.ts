/**
 * CoinSelector tests — fetchTopCoins + createCoinSelector.
 *
 * Tests mock the HL info.metaAndAssetCtxs() response to test pure logic:
 * sorting by OI, delisted filtering, refresh diff, active-setup retention.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ── Mock HL SDK ─────────────────────────────────────────────────────────────

// We mock the info client used by coin-selector (imported from rest.ts)
// by replacing the module-level `info` export.

let mockResponse: [unknown, unknown[]] | Error = [{ universe: [] }, []]

// Mock rest.ts to provide a controllable info client
mock.module('../../src/feed/rest.js', () => ({
  info: {
    metaAndAssetCtxs: async () => {
      if (mockResponse instanceof Error) throw mockResponse
      return mockResponse
    },
    candleSnapshot: async () => [],
  },
  fetchCandles: async () => [],
  backfillStartTime: () => 0,
}))

// Mock config to disable HIP-3 in tests (avoids real network calls)
const realConfig = await import('../../src/config.js')
mock.module('../../src/config.js', () => ({
  ...realConfig,
  HIP3_DEXES: [] as string[],
  HIP3_TOP_COINS_LIMIT: 0,
}))

// Import after mock is set up
const { fetchTopCoins, createCoinSelector } = await import('../../src/feed/coin-selector.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMeta(coins: { name: string; delisted?: boolean }[]) {
  return {
    universe: coins.map(c => ({
      name: c.name,
      szDecimals: 3,
      maxLeverage: 50,
      marginTableId: 0,
      ...(c.delisted ? { isDelisted: true as const } : {}),
    })),
  }
}

function makeCtxs(ois: number[], volumes?: number[]) {
  return ois.map((oi, i) => ({
    prevDayPx: '100',
    dayNtlVlm: String(volumes?.[i] ?? 1_000_000),
    markPx: '100',
    midPx: '100',
    funding: '0.0001',
    openInterest: String(oi),
    premium: '0.001',
    oraclePx: '100',
    impactPxs: null,
    dayBaseVlm: '10000',
  }))
}

// ── fetchTopCoins ───────────────────────────────────────────────────────────

describe('fetchTopCoins', () => {
  it('returns coins sorted by OI descending', async () => {
    mockResponse = [
      makeMeta([{ name: 'ETH' }, { name: 'BTC' }, { name: 'SOL' }]),
      makeCtxs([500_000, 2_000_000, 100_000]),
    ]
    const result = await fetchTopCoins(10)
    expect(result).toEqual(['BTC', 'ETH', 'SOL'])
  })

  it('filters delisted coins', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'DEAD', delisted: true }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 500_000, 1_000_000]),
    ]
    const result = await fetchTopCoins(10)
    expect(result).toEqual(['BTC', 'ETH'])
    expect(result).not.toContain('DEAD')
  })

  it('filters coins with zero OI', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ZERO' }]),
      makeCtxs([1_000_000, 0]),
    ]
    const result = await fetchTopCoins(10)
    expect(result).toEqual(['BTC'])
  })

  it('respects limit parameter', async () => {
    mockResponse = [
      makeMeta([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      makeCtxs([400, 300, 200, 100]),
    ]
    const result = await fetchTopCoins(2)
    expect(result).toEqual(['A', 'B'])
  })

  it('returns empty array on API error', async () => {
    mockResponse = new Error('Network timeout')
    const result = await fetchTopCoins(10)
    expect(result).toEqual([])
  })

  it('returns empty array when universe is empty', async () => {
    mockResponse = [{ universe: [] }, []]
    const result = await fetchTopCoins(10)
    expect(result).toEqual([])
  })

  it('filters coins below minimum volume', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ZOMBIE' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_500_000, 1_000_000], [5_000_000, 10_000, 2_000_000]),
    ]
    // ZOMBIE has high OI but only $10K volume → filtered
    const result = await fetchTopCoins(10)
    expect(result).toEqual(['BTC', 'ETH'])
    expect(result).not.toContain('ZOMBIE')
  })

  it('respects custom minVolume parameter', async () => {
    mockResponse = [
      makeMeta([{ name: 'A' }, { name: 'B' }, { name: 'C' }]),
      makeCtxs([300, 200, 100], [2_000_000, 800_000, 100_000]),
    ]
    // With minVolume=$1M, only A passes
    const result = await fetchTopCoins(10, 1_000_000)
    expect(result).toEqual(['A'])
  })

  it('handles NaN openInterest gracefully', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'BAD' }]),
      [
        { ...makeCtxs([1_000_000])[0] },
        { ...makeCtxs([0])[0], openInterest: 'not-a-number' },
      ],
    ]
    const result = await fetchTopCoins(10)
    expect(result).toEqual(['BTC'])
  })
})

// ── CoinSelector ────────────────────────────────────────────────────────────

describe('CoinSelector', () => {
  let activeSetupCoins: string[]

  beforeEach(() => {
    activeSetupCoins = []
  })

  function makeSelector() {
    return createCoinSelector(() => activeSetupCoins)
  }

  it('starts with empty coins', () => {
    const selector = makeSelector()
    expect(selector.getTopCoins()).toEqual([])
    expect(selector.getTrackedCoins()).toEqual([])
  })

  it('refresh populates topCoins', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()
    expect(selector.getTopCoins()).toEqual(['BTC', 'ETH'])
  })

  it('refresh detects added coins', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }]),
      makeCtxs([2_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()

    // Add ETH to response
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_000_000]),
    ]
    const result = await selector.refresh()
    expect(result.added).toEqual(['ETH'])
  })

  it('refresh detects dropped coins (no active setup)', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()

    // ETH drops out
    mockResponse = [
      makeMeta([{ name: 'BTC' }]),
      makeCtxs([2_000_000]),
    ]
    const result = await selector.refresh()
    expect(result.dropped).toEqual(['ETH'])
  })

  it('keeps dropped coin with active setup in trackedCoins', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()

    // ETH has an active setup
    activeSetupCoins = ['ETH']

    // ETH drops from top
    mockResponse = [
      makeMeta([{ name: 'BTC' }]),
      makeCtxs([2_000_000]),
    ]
    const result = await selector.refresh()

    // ETH is NOT in the dropped list (protected by active setup)
    expect(result.dropped).toEqual([])

    // ETH still in trackedCoins (union of top + active)
    expect(selector.getTrackedCoins()).toContain('ETH')
    expect(selector.getTrackedCoins()).toContain('BTC')

    // But NOT in topCoins (only fresh top list)
    expect(selector.getTopCoins()).not.toContain('ETH')
  })

  it('refresh failure keeps current list', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }, { name: 'ETH' }]),
      makeCtxs([2_000_000, 1_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()

    // API fails
    mockResponse = new Error('Connection refused')
    const result = await selector.refresh()
    expect(result.added).toEqual([])
    expect(result.dropped).toEqual([])
    expect(selector.getTopCoins()).toEqual(['BTC', 'ETH'])
  })

  it('trackedCoins is union of topCoins and activeSetupCoins', async () => {
    mockResponse = [
      makeMeta([{ name: 'BTC' }]),
      makeCtxs([2_000_000]),
    ]
    const selector = makeSelector()
    await selector.refresh()

    // SOL has active setup but is NOT in top coins
    activeSetupCoins = ['SOL']
    const tracked = selector.getTrackedCoins()
    expect(tracked).toContain('BTC')
    expect(tracked).toContain('SOL')
    expect(tracked.length).toBe(2)
  })

  it('stopRefreshLoop is safe to call when not started', () => {
    const selector = makeSelector()
    expect(() => selector.stopRefreshLoop()).not.toThrow()
  })

  it('stopRefreshLoop is safe to call multiple times', () => {
    const selector = makeSelector()
    selector.startRefreshLoop()
    expect(() => {
      selector.stopRefreshLoop()
      selector.stopRefreshLoop()
    }).not.toThrow()
  })
})

// ── getActiveSetupCoins (pipeline export) ───────────────────────────────────

describe('getActiveSetupCoins', () => {
  it('exports from pipeline', async () => {
    const { getActiveSetupCoins } = await import('../../src/strategy/orchestrator.js')
    expect(typeof getActiveSetupCoins).toBe('function')
    // With no active setups, returns empty
    const { clearPipelineState } = await import('../../src/strategy/orchestrator.js')
    clearPipelineState()
    expect(getActiveSetupCoins()).toEqual([])
  })
})
