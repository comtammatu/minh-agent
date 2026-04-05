/**
 * Zustand store for SSE real-time data.
 *
 * Three SSE channels:
 *   - status: agent state + positions + health (periodic)
 *   - signals: pipeline setups + invalidations (event-driven)
 *   - trades: order fills + position changes (event-driven)
 *
 * Types aligned with server-side payloads (src/server/sse.ts buildStatusPayload).
 */

import { create } from 'zustand'

// ─── Types (aligned with server) ────────────────────────────────────────────

/** Agent state per coin — matches AgentSnapshot.coins[coin] from server. */
export interface CoinState {
  state: 'IDLE' | 'WATCHING' | 'ENTERING' | 'IN_POSITION' | 'EXITING' | 'PAUSED'
  activeSetup: Record<string, unknown> | null
  pendingOrderId: string | null
  positionId: string | null
  consecutiveLosses: number
  stateAge: number
}

/** Agent global state — matches AgentSnapshot.global from server. */
export interface AgentGlobal {
  dailyPnl: number
  totalConsecutiveLosses: number
  globalPaused: boolean
  globalPauseReason: string | null
  uptime: number
}

/** Agent snapshot — matches getAgent().getSnapshot(). */
export interface AgentSnapshot {
  coins: Record<string, CoinState>
  global: AgentGlobal
}

/** Position from SSE — matches sse.ts buildStatusPayload positions array. */
export interface Position {
  id: string
  coin: string
  side: 'long' | 'short'
  size: number
  originalSize: number
  entryPrice: number
  slPrice: number
  tpPrice: number
  unrealizedPnl: number
  trailingActive: boolean
  openedAt: number
  partialClosesFired: number
  strategyId: string
}

/** Health from SSE — matches sse.ts buildStatusPayload health. */
export interface HealthStatus {
  overall: string
  rssBytes: number
}

/** Full status payload from SSE /api/stream/status. */
export interface StatusPayload {
  agent: AgentSnapshot
  positions: Position[]
  health: HealthStatus
  ts: number
}

/** Signal event from SSE /api/stream/signals. */
export interface SignalEvent {
  type: 'setup' | 'invalidation'
  data: Record<string, unknown>
  ts: number
}

/** Trade event from SSE /api/stream/trades. */
export interface TradeEvent {
  type: string
  data: Record<string, unknown>
  ts: number
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface SSEState {
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
