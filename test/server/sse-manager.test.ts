/**
 * Tests for SSE connection manager — pure unit tests (no I/O).
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  addClient,
  removeClient,
  getConnectionCounts,
  getTotalConnections,
  broadcast,
  formatSSE,
  sendKeepalive,
  closeAllConnections,
} from '../../src/server/sse-manager.js'

/** Create a mock ReadableStreamDefaultController. */
function mockController(): { ctrl: ReadableStreamDefaultController; chunks: Uint8Array[]; closed: boolean } {
  const chunks: Uint8Array[] = []
  let closed = false
  const ctrl = {
    enqueue(chunk: Uint8Array) {
      if (closed) throw new Error('Controller closed')
      chunks.push(chunk)
    },
    close() {
      closed = true
    },
    error() {},
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController
  return { ctrl, chunks, closed: false }
}

describe('SSE Manager', () => {
  beforeEach(() => {
    // Clean up all connections between tests
    closeAllConnections()
  })

  describe('formatSSE', () => {
    it('formats event + JSON data with double newline', () => {
      const result = formatSSE('status', { value: 42 })
      expect(result).toBe('event: status\ndata: {"value":42}\n\n')
    })

    it('handles string data', () => {
      const result = formatSSE('ping', 'hello')
      expect(result).toBe('event: ping\ndata: "hello"\n\n')
    })

    it('handles null data', () => {
      const result = formatSSE('empty', null)
      expect(result).toBe('event: empty\ndata: null\n\n')
    })
  })

  describe('addClient / removeClient', () => {
    it('adds client and increments count', () => {
      const { ctrl } = mockController()
      const id = addClient('status', ctrl)
      expect(id).toMatch(/^sse_/)
      expect(getTotalConnections()).toBe(1)
    })

    it('tracks multiple clients across channels', () => {
      const { ctrl: c1 } = mockController()
      const { ctrl: c2 } = mockController()
      const { ctrl: c3 } = mockController()
      addClient('status', c1)
      addClient('signals', c2)
      addClient('trades', c3)
      expect(getTotalConnections()).toBe(3)
      const counts = getConnectionCounts()
      expect(counts.status).toBe(1)
      expect(counts.signals).toBe(1)
      expect(counts.trades).toBe(1)
    })

    it('removes client and decrements count', () => {
      const { ctrl } = mockController()
      const id = addClient('status', ctrl)
      expect(getTotalConnections()).toBe(1)
      removeClient(id)
      expect(getTotalConnections()).toBe(0)
    })

    it('removing non-existent client is a no-op', () => {
      removeClient('does_not_exist')
      expect(getTotalConnections()).toBe(0)
    })
  })

  describe('broadcast', () => {
    it('sends to clients on matching channel only', () => {
      const status1 = mockController()
      const status2 = mockController()
      const signals = mockController()
      addClient('status', status1.ctrl)
      addClient('status', status2.ctrl)
      addClient('signals', signals.ctrl)

      broadcast('status', 'update', { value: 1 })

      expect(status1.chunks.length).toBe(1)
      expect(status2.chunks.length).toBe(1)
      expect(signals.chunks.length).toBe(0)

      // Verify content
      const text = new TextDecoder().decode(status1.chunks[0])
      expect(text).toContain('event: update')
      expect(text).toContain('"value":1')
    })

    it('removes dead clients on broadcast error', () => {
      const alive = mockController()
      const dead = mockController()
      addClient('status', alive.ctrl)
      const deadId = addClient('status', dead.ctrl)

      // Simulate dead controller by closing it
      dead.ctrl.close()

      broadcast('status', 'test', { ok: true })

      // Alive client got message
      expect(alive.chunks.length).toBe(1)
      // Dead client was removed
      expect(getTotalConnections()).toBe(1)
    })
  })

  describe('sendKeepalive', () => {
    it('sends comment to all clients regardless of channel', () => {
      const s1 = mockController()
      const s2 = mockController()
      addClient('status', s1.ctrl)
      addClient('signals', s2.ctrl)

      sendKeepalive()

      expect(s1.chunks.length).toBe(1)
      expect(s2.chunks.length).toBe(1)

      const text = new TextDecoder().decode(s1.chunks[0])
      expect(text).toMatch(/^: keepalive \d+\n\n$/)
    })
  })

  describe('closeAllConnections', () => {
    it('closes all clients and resets count', () => {
      const { ctrl: c1 } = mockController()
      const { ctrl: c2 } = mockController()
      addClient('status', c1)
      addClient('signals', c2)
      expect(getTotalConnections()).toBe(2)

      closeAllConnections()
      expect(getTotalConnections()).toBe(0)
    })
  })
})
