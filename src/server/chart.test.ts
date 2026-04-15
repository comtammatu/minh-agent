import { describe, expect, it } from 'bun:test'
import type { ActiveSetup, Candle } from '../types.js'
import type { JournalEntry, PositionState } from '../agent/types.js'
import {
  buildChartLines,
  buildChartMarks,
  mergeCandlesForHistory,
  resolutionToInterval,
} from './chart.js'

describe('resolutionToInterval', () => {
  it('maps TradingView resolutions to runtime intervals', () => {
    expect(resolutionToInterval('1')).toBe('1m')
    expect(resolutionToInterval('60')).toBe('1h')
    expect(resolutionToInterval('1D')).toBe('1d')
  })
})

describe('mergeCandlesForHistory', () => {
  it('returns ascending bars and dedupes overlaps while honoring countBack', () => {
    const persisted: Candle[] = [
      { t: 1_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 2_000, o: 2, h: 3, l: 1.5, c: 2.5, v: 10 },
      { t: 3_000, o: 3, h: 4, l: 2.5, c: 3.5, v: 10 },
    ]
    const hot: Candle[] = [
      { t: 3_000, o: 3.1, h: 4.1, l: 2.6, c: 3.6, v: 11 },
      { t: 4_000, o: 4, h: 5, l: 3.5, c: 4.5, v: 12 },
    ]

    const merged = mergeCandlesForHistory(persisted, hot, 0, 5_000, 3)
    expect(merged.map(candle => candle.t)).toEqual([2_000, 3_000, 4_000])
    expect(merged[1]?.c).toBe(3.6)
  })
})

describe('buildChartMarks', () => {
  it('creates mark entries for journal rows', () => {
    const entries: JournalEntry[] = [{
      id: 1,
      ts: new Date('2026-04-16T00:00:00Z'),
      eventType: 'signal',
      coin: 'BTC',
      details: { side: 'long', interval: '1h' },
      agentState: 'WATCHING',
      exchange: 'HL',
    }]

    const marks = buildChartMarks(entries)
    expect(marks).toHaveLength(1)
    expect(marks[0]?.label).toBe('S')
  })
})

describe('buildChartLines', () => {
  it('returns line overlays for setups and positions', () => {
    const setups: ActiveSetup[] = [{
      id: 'BTC|1h|smc-sd',
      coin: 'BTC',
      interval: '1h',
      type: 'smc-sd',
      side: 'long',
      confidence: 0.8,
      entryPrice: 10,
      slPrice: 9,
      tpPrice: 12,
      patternData: {},
      detectedAt: Date.now(),
      detectedAtBar: 10,
      expiresAtBar: 20,
      exchange: 'HL',
    }]
    const positions: PositionState[] = [{
      positionId: 'pos-1',
      coin: 'BTC',
      side: 'long',
      entryPrice: 10,
      currentSize: 1,
      originalSize: 1,
      slPrice: 9,
      tpPrice: 12,
      entryOrderId: 'ord-1',
      leverage: 3,
      trailingState: null,
      partialClosesFired: [],
      lastSyncAt: Date.now(),
      openedAt: Date.now(),
      thesis: null,
      lastThesisCheckAt: 0,
    }]

    const lines = buildChartLines(setups, positions)
    expect(lines).toHaveLength(6)
    expect(lines.some(line => line.source === 'setup')).toBe(true)
    expect(lines.some(line => line.source === 'position')).toBe(true)
  })
})

