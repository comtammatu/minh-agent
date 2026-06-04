/**
 * closeAllPositions — shared helper for emergency close-all.
 *
 * Used by both dashboard server API (/api/operator/closeall) and Telegram /closeall command.
 * Lives in agent/ because it orchestrates I/O (OrderManager + PositionMonitor).
 */

import { getOrderManager } from "./order-manager.js";
import { getPositionMonitor } from "./position-monitor.js";
import { getAgent } from "./trading-agent.js";

export interface CloseAllResult {
  cancelled: number;
  closed: number;
}

/** Injectable deps for testing without mock.module (avoids global mock leaks). */
export interface CloseAllDeps {
  agent: { pauseAll(reason: string): void };
  om: {
    getOrders(): Map<string, { id: string; status: string }>;
    cancelOrder(id: string, reason: string): Promise<void>;
    handleAction(action: {
      type: string;
      positionId: string;
      reason: string;
    }): Promise<void>;
  };
  pm: { getPositions(): Map<string, { positionId: string; coin: string }> };
}

/**
 * Emergency close-all: pause agent, cancel pending orders, close open positions.
 *
 * @param reason - logged reason for the close-all action
 * @param deps - optional dependency injection for testing
 * @returns counts of cancelled orders and closed positions
 */
export async function closeAllPositions(
  reason: string,
  deps?: CloseAllDeps,
): Promise<CloseAllResult> {
  const agent = deps?.agent ?? getAgent();
  const om = deps?.om ?? getOrderManager();
  const pm = deps?.pm ?? getPositionMonitor();

  // 1. Pause agent first to prevent new entries
  agent.pauseAll(reason);

  // 2. Cancel all pending orders
  const orders = om.getOrders();
  let cancelled = 0;
  for (const [id, order] of orders) {
    if (order.status === "pending" || order.status === "submitted") {
      await om.cancelOrder(id, reason);
      cancelled++;
    }
  }

  // 3. Close all open positions
  const positions = pm.getPositions();
  let closed = 0;
  for (const [posId] of positions) {
    await om.handleAction({
      type: "close_position",
      positionId: posId,
      reason,
    });
    closed++;
  }

  return { cancelled, closed };
}
