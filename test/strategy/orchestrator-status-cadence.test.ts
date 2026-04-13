import { beforeEach, describe, expect, test } from 'bun:test'
import type { Candle, PatternType } from '../../src/types.js'
import { MIN_CANDLES_FOR_SCAN, STATUS_UPDATE_EVERY_BARS } from '../../src/config.js'
import {
  clearPipelineState,
  getStatus,
  getStatusRefreshCount,
  onCandleTick,
} from '../../src/strategy/orchestrator.js'
import { clearOnPersist, clearStore } from '../../src/feed/store.js'
import { getStrategyRegistry, resetStrategyRegistry } from '../../src/strategy/registry.js'
import type { IStrategy } from '../../src/strategy/registry.js'

const STEP_5M_MS = 300_000
const START_TS = Date.UTC(2024, 0, 1)

function makeCandle(i: number): Candle {
  const base = 100 + i * 0.15
  return {
    t: START_TS + i * STEP_5M_MS,
    o: base,
    h: base + 0.5,
    l: base - 0.5,
    c: base + (i % 2 === 0 ? 0.1 : -0.1),
    v: 1000 + i * 2,
  }
}

describe('orchestrator status cadence', () => {
  beforeEach(() => {
    clearPipelineState()
    clearStore()
    clearOnPersist()
    resetStrategyRegistry()
  })

  test('status refresh runs slower than setup scan on 5m cadence', () => {
    let scanCalls = 0

    const strategy: IStrategy = {
      id: 'cadence-mock',
      name: 'Cadence Mock',
      patternTypes: ['smc-sd' as PatternType],
      scan: () => {
        scanCalls++
        return null
      },
      minCandles: () => 2,
      clearState: () => {},
    }

    const registry = getStrategyRegistry()
    registry.register(strategy)
    registry.activateOnly('cadence-mock')

    const stride = STATUS_UPDATE_EVERY_BARS['5m']
    const scannedBars = stride * 3 + 1
    const totalCandles = MIN_CANDLES_FOR_SCAN + scannedBars

    for (let i = 0; i < totalCandles; i++) {
      onCandleTick('BTC', '5m', makeCandle(i))
    }

    // Setup scan runs on every closed candle once warmup bars are available.
    expect(scanCalls).toBe(scannedBars)

    // Status refresh follows configured cadence, not every scan.
    const expectedRefreshes = 1 + Math.floor((scannedBars - 1) / stride)
    expect(getStatusRefreshCount('BTC', '5m')).toBe(expectedRefreshes)

    const snapshot = getStatus().find(s => s.coin === 'BTC' && s.interval === '5m')
    expect(snapshot).toBeDefined()
    expect(snapshot!.activeCount).toBe(0)
  })
})
