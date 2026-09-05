/**
 * closeAllPositions — shared helper for emergency close-all.
 *
 * Used by both dashboard server API (/api/operator/closeall) and Telegram /closeall command.
 * Lives in agent/ because it orchestrates I/O (OrderManager + PositionMonitor).
 */

import { getExecution, isExecutionInitialized } from "../app/execution.js";
import { getOrderManager } from "./order-manager.js";
import {
  getPositionMonitor,
  queryExchangePositions,
} from "./position-monitor.js";
import { getAgent } from "./trading-agent.js";
import type { AgentAction } from "./types.js";

export interface CloseAllResult {
  cancelled: number;
  closed: number;
  verifiedFlat: boolean;
  remainingPositions: number;
  remainingOrders: number;
}

export interface CloseAllVerification {
  remainingPositions: number;
  remainingOrders: number;
  exchangeVerified: boolean;
}

/** Injectable deps for testing without mock.module (avoids global mock leaks). */
export interface CloseAllDeps {
  agent: { pauseAll(reason: string): void };
  om: {
    getOrders(): Map<string, { id: string; status: string }>;
    cancelOrder(id: string, reason: string): Promise<void>;
    handleAction(action: AgentAction): Promise<void>;
  };
  pm: { getPositions(): Map<string, { positionId: string; coin: string }> };
  verifyFlat?: () => Promise<CloseAllVerification>;
}

function countLocalOpenOrders(
  orders: Map<string, { id: string; status: string }>,
): number {
  let count = 0;
  for (const [, order] of orders) {
    if (order.status === "pending" || order.status === "submitted") {
      count++;
    }
  }
  return count;
}

function localVerification(
  om: CloseAllDeps["om"],
  pm: CloseAllDeps["pm"],
): CloseAllVerification {
  return {
    remainingPositions: pm.getPositions().size,
    remainingOrders: countLocalOpenOrders(om.getOrders()),
    exchangeVerified: false,
  };
}

async function exchangeVerification(
  om: CloseAllDeps["om"],
  pm: CloseAllDeps["pm"],
): Promise<CloseAllVerification> {
  let exchangeVerified = true;
  let remainingPositions = 0;
  let remainingOrders = 0;

  const positions = await queryExchangePositions();
  if (positions === null) {
    exchangeVerified = false;
    remainingPositions = pm.getPositions().size;
  } else {
    remainingPositions = positions.filter(
      (pos) => Math.abs(pos.size) > 0,
    ).length;
  }

  try {
    if (!isExecutionInitialized()) {
      exchangeVerified = false;
      remainingOrders = countLocalOpenOrders(om.getOrders());
    } else {
      const orders = await getExecution().getOpenOrders();
      if (orders === null) {
        exchangeVerified = false;
        remainingOrders = countLocalOpenOrders(om.getOrders());
      } else {
        remainingOrders = orders.length;
      }
    }
  } catch {
    exchangeVerified = false;
    remainingOrders = countLocalOpenOrders(om.getOrders());
  }

  return { remainingPositions, remainingOrders, exchangeVerified };
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

  const verification = deps?.verifyFlat
    ? await deps.verifyFlat()
    : deps
      ? localVerification(om, pm)
      : await exchangeVerification(om, pm);

  return {
    cancelled,
    closed,
    verifiedFlat:
      verification.exchangeVerified &&
      verification.remainingPositions === 0 &&
      verification.remainingOrders === 0,
    remainingPositions: verification.remainingPositions,
    remainingOrders: verification.remainingOrders,
  };
}
