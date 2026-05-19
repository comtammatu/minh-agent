import { mock } from 'bun:test'

// Shared spy instances for the bybit-api WebsocketClient mock. Both the
// preload file (test/preload/bybit-api.mock.ts) and test files that assert
// against these spies import them from THIS file so module identity is
// guaranteed regardless of resolver behaviour.
export const bybitWsSpies = {
  subscribeV5: mock((_topic: string | string[], _category?: string) => undefined),
  unsubscribeV5: mock((_topic: string | string[], _category?: string) => undefined),
}
