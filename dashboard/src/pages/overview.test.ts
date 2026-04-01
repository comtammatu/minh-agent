/**
 * Overview + Positions page helper tests.
 * Tests pure formatting and computation functions extracted from pages.
 * No DOM rendering — just logic.
 */

import { describe, it, expect } from 'bun:test'

// ─── Re-implement helpers for testing (same logic as in Overview/Positions) ─

function formatPnl(value: number): string {
  if (value >= 0) return `+$${value.toFixed(2)}`
  return `-$${Math.abs(value).toFixed(2)}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function pnlColor(value: number): string {
  if (value > 0) return 'text-emerald-400'
  if (value < 0) return 'text-red-400'
  return 'text-zinc-400'
}

interface Position {
  side: 'long' | 'short'
  size: number
  originalSize: number
  entryPrice: number
  slPrice: number
  tpPrice: number
  unrealizedPnl: number
}

function pnlPercent(p: Position): number {
  if (p.entryPrice === 0 || p.size === 0) return 0
  const notional = p.size * p.entryPrice
  return notional !== 0 ? p.unrealizedPnl / notional : 0
}

function riskRewardRatio(p: Position): string {
  const risk = Math.abs(p.entryPrice - p.slPrice)
  const reward = Math.abs(p.tpPrice - p.entryPrice)
  if (risk === 0) return '-'
  return `1:${(reward / risk).toFixed(1)}`
}

function formatSignalData(s: { type: string; data: Record<string, unknown> }): string {
  const d = s.data
  if (s.type === 'setup') {
    const coin = d.coin ?? d.symbol ?? ''
    const tf = d.timeframe ?? d.tf ?? ''
    const grade = d.confluenceGrade ?? d.grade ?? ''
    const pattern = d.patternType ?? d.pattern ?? ''
    const side = d.side ?? ''
    return `${coin} ${tf} ${side} ${pattern} [${grade}]`
  }
  if (s.type === 'invalidation') {
    return `${d.id ?? ''} — ${d.reason ?? ''}`
  }
  return JSON.stringify(d).slice(0, 100)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('formatPnl', () => {
  it('positive value gets + prefix', () => {
    expect(formatPnl(123.456)).toBe('+$123.46')
  })

  it('negative value has - prefix', () => {
    expect(formatPnl(-50.1)).toBe('-$50.10')
  })

  it('zero gets + prefix', () => {
    expect(formatPnl(0)).toBe('+$0.00')
  })
})

describe('formatPercent', () => {
  it('converts 0.523 to 52.3%', () => {
    expect(formatPercent(0.523)).toBe('52.3%')
  })

  it('converts 0 to 0.0%', () => {
    expect(formatPercent(0)).toBe('0.0%')
  })

  it('converts 1 to 100.0%', () => {
    expect(formatPercent(1)).toBe('100.0%')
  })
})

describe('formatUptime', () => {
  it('shows minutes only when < 1 hour', () => {
    expect(formatUptime(30 * 60_000)).toBe('30m')
  })

  it('shows hours and minutes', () => {
    expect(formatUptime(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m')
  })

  it('handles 0', () => {
    expect(formatUptime(0)).toBe('0m')
  })
})

describe('pnlColor', () => {
  it('green for positive', () => {
    expect(pnlColor(10)).toBe('text-emerald-400')
  })

  it('red for negative', () => {
    expect(pnlColor(-5)).toBe('text-red-400')
  })

  it('neutral for zero', () => {
    expect(pnlColor(0)).toBe('text-zinc-400')
  })
})

describe('pnlPercent', () => {
  it('computes correctly for long position', () => {
    const p: Position = { side: 'long', size: 1, originalSize: 1, entryPrice: 100, slPrice: 95, tpPrice: 110, unrealizedPnl: 5 }
    expect(pnlPercent(p)).toBeCloseTo(0.05)
  })

  it('returns 0 when entryPrice is 0', () => {
    const p: Position = { side: 'long', size: 1, originalSize: 1, entryPrice: 0, slPrice: 0, tpPrice: 0, unrealizedPnl: 0 }
    expect(pnlPercent(p)).toBe(0)
  })

  it('returns 0 when size is 0', () => {
    const p: Position = { side: 'long', size: 0, originalSize: 1, entryPrice: 100, slPrice: 95, tpPrice: 110, unrealizedPnl: 0 }
    expect(pnlPercent(p)).toBe(0)
  })
})

describe('riskRewardRatio', () => {
  it('computes 1:2 correctly', () => {
    const p: Position = { side: 'long', size: 1, originalSize: 1, entryPrice: 100, slPrice: 95, tpPrice: 110, unrealizedPnl: 0 }
    expect(riskRewardRatio(p)).toBe('1:2.0')
  })

  it('returns - when risk is 0 (SL = entry)', () => {
    const p: Position = { side: 'long', size: 1, originalSize: 1, entryPrice: 100, slPrice: 100, tpPrice: 110, unrealizedPnl: 0 }
    expect(riskRewardRatio(p)).toBe('-')
  })

  it('handles short positions', () => {
    const p: Position = { side: 'short', size: 1, originalSize: 1, entryPrice: 100, slPrice: 105, tpPrice: 90, unrealizedPnl: 0 }
    // risk = 5, reward = 10 → 1:2.0
    expect(riskRewardRatio(p)).toBe('1:2.0')
  })
})

describe('formatSignalData', () => {
  it('formats setup signals with coin, tf, side, pattern, grade', () => {
    const s = {
      type: 'setup',
      data: { coin: 'BTC', timeframe: '1h', side: 'long', patternType: 'order-block', confluenceGrade: 'A' },
    }
    expect(formatSignalData(s)).toBe('BTC 1h long order-block [A]')
  })

  it('formats invalidation signals', () => {
    const s = {
      type: 'invalidation',
      data: { id: 'setup-123', reason: 'TTL expired' },
    }
    expect(formatSignalData(s)).toBe('setup-123 — TTL expired')
  })

  it('handles unknown type with JSON fallback', () => {
    const s = { type: 'unknown', data: { foo: 'bar' } }
    expect(formatSignalData(s)).toBe('{"foo":"bar"}')
  })

  it('handles missing fields gracefully', () => {
    const s = { type: 'setup', data: {} }
    // Empty fields produce empty strings: "  " with spaces between them
    expect(formatSignalData(s)).toContain('[]')
  })
})
