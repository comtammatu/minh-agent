/**
 * Metrics Service — orchestration layer between agent loop and analytics.
 *
 * Sprint 3 S6: Wires trade close events → matview refresh + live metrics query.
 * I/O boundary: calls metrics-repo for DB access, metrics.ts for pure computation.
 *
 * Design:
 *   - onTradeClose(): fire-and-forget matview refresh after position closes
 *   - getLiveMetrics(): build LiveMetrics from DB data for API consumption
 *   - Subscribes to TradingAgent 'trade_closed' event via connectToAgent()
 */

import { log } from '../lib/logger.js'
import { SIMULATED_ACCOUNT, PAPER_TRADE } from '../config.js'
import { getExchangeService } from '../execution/exchange-service.js'
import { getPaperTracker } from '../agent/paper-tracker.js'
import { buildLiveMetrics } from './metrics.js'
import {
  getClosedTrades,
  getOpenPositionCount,
  getPatternPerformance,
  refreshViews,
} from './metrics-repo.js'
import type { LiveMetrics } from './types.js'
import type { TradingAgent } from '../agent/trading-agent.js'

// ─── Trade Close Hook ──────────────────────────────────────────────────────

/**
 * Called after a trade closes. Refreshes matviews so analytics stay fresh.
 * Fire-and-forget: logs errors but never throws (agent loop must not block).
 */
export async function onTradeClose(coin: string, pnl: number): Promise<void> {
  try {
    await refreshViews()
    log.debug('metrics-service', `Matviews refreshed after ${coin} close (pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`)
  } catch (err) {
    log.error('metrics-service', `Matview refresh failed after ${coin} close: ${(err as Error).message}`)
  }
}

// ─── Live Metrics Query ────────────────────────────────────────────────────

/**
 * Build LiveMetrics from current DB state. Called by API endpoint.
 */
export async function getLiveMetrics(): Promise<LiveMetrics> {
  const [allTrades, patternRows, openPositionCount] = await Promise.all([
    getClosedTrades(),
    getPatternPerformance(),
    getOpenPositionCount(),
  ])

  // Paper mode: use PaperTracker balance; real mode: ExchangeService or fallback
  const capital = PAPER_TRADE
    ? getPaperTracker().getBalance()
    : (getExchangeService().getCachedAccountValue() || SIMULATED_ACCOUNT)

  return buildLiveMetrics({
    allTrades,
    patternRows,
    initialCapital: capital,
    openPositionCount,
  })
}

// ─── Agent Integration ─────────────────────────────────────────────────────

/**
 * Connect metrics service to agent's trade_closed events.
 * Call once at startup after agent is initialized.
 */
export function connectToAgent(agent: TradingAgent): void {
  agent.onTradeClose((coin, pnl) => {
    // Fire-and-forget — don't await, don't block agent loop
    onTradeClose(coin, pnl).catch(() => {
      // Already logged inside onTradeClose
    })
  })
  log.info('metrics-service', 'Connected to agent trade_closed events')
}
