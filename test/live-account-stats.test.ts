import { describe, it, expect } from 'bun:test'
import { buildLiveStrategyWalletStats, buildLiveWalletBreakdown } from '../src/ui/live-account-stats.js'

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

describe('buildLiveWalletBreakdown', () => {
  it('splits cash by margin share and adds unrealized per strategy', () => {
    const account = { effectiveBalance: 1000 }
    const positions = [
      {
        coin: 'BTC',
        side: 'long' as const,
        strategyId: 'layered',
        currentSize: 1,
        entryPrice: 100,
        leverage: 10,
      },
      {
        coin: 'ETH',
        side: 'long' as const,
        strategyId: 'quant',
        currentSize: 2,
        entryPrice: 50,
        leverage: 10,
      },
    ]
    const marks = new Map<string, number>([
      ['BTC', 110],
      ['ETH', 50],
    ])
    const uTotal = (110 - 100) * 1 + (50 - 50) * 2
    const rows = buildLiveWalletBreakdown(account, positions, uTotal, c => marks.get(c) ?? null)
    const layered = rows.find(r => r.strategyId === 'layered')!
    const quant = rows.find(r => r.strategyId === 'quant')!
    expect(layered.unrealized).toBeCloseTo(10, 5)
    expect(quant.unrealized).toBeCloseTo(0, 5)
    expect(layered.equity).toBeCloseTo(layered.cash + layered.unrealized, 5)
    expect(quant.equity).toBeCloseTo(quant.cash + quant.unrealized, 5)
  })
})
