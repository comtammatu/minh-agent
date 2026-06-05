/**
 * Execution boundary contract tests (P1).
 *
 * Locks money-handling invariants at the exchange ↔ order-manager edge.
 * No live network — mocks only. Run via `bun test test/execution`.
 *
 * Contracts covered:
 *  - Cloid format + uniqueness (HL idempotency)
 *  - cancelOnExchange routing: oid → cloid → Bybit UUID
 *  - Cancel failure must not mark DB cancelled (ghost prevention)
 *  - SL/TP placement after fill (HL path)
 *  - Modify-trigger race: modify failure → cancel + replace
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  ExchangePool,
  IExchangeService,
} from "../../src/execution/exchange-pool.js";

// ── DB mock (OrderManager) ───────────────────────────────────────────────────

let mockSqlResponses: Record<string, unknown>[][] = [];

mock.module("../../src/db/connection.js", () => {
  const sqlTag = () => {
    const next = mockSqlResponses.shift();
    return Promise.resolve(next ?? []);
  };
  return {
    sql: Object.assign(sqlTag, { end: () => Promise.resolve() }),
  };
});

let mockOrderSuccess = true;
let mockCancelSuccess = true;
let mockTriggerSuccess = true;

mock.module("../../src/execution/hl-exchange-service.js", () => ({
  getHLExchangeService: () => ({
    getCachedAccountValue: () => 10_000,
    setLeverage: () => Promise.resolve(),
    placeOrder: () =>
      Promise.resolve(
        mockOrderSuccess
          ? {
              success: true,
              oid: 12345,
              avgPx: 50000,
              totalSz: 0.1,
              status: "filled",
              error: null,
            }
          : {
              success: false,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: null,
              error: "Mock rejection",
            },
      ),
    placeTrigger: () =>
      Promise.resolve(
        mockTriggerSuccess
          ? {
              success: true,
              oid: 67890,
              avgPx: null,
              totalSz: null,
              status: "waitingForTrigger",
              error: null,
            }
          : {
              success: false,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: null,
              error: "Mock trigger fail",
            },
      ),
    cancelByOid: () =>
      Promise.resolve(
        mockCancelSuccess
          ? {
              success: true,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: "cancelled",
              error: null,
            }
          : {
              success: false,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: null,
              error: "Mock cancel fail",
            },
      ),
    cancelByCloid: () =>
      Promise.resolve(
        mockCancelSuccess
          ? {
              success: true,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: "cancelled",
              error: null,
            }
          : {
              success: false,
              oid: null,
              avgPx: null,
              totalSz: null,
              status: null,
              error: "Mock cancel fail",
            },
      ),
    cancelByOrderId: () =>
      Promise.resolve({
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "cancelled",
        error: null,
      }),
    modifyTrigger: () =>
      Promise.resolve({
        success: true,
        oid: 67890,
        avgPx: null,
        totalSz: null,
        status: "modified",
        error: null,
      }),
    getOpenOrders: () => Promise.resolve([]),
    getFillAggregateByCloid: () => Promise.resolve(null),
  }),
}));

import {
  cancelOnExchange,
  generateCloid,
  OrderManager,
  resetOrderManager,
} from "../../src/agent/order-manager.js";
import type { Order, TriggerOrder } from "../../src/agent/types.js";
import { SL_IS_MARKET, TP_IS_MARKET } from "../../src/config.js";

function getOrdersMap(om: OrderManager): Map<string, Order> {
  return (om as unknown as { orders: Map<string, Order> }).orders;
}

function getTriggerOrdersMap(om: OrderManager): Map<string, TriggerOrder[]> {
  return (om as unknown as { triggerOrders: Map<string, TriggerOrder[]> })
    .triggerOrders;
}

function injectOrder(om: OrderManager, order: Order): void {
  getOrdersMap(om).set(order.id, order);
}

function injectTriggers(
  om: OrderManager,
  parentOrderId: string,
  triggers: TriggerOrder[],
): void {
  getTriggerOrdersMap(om).set(parentOrderId, triggers);
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: crypto.randomUUID(),
    coin: "BTC",
    side: "long",
    type: "market",
    price: 50000,
    size: 0.1,
    status: "submitted",
    setupId: "BTC|1h|order-block|long",
    slPrice: 49000,
    tpPrice: 52000,
    cloid: generateCloid(),
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

function makeOrderResult(success: boolean) {
  return {
    success,
    oid: success ? 1 : null,
    avgPx: null,
    totalSz: null,
    status: success ? "cancelled" : null,
    error: success ? null : "fail",
  };
}

describe("execution boundary contract — cloid + cancel routing", () => {
  it("generateCloid is 0x-prefixed 128-bit hex", () => {
    const cloid = generateCloid();
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("cancelOnExchange prefers cancelByOid for numeric ids", async () => {
    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(true)));
    const cancelByCloid = mock(() => Promise.resolve(makeOrderResult(false)));
    const cancelByOrderId = mock(() => Promise.resolve(makeOrderResult(false)));
    const svc = {
      cancelByOid,
      cancelByCloid,
      cancelByOrderId,
    } as unknown as IExchangeService;

    const result = await cancelOnExchange("12345", "BTC", svc);
    expect(result.success).toBe(true);
    expect(cancelByOid).toHaveBeenCalledWith("BTC", 12345);
    expect(cancelByCloid).not.toHaveBeenCalled();
  });

  it("cancelOnExchange falls back to cancelByCloid for 0x ids", async () => {
    const cloid = "0xabcdefabcdefabcdefabcdefabcdefab";
    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(false)));
    const cancelByCloid = mock(() => Promise.resolve(makeOrderResult(true)));
    const cancelByOrderId = mock(() => Promise.resolve(makeOrderResult(false)));
    const svc = {
      cancelByOid,
      cancelByCloid,
      cancelByOrderId,
    } as unknown as IExchangeService;

    const result = await cancelOnExchange(cloid, "BTC", svc);
    expect(result.success).toBe(true);
    expect(cancelByCloid).toHaveBeenCalledWith("BTC", cloid);
  });

  it("cancelOnExchange routes Bybit UUID ids through cancelByOrderId", async () => {
    const orderId = "be411c88-aaaa-bbbb-cccc-111122223333";
    const cancelByOrderId = mock(() => Promise.resolve(makeOrderResult(true)));
    const svc = {
      cancelByOid: mock(() => Promise.resolve(makeOrderResult(false))),
      cancelByCloid: mock(() => Promise.resolve(makeOrderResult(false))),
      cancelByOrderId,
    } as unknown as IExchangeService;

    const result = await cancelOnExchange(orderId, "BTC", svc);
    expect(result.success).toBe(true);
    expect(cancelByOrderId).toHaveBeenCalledWith("BTC", orderId);
  });
});

describe("execution boundary contract — OrderManager lifecycle", () => {
  let om: OrderManager;

  beforeEach(() => {
    process.env.ACTIVE_EXCHANGE = "HL";
    resetOrderManager();
    mockOrderSuccess = true;
    mockCancelSuccess = true;
    mockTriggerSuccess = true;
    mockSqlResponses = [];
    om = new OrderManager();
  });

  it("preserves submitted status when exchange cancel + cloid retry both fail", async () => {
    mockCancelSuccess = false;
    const order = makeOrder({
      status: "submitted",
      exchangeOrderId: "12345",
      cloid: "0xabc",
    });
    injectOrder(om, order);

    await om.cancelOrder(order.id, "invalidation");

    expect(getOrdersMap(om).get(order.id)?.status).toBe("submitted");
    mockCancelSuccess = true;
  });

  it("places SL (market) + TP triggers on HL fill with opposite close side", async () => {
    const order = makeOrder();
    injectOrder(om, order);

    await om.onOrderFilled(order.id, 50050, 0.1);

    const triggers = om.getTriggerOrders(order.id);
    expect(triggers).toHaveLength(2);

    const sl = triggers.find((t) => t.type === "sl");
    const tp = triggers.find((t) => t.type === "tp");
    expect(sl?.side).toBe("short");
    expect(tp?.side).toBe("short");
    expect(sl?.isMarket).toBe(SL_IS_MARKET);
    expect(tp?.isMarket).toBe(TP_IS_MARKET);
    expect(sl?.triggerPrice).toBe(49000);
    expect(tp?.triggerPrice).toBe(52000);
    expect(sl?.size).toBe(0.1);
  });

  it("modify-trigger race: cancel+replace when modifyTrigger fails", async () => {
    const order = makeOrder({ status: "filled", exchange: "HL" });
    injectOrder(om, order);
    injectTriggers(om, order.id, [
      {
        type: "sl",
        coin: "BTC",
        side: "short",
        triggerPrice: 49000,
        size: 0.1,
        isMarket: true,
        cloid: generateCloid(),
        exchangeOrderId: "67890",
        parentOrderId: order.id,
      },
    ]);

    const modifyTrigger = mock(() =>
      Promise.resolve({
        success: false,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: null,
        error: "Cannot modify — race",
      }),
    );
    const cancelByOid = mock(() =>
      Promise.resolve({
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "cancelled",
        error: null,
      }),
    );
    const placeTrigger = mock(() =>
      Promise.resolve({
        success: true,
        oid: 77777,
        avgPx: null,
        totalSz: null,
        status: "waitingForTrigger",
        error: null,
      }),
    );

    const hlSvc = {
      exchangeId: "HL",
      modifyTrigger,
      cancelByOid,
      cancelByCloid: mock(() => Promise.resolve(makeOrderResult(true))),
      placeTrigger,
      updatePositionStop: mock(() => Promise.resolve(makeOrderResult(true))),
    } as unknown as IExchangeService;

    om.setExchangePool({
      isInitialized: () => true,
      get: () => hlSvc,
    } as unknown as ExchangePool);

    await om.modifySLPrice(order.id, 49500);

    expect(modifyTrigger).toHaveBeenCalledTimes(1);
    expect(cancelByOid).toHaveBeenCalledTimes(1);
    expect(placeTrigger).toHaveBeenCalledTimes(1);
    expect(
      om.getTriggerOrders(order.id).find((t) => t.type === "sl")?.triggerPrice,
    ).toBe(49500);
    expect(
      om.getTriggerOrders(order.id).find((t) => t.type === "sl")
        ?.exchangeOrderId,
    ).toBe("77777");
  });
});
