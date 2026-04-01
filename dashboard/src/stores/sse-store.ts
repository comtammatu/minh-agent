/**
 * Zustand store for SSE real-time data.
 *
 * Three SSE channels:
 *   - status: agent state + positions + health (periodic)
 *   - signals: pipeline setups + invalidations (event-driven)
 *   - trades: order fills + position changes (event-driven)
 */

import { create } from 'zustand'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Position {
  id: string
  coin: string
  side: string
  size: number
  entryPrice: number
  unrealizedPnl: number
  trailingActive: boolean
}

interface StatusPayload {
  agent: Record<string, unknown>
  positions: Position[]
  health: { overall: string; rssBytes: number }
  ts: number
}

interface SignalEvent {
  type: 'setup' | 'invalidation'
  data: Record<string, unknown>
  ts: number
}

interface TradeEvent {
  type: string
  data: Record<string, unknown>
  ts: number
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface SSEState {
  connected: boolean
  status: StatusPayload | null
  signals: SignalEvent[]
  trades: TradeEvent[]
  lastUpdate: number | null

  setConnected: (v: boolean) => void
  setStatus: (payload: StatusPayload) => void
  addSignal: (event: SignalEvent) => void
  addTrade: (event: TradeEvent) => void
}

/** Max events to keep in memory per channel (ring buffer). */
const MAX_EVENTS = 200

export const useSSEStore = create<SSEState>((set) => ({
  connected: false,
  status: null,
  signals: [],
  trades: [],
  lastUpdate: null,

  setConnected: (v) => set({ connected: v }),

  setStatus: (payload) => set({
    status: payload,
    lastUpdate: Date.now(),
  }),

  addSignal: (event) => set((state) => ({
    signals: [...state.signals.slice(-(MAX_EVENTS - 1)), event],
    lastUpdate: Date.now(),
  })),

  addTrade: (event) => set((state) => ({
    trades: [...state.trades.slice(-(MAX_EVENTS - 1)), event],
    lastUpdate: Date.now(),
  })),
}))
