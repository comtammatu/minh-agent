import type { ExchangeOpenOrderSnapshot, Order, OrderStatus } from "./types.js";

export type OrderReconcileAction =
  | { type: "retry_cancel"; orderId: string; reason: string }
  | {
      type: "cancel_exchange";
      coin: string;
      exchangeOrderId: string;
      cloid: string | null;
      reason: string;
    }
  | { type: "alert"; message: string; orderId?: string; coin?: string };

export interface OrderReconcileInput {
  dbOrders: Order[];
  exchangeOrders: ExchangeOpenOrderSnapshot[];
  /** Coin → agent pendingOrderId (null when coin is not ENTERING). */
  pendingByCoin: Map<string, string | null>;
}

const ACTIVE_STATUSES = new Set<OrderStatus>([
  "pending",
  "submitted",
  "partial",
]);

function buildExchangeIndex(
  exchangeOrders: ExchangeOpenOrderSnapshot[],
): Map<string, ExchangeOpenOrderSnapshot> {
  const index = new Map<string, ExchangeOpenOrderSnapshot>();
  for (const order of exchangeOrders) {
    index.set(`${order.coin}|oid|${order.exchangeOrderId}`, order);
    if (order.cloid) {
      index.set(`${order.coin}|cloid|${order.cloid}`, order);
    }
  }
  return index;
}

function findExchangeMatch(
  order: Order,
  index: Map<string, ExchangeOpenOrderSnapshot>,
): ExchangeOpenOrderSnapshot | null {
  if (order.exchangeOrderId) {
    const byOid = index.get(`${order.coin}|oid|${order.exchangeOrderId}`);
    if (byOid) return byOid;
  }
  if (order.cloid.trim().length > 0) {
    const byCloid = index.get(`${order.coin}|cloid|${order.cloid}`);
    if (byCloid) return byCloid;
  }
  if (
    order.exchangeOrderId?.startsWith("0x") &&
    order.cloid.trim().length === 0
  ) {
    const legacy = index.get(`${order.coin}|cloid|${order.exchangeOrderId}`);
    if (legacy) return legacy;
  }
  return null;
}

function isLegitimatePendingOrder(
  order: Order,
  pendingByCoin: Map<string, string | null>,
): boolean {
  if (!ACTIVE_STATUSES.has(order.status)) return false;
  return pendingByCoin.get(order.coin) === order.id;
}

function markExchangeMatched(
  snapshot: ExchangeOpenOrderSnapshot,
  matched: Set<string>,
): void {
  matched.add(`${snapshot.coin}|oid|${snapshot.exchangeOrderId}`);
}

/**
 * Pure reconciliation planner: diff DB orders vs exchange open orders.
 * Does not mutate state or perform I/O.
 */
export function planOrderReconciliation(
  input: OrderReconcileInput,
): OrderReconcileAction[] {
  const actions: OrderReconcileAction[] = [];
  const index = buildExchangeIndex(input.exchangeOrders);
  const matchedExchange = new Set<string>();

  for (const order of input.dbOrders) {
    const exchangeMatch = findExchangeMatch(order, index);
    if (!exchangeMatch) continue;

    markExchangeMatched(exchangeMatch, matchedExchange);

    if (order.status === "cancelled") {
      actions.push({
        type: "cancel_exchange",
        coin: order.coin,
        exchangeOrderId: exchangeMatch.exchangeOrderId,
        cloid: exchangeMatch.cloid ?? order.cloid,
        reason: "reconcile:ghost_cancelled_db",
      });
      continue;
    }

    if (
      ACTIVE_STATUSES.has(order.status) &&
      !isLegitimatePendingOrder(order, input.pendingByCoin)
    ) {
      actions.push({
        type: "retry_cancel",
        orderId: order.id,
        reason: "reconcile:stale_active",
      });
    }
  }

  for (const exchangeOrder of input.exchangeOrders) {
    const key = `${exchangeOrder.coin}|oid|${exchangeOrder.exchangeOrderId}`;
    if (matchedExchange.has(key)) continue;
    actions.push({
      type: "alert",
      coin: exchangeOrder.coin,
      message: `orphan exchange order ${exchangeOrder.coin} oid=${exchangeOrder.exchangeOrderId}`,
    });
  }

  return actions;
}
