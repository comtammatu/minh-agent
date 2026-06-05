import { describe, expect, it } from "bun:test";
import { planOrderReconciliation } from "./order-reconciler.js";
import type { ExchangeOpenOrderSnapshot, Order } from "./types.js";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    coin: "BTC",
    side: "long",
    type: "limit",
    price: 100,
    size: 1,
    status: "submitted",
    setupId: null,
    slPrice: 95,
    tpPrice: 110,
    cloid: "0xabc",
    exchangeOrderId: "12345",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filledAt: null,
    fillPrice: null,
    fillSize: 0,
    positionId: null,
    exchange: "HL",
    ...overrides,
  };
}

function makeExchange(
  overrides: Partial<ExchangeOpenOrderSnapshot> = {},
): ExchangeOpenOrderSnapshot {
  return {
    coin: "BTC",
    exchangeOrderId: "12345",
    cloid: null,
    side: "long",
    size: 1,
    price: 100,
    ...overrides,
  };
}

describe("planOrderReconciliation", () => {
  it("retries cancel for stale active DB order still on exchange", () => {
    const actions = planOrderReconciliation({
      dbOrders: [makeOrder({ status: "submitted" })],
      exchangeOrders: [makeExchange()],
      pendingByCoin: new Map([["BTC", null]]),
    });
    expect(actions).toEqual([
      {
        type: "retry_cancel",
        orderId: "order-1",
        reason: "reconcile:stale_active",
      },
    ]);
  });

  it("skips legitimate pending order tracked by agent", () => {
    const actions = planOrderReconciliation({
      dbOrders: [makeOrder({ id: "order-1", status: "submitted" })],
      exchangeOrders: [makeExchange()],
      pendingByCoin: new Map([["BTC", "order-1"]]),
    });
    expect(actions).toEqual([]);
  });

  it("cancels exchange ghost when DB already marked cancelled", () => {
    const actions = planOrderReconciliation({
      dbOrders: [makeOrder({ status: "cancelled" })],
      exchangeOrders: [makeExchange()],
      pendingByCoin: new Map(),
    });
    expect(actions).toEqual([
      {
        type: "cancel_exchange",
        coin: "BTC",
        exchangeOrderId: "12345",
        cloid: "0xabc",
        reason: "reconcile:ghost_cancelled_db",
      },
    ]);
  });

  it("alerts on orphan exchange orders with no DB match", () => {
    const actions = planOrderReconciliation({
      dbOrders: [],
      exchangeOrders: [makeExchange({ coin: "ETH", exchangeOrderId: "999" })],
      pendingByCoin: new Map(),
    });
    expect(actions).toEqual([
      {
        type: "alert",
        coin: "ETH",
        message: "orphan exchange order ETH oid=999",
      },
    ]);
  });

  it("matches exchange orders by cloid when oid differs", () => {
    const actions = planOrderReconciliation({
      dbOrders: [
        makeOrder({
          status: "cancelled",
          cloid: "0xdead",
          exchangeOrderId: "old-id",
        }),
      ],
      exchangeOrders: [
        makeExchange({
          exchangeOrderId: "67890",
          cloid: "0xdead",
        }),
      ],
      pendingByCoin: new Map(),
    });
    expect(actions[0]?.type).toBe("cancel_exchange");
  });
});
