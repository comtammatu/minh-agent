import { describe, it, expect } from 'bun:test'
import { inferScanMode } from './optimize.js'

describe('inferScanMode', () => {
  it('maps 15m to 15m_drilldown', () => {
    expect(inferScanMode('15m')).toBe('15m_drilldown')
  })

  it('maps 1h to 1h_same_tf', () => {
    expect(inferScanMode('1h')).toBe('1h_same_tf')
  })

  it('maps 5m to 5m_micro', () => {
    expect(inferScanMode('5m')).toBe('5m_micro')
  })

  it('maps 4h to 4h_poi', () => {
    expect(inferScanMode('4h')).toBe('4h_poi')
  })

  it('returns unknown for unlisted intervals', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inferScanMode('1d' as any)).toBe('unknown')
  })
})
