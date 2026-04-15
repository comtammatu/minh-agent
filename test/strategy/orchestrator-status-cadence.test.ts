import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Candle, PatternType } from '../../src/types.js'
import { READY_BARS, STATUS_UPDATE_EVERY_BARS } from '../../src/config.js'
import {
  clearPipelineState,
  getStatus,
  getStatusRefreshCount,
  onCandleTick,
} from '../../src/strategy/orchestrator.js'
import { clearOnPersist, clearStore } from '../../src/feed/store.js'
import {
  setSetupGeneratorForTests,
  type SetupGenerator,
} from '../../src/strategy/engine.js'

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
  let originalActiveExchange: string | undefined

  beforeEach(() => {
    originalActiveExchange = process.env['ACTIVE_EXCHANGE']
    process.env['ACTIVE_EXCHANGE'] = 'HL'
    clearPipelineState()
    clearStore()
    clearOnPersist()
    setSetupGeneratorForTests(null)
  })

  afterEach(() => {
    if (originalActiveExchange === undefined) {
      delete process.env['ACTIVE_EXCHANGE']
      return
    }
    process.env['ACTIVE_EXCHANGE'] = originalActiveExchange
  })

  test('status refresh runs slower than setup scan on 5m cadence', () => {
    let scanCalls = 0

    const strategy: SetupGenerator = {
      scan: () => {
        scanCalls++
        return null
      },
      minCandles: () => 2,
      clearState: () => {},
    }
    setSetupGeneratorForTests(strategy)

    const stride = STATUS_UPDATE_EVERY_BARS['5m']
    const scannedBars = stride * 3 + 1
    const totalCandles = READY_BARS['5m'] + scannedBars

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
