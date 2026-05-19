import { mock } from 'bun:test'

// Spies shared between the bybit-api preload mock and test files. Use
// globalThis as the singleton store so module identity differences between
// the preload module instance and the test-file module instance (which can
// resolve to separate copies under bun's resolver in some environments)
// do not produce divergent spy objects.

type Spies = {
  subscribeV5: ReturnType<typeof mock>
  unsubscribeV5: ReturnType<typeof mock>
}

const GLOBAL_KEY = '__bybitWsSpies__' as const

type WithSpies = typeof globalThis & { [GLOBAL_KEY]?: Spies }

function ensureSpies(): Spies {
  const g = globalThis as WithSpies
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      subscribeV5: mock((_topic: string | string[], _category?: string) => undefined),
      unsubscribeV5: mock((_topic: string | string[], _category?: string) => undefined),
    }
  }
  return g[GLOBAL_KEY]!
}

export const bybitWsSpies = ensureSpies()
