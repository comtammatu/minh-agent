/**
 * SSE payload shape tests — verify server-side position payload
 * matches expected dashboard frontend types.
 */

import { describe, it, expect } from 'bun:test'

// ─── Simulated payload builder (mirrors sse.ts buildStatusPayload logic) ────

interface PositionState {
  positionId: string
  coin: string
  side: 'long' | 'short'
  entryPrice: number
  currentSize: number
  originalSize: number
  slPrice: number
  tpPrice: number
  trailingState: { active: boolean; currentStopPrice: number } | null
  partialClosesFired: number[]
  openedAt: number
}

function buildPositionPayload(p: PositionState, lastPrice: number) {
  const direction = p.side === 'long' ? 1 : -1
  const unrealizedPnl = direction * (lastPrice - p.entryPrice) * p.currentSize

  return {
    id: p.positionId,
    coin: p.coin,
    side: p.side,
    size: p.currentSize,
    originalSize: p.originalSize,
    entryPrice: p.entryPrice,
    slPrice: p.slPrice,
    tpPrice: p.tpPrice,
    unrealizedPnl,
    trailingActive: p.trailingState?.active ?? false,
    openedAt: p.openedAt,
    partialClosesFired: p.partialClosesFired.length,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SSE position payload', () => {
  const basePosition: PositionState = {
    positionId: 'pos-1',
    coin: 'BTC',
    side: 'long',
    entryPrice: 60000,
    currentSize: 0.1,
    originalSize: 0.1,
    slPrice: 59000,
    tpPrice: 63000,
    trailingState: null,
    partialClosesFired: [],
    openedAt: Date.now() - 3_600_000,
  }

  it('computes positive uPnL for long above entry', () => {
    const payload = buildPositionPayload(basePosition, 61000)
    expect(payload.unrealizedPnl).toBeCloseTo(100) // 0.1 * (61000 - 60000) = 100
  })

  it('computes negative uPnL for long below entry', () => {
    const payload = buildPositionPayload(basePosition, 59500)
    expect(payload.unrealizedPnl).toBeCloseTo(-50) // 0.1 * (59500 - 60000) = -50
  })

  it('computes positive uPnL for short below entry', () => {
    const shortPos: PositionState = { ...basePosition, side: 'short' }
    const payload = buildPositionPayload(shortPos, 59000)
    expect(payload.unrealizedPnl).toBeCloseTo(100) // -1 * (59000 - 60000) * 0.1 = 100
  })

  it('maps trailing active from trailing state', () => {
    const trailingPos: PositionState = {
      ...basePosition,
      trailingState: { active: true, currentStopPrice: 60500 },
    }
    const payload = buildPositionPayload(trailingPos, 61000)
    expect(payload.trailingActive).toBe(true)
  })

  it('defaults trailing to false when state is null', () => {
    const payload = buildPositionPayload(basePosition, 61000)
    expect(payload.trailingActive).toBe(false)
  })

  it('counts partial closes correctly', () => {
    const partialPos: PositionState = {
      ...basePosition,
      currentSize: 0.07,
      partialClosesFired: [0, 1],
    }
    const payload = buildPositionPayload(partialPos, 61000)
    expect(payload.partialClosesFired).toBe(2)
    expect(payload.size).toBe(0.07)
    expect(payload.originalSize).toBe(0.1)
  })

  it('all required fields are present', () => {
    const payload = buildPositionPayload(basePosition, 60000)
    const requiredKeys = [
      'id', 'coin', 'side', 'size', 'originalSize', 'entryPrice',
      'slPrice', 'tpPrice', 'unrealizedPnl', 'trailingActive',
      'openedAt', 'partialClosesFired',
    ]
    for (const key of requiredKeys) {
      expect(payload).toHaveProperty(key)
    }
  })

  it('uPnL is zero when price equals entry', () => {
    const payload = buildPositionPayload(basePosition, 60000)
    expect(payload.unrealizedPnl).toBe(0)
  })
})
