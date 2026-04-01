/**
 * SSE Connection Manager — tracks active SSE connections and broadcasts events.
 *
 * Sprint 3 S7: Manages SSE streams for dashboard real-time updates.
 *
 * Design:
 *   - Per-channel connection tracking (status, signals, trades)
 *   - Automatic cleanup on client disconnect
 *   - Throttled periodic push for status channel
 *   - Event-driven push for signals and trades channels
 *
 * Pure manager — no I/O except writing to response streams.
 */

import { log } from '../lib/logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type SSEChannel = 'status' | 'signals' | 'trades' | 'backtest'

export interface SSEClient {
  id: string
  channel: SSEChannel
  controller: ReadableStreamDefaultController
  connectedAt: number
}

// ─── Connection Registry ────────────────────────────────────────────────────

const clients = new Map<string, SSEClient>()
let nextId = 0

/** Register a new SSE client. Returns client ID for cleanup. */
export function addClient(
  channel: SSEChannel,
  controller: ReadableStreamDefaultController,
): string {
  const id = `sse_${++nextId}_${Date.now()}`
  clients.set(id, { id, channel, controller, connectedAt: Date.now() })
  log.debug('sse', `Client connected: ${id} on channel=${channel} (total=${clients.size})`)
  return id
}

/** Remove a disconnected client. */
export function removeClient(id: string): void {
  const client = clients.get(id)
  if (client) {
    clients.delete(id)
    log.debug('sse', `Client disconnected: ${id} channel=${client.channel} (total=${clients.size})`)
  }
}

/** Get count of active connections per channel. */
export function getConnectionCounts(): Record<SSEChannel, number> {
  const counts: Record<SSEChannel, number> = { status: 0, signals: 0, trades: 0, backtest: 0 }
  for (const client of clients.values()) {
    counts[client.channel]++
  }
  return counts
}

/** Get total active connection count. */
export function getTotalConnections(): number {
  return clients.size
}

// ─── Broadcasting ───────────────────────────────────────────────────────────

/** Format SSE message according to spec: event + data + double newline. */
export function formatSSE(event: string, data: unknown): string {
  const json = JSON.stringify(data)
  return `event: ${event}\ndata: ${json}\n\n`
}

/**
 * Broadcast an event to all clients on a specific channel.
 * Silently removes clients that fail to receive (disconnected).
 */
export function broadcast(channel: SSEChannel, event: string, data: unknown): void {
  const message = formatSSE(event, data)
  const encoder = new TextEncoder()
  const encoded = encoder.encode(message)

  for (const [id, client] of clients) {
    if (client.channel !== channel) continue
    try {
      client.controller.enqueue(encoded)
    } catch {
      // Client disconnected — clean up
      clients.delete(id)
      log.debug('sse', `Removed dead client: ${id}`)
    }
  }
}

/**
 * Send a keepalive comment to all clients (prevents proxy/browser timeout).
 * SSE spec: lines starting with ":" are comments, ignored by EventSource.
 */
export function sendKeepalive(): void {
  const encoder = new TextEncoder()
  const msg = encoder.encode(`: keepalive ${Date.now()}\n\n`)

  for (const [id, client] of clients) {
    try {
      client.controller.enqueue(msg)
    } catch {
      clients.delete(id)
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/** Close all connections (for graceful shutdown). */
export function closeAllConnections(): void {
  for (const [id, client] of clients) {
    try {
      client.controller.close()
    } catch {
      // Already closed
    }
  }
  clients.clear()
  log.debug('sse', 'All SSE connections closed')
}
