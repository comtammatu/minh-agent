/**
 * closeAllPositions — shared helper for emergency close-all.
 *
 * Used by both Elysia API endpoint and Telegram /closeall command (E19).
 * Lives in agent/ because it orchestrates I/O (OrderManager + PositionMonitor).
 */

import { getAgent } from './trading-agent.js'
import { getOrderManager } from './order-manager.js'
import { getPositionMonitor } from './position-monitor.js'

export interface CloseAllResult {
  cancelled: number
  closed: number
}

/**
 * Emergency close-all: pause agent, cancel pending orders, close open positions.
 *
 * @param reason - logged reason for the close-all action
 * @returns counts of cancelled orders and closed positions
 */
export async function closeAllPositions(reason: string): Promise<CloseAllResult> {
  const agent = getAgent()
  const om = getOrderManager()
  const pm = getPositionMonitor()

  // 1. Pause agent first to prevent new entries
  agent.pauseAll(reason)

  // 2. Cancel all pending orders
  const orders = om.getOrders()
  let cancelled = 0
  for (const [id, order] of orders) {
    if (order.status === 'pending' || order.status === 'submitted') {
      await om.cancelOrder(id, reason)
      cancelled++
    }
  }

  // 3. Close all open positions
  const positions = pm.getPositions()
  let closed = 0
  for (const [posId] of positions) {
    await om.handleAction({ type: 'close_position', positionId: posId, reason })
    closed++
  }

  return { cancelled, closed }
}
