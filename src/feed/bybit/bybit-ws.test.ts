import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Mock bybit-api WebsocketClient before importing the module under test.
// The mock must be set up before any dynamic import of bybit-ws.
const mockOn = mock(() => {})
const mockSubscribeV5 = mock(() => {})
const mockUnsubscribeV5 = mock(() => {})

// Provide stubs for every bybit-api named export the runtime imports
// (RestClientV5, WebsocketClient, WebsocketAPIClient). Without this, when
// another test file's mock loads first the `import { RestClientV5 } from
// 'bybit-api'` calls elsewhere fail with `Export named '...' not found`.
mock.module('bybit-api', () => ({
  WebsocketClient: class {
    on = mockOn
    subscribeV5 = mockSubscribeV5
    unsubscribeV5 = mockUnsubscribeV5
  },
  WebsocketAPIClient: class {},
  RestClientV5: class {},
  SpotClientV3: class {},
}))

describe('bybit-ws', () => {
  it('subscribeBybitCandles subscribes to correct topic for 1h', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('BTC', '1h', () => {})
    expect(mockSubscribeV5).toHaveBeenCalledWith(['kline.60.BTCUSDT'], 'linear')
  })

  it('4h maps to interval 240', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('ETH', '4h', () => {})
    expect(mockSubscribeV5).toHaveBeenCalledWith(['kline.240.ETHUSDT'], 'linear')
  })

  it('1m maps to interval 1', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('SOL', '1m', () => {})
    expect(mockSubscribeV5).toHaveBeenCalledWith(['kline.1.SOLUSDT'], 'linear')
  })

  it('1d maps to interval D', async () => {
    const { subscribeBybitCandles } = await import('./bybit-ws.js')
    await subscribeBybitCandles('BTC', '1d', () => {})
    expect(mockSubscribeV5).toHaveBeenCalledWith(['kline.D.BTCUSDT'], 'linear')
  })

  it('checkBybitStaleness does not throw on empty state', async () => {
    const { checkBybitStaleness, closeAllBybit } = await import('./bybit-ws.js')
    // Reset state first so lastCandleTime is empty
    await closeAllBybit()
    expect(() => checkBybitStaleness()).not.toThrow()
  })

  it('unsubscribeBybitCandles does not throw when coin has no subscriptions', async () => {
    const { unsubscribeBybitCandles } = await import('./bybit-ws.js')
    await expect(unsubscribeBybitCandles('UNKNOWN')).resolves.toBeUndefined()
  })
})
