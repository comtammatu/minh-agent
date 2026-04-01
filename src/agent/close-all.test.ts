import { describe, it, expect, beforeEach } from 'bun:test'
import { closeAllPositions } from './close-all.js'
import type { CloseAllDeps } from './close-all.js'

// ─── Test state ─────────────────────────────────────────────────────────────

let pausedWith: string | null = null
const cancelledIds: string[] = []
const closedPositionIds: string[] = []

const mockOrders = new Map<string, { id: string; status: string }>()
const mockPositions = new Map<string, { positionId: string; coin: string }>()

function makeDeps(): CloseAllDeps {
  return {
    agent: { pauseAll: (reason: string) => { pausedWith = reason } },
    om: {
      getOrders: () => new Map(mockOrders),
      cancelOrder: async (id: string, _reason: string) => { cancelledIds.push(id) },
      handleAction: async (action: { type: string; positionId: string; reason: string }) => {
        closedPositionIds.push(action.positionId)
      },
    },
    pm: { getPositions: () => new Map(mockPositions) },
  }
}

describe('closeAllPositions', () => {
  beforeEach(() => {
    pausedWith = null
    cancelledIds.length = 0
    closedPositionIds.length = 0
    mockOrders.clear()
    mockPositions.clear()
  })

  it('pauses agent with provided reason', async () => {
    await closeAllPositions('test close-all', makeDeps())
    expect(pausedWith).toBe('test close-all')
  })

  it('cancels pending and submitted orders', async () => {
    mockOrders.set('ord-1', { id: 'ord-1', status: 'pending' })
    mockOrders.set('ord-2', { id: 'ord-2', status: 'submitted' })
    mockOrders.set('ord-3', { id: 'ord-3', status: 'filled' }) // should NOT be cancelled

    const result = await closeAllPositions('emergency', makeDeps())
    expect(result.cancelled).toBe(2)
    expect(cancelledIds).toContain('ord-1')
    expect(cancelledIds).toContain('ord-2')
    expect(cancelledIds).not.toContain('ord-3')
  })

  it('closes all open positions', async () => {
    mockPositions.set('pos-1', { positionId: 'pos-1', coin: 'BTC' })
    mockPositions.set('pos-2', { positionId: 'pos-2', coin: 'ETH' })

    const result = await closeAllPositions('emergency', makeDeps())
    expect(result.closed).toBe(2)
    expect(closedPositionIds).toContain('pos-1')
    expect(closedPositionIds).toContain('pos-2')
  })

  it('returns zeros when no orders or positions', async () => {
    const result = await closeAllPositions('nothing to do', makeDeps())
    expect(result.cancelled).toBe(0)
    expect(result.closed).toBe(0)
  })

  it('handles both orders and positions together', async () => {
    mockOrders.set('ord-1', { id: 'ord-1', status: 'pending' })
    mockPositions.set('pos-1', { positionId: 'pos-1', coin: 'SOL' })

    const result = await closeAllPositions('full emergency', makeDeps())
    expect(result.cancelled).toBe(1)
    expect(result.closed).toBe(1)
    expect(pausedWith).toBe('full emergency')
  })
})
