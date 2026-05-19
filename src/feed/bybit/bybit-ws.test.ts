import { describe, it, expect, beforeEach } from 'bun:test'
import { bybitWsSpies } from '../../../test/preload/bybit-spies.js'

// The bybit-api mock lives in test/preload/bybit-api.mock.ts (wired via
// bunfig.toml). It loads BEFORE any test file, so bybit-ws.ts's static
// `import { WebsocketClient }` binds to the preload's MockWebsocketClient
// before this file can mock.module() again. We share spies through the
// preload module instead of re-mocking here.

describe('bybit-ws', () => {
  beforeEach(() => {
    bybitWsSpies.subscribeV5.mockClear()
    bybitWsSpies.unsubscribeV5.mockClear()
  })

  it('subscribeBybitCandles subscribes to correct topic for 1h', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('BTC', '1h', () => {})
    expect(bybitWsSpies.subscribeV5).toHaveBeenCalledWith(['kline.60.BTCUSDT'], 'linear')
  })

  it('4h maps to interval 240', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('ETH', '4h', () => {})
    expect(bybitWsSpies.subscribeV5).toHaveBeenCalledWith(['kline.240.ETHUSDT'], 'linear')
  })

  it('1m maps to interval 1', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('SOL', '1m', () => {})
    expect(bybitWsSpies.subscribeV5).toHaveBeenCalledWith(['kline.1.SOLUSDT'], 'linear')
  })

  it('1d maps to interval D', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('BTC', '1d', () => {})
    expect(bybitWsSpies.subscribeV5).toHaveBeenCalledWith(['kline.D.BTCUSDT'], 'linear')
  })

  it('checkBybitStaleness does not throw on empty state', async () => {
    const { checkBybitStaleness, closeAllBybit } = await import('./bybit-ws.js')
    await closeAllBybit()
    expect(() => checkBybitStaleness()).not.toThrow()
  })

  it('unsubscribeBybitCandles does not throw when coin has no subscriptions', async () => {
    const { unsubscribeBybitCandles } = await import('./bybit-ws.js')
    await expect(unsubscribeBybitCandles('UNKNOWN')).resolves.toBeUndefined()
  })
})
