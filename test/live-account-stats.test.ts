import { describe, it, expect } from 'bun:test'
import { buildLiveStrategyWalletStats } from '../src/ui/live-account-stats.js'

describe('buildLiveStrategyWalletStats', () => {
  it('fills three strategies with zeros when DB empty', () => {
    const s = buildLiveStrategyWalletStats([])
    expect(s.wallets).toHaveLength(3)
    expect(s.tradeCount).toBe(0)
    expect(s.winRate).toBe(0)
    expect(s.wallets[0]!.strategyId).toBe('layered')
  })

  it('merges rows into wallet slots', () => {
    const s = buildLiveStrategyWalletStats([
      { strategyId: 'quant', wins: 2, losses: 1, tradeCount: 3 },
    ])
    const q = s.wallets.find(w => w.strategyId === 'quant')
    expect(q?.wins).toBe(2)
    expect(q?.losses).toBe(1)
    expect(q?.winRate).toBeCloseTo(2 / 3, 5)
  })
})

