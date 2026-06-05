/**
 * Execution boundary contract tests (P1).
 *
 * Locks money-handling invariants at the exchange ↔ order-manager edge.
 * No live network — mocks only. Run via `bun test test/execution`.
 *
 * Contracts covered:
 *  - Cloid format + uniqueness (HL idempotency)
 *  - cancelOnExchange routing: oid → cloid → Bybit UUID (incl. 0x parseInt regression)
 *  - Cancel failure must not mark DB cancelled (ghost prevention)
 *  - SL/TP placement after fill (HL path) + BB inline skip
 *  - Modify-trigger race: modify failure → cancel + replace
 *  - reconcileWithExchange: ghost cancel, stale retry, paper-mode skip
 *  - submitToExchange forwards inline SL/TP to BB placeOrder
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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
  submitToExchange,
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

function orderToDbRow(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    coin: order.coin,
    side: order.side,
    type: order.type,
    price: order.price,
    size: order.size,
    status: order.status,
    setup_id: order.setupId,
    sl_price: order.slPrice,
    tp_price: order.tpPrice,
    cloid: order.cloid,
    exchange_order_id: order.exchangeOrderId,
    created_at: new Date(order.createdAt).toISOString(),
    updated_at: new Date(order.updatedAt).toISOString(),
    filled_at: order.filledAt ? new Date(order.filledAt).toISOString() : null,
    fill_price: order.fillPrice,
    fill_size: order.fillSize,
    position_id: order.positionId,
    exchange: order.exchange,
  };
}

function resetReconcileThrottle(om: OrderManager): void {
  (om as unknown as { lastReconcileAt: number }).lastReconcileAt = 0;
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

  it("cancelOnExchange never routes 0x cloid through cancelByOid(0) — parseInt regression", async () => {
    const cloid = "0x0000000000000000000000000000000000000001";
    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(true)));
    const cancelByCloid = mock(() => Promise.resolve(makeOrderResult(true)));
    const svc = {
      cancelByOid,
      cancelByCloid,
      cancelByOrderId: mock(() => Promise.resolve(makeOrderResult(false))),
    } as unknown as IExchangeService;

    await cancelOnExchange(cloid, "BTC", svc);
    expect(cancelByCloid).toHaveBeenCalledWith("BTC", cloid);
    expect(cancelByOid).not.toHaveBeenCalled();
  });
});

describe("execution boundary contract — submitToExchange inline SL/TP", () => {
  it("forwards slPrice and tpPrice to BB placeOrder payload", async () => {
    const placeOrder = mock(() =>
      Promise.resolve({
        success: true,
        oid: null,
        rawOrderId: "bb-order-1",
        avgPx: 50000,
        totalSz: 0.1,
        status: "filled",
        error: null,
      }),
    );
    const svc = {
      exchangeId: "BB",
      placeOrder,
    } as unknown as IExchangeService;

    const result = await submitToExchange(
      "BTC",
      "long",
      "limit",
      50000,
      0.1,
      generateCloid(),
      svc,
      49000,
      52000,
    );

    expect(result.success).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const payload = (
      placeOrder.mock.calls[0] as [
        {
          slPrice?: number;
          tpPrice?: number;
          cloid: string;
        },
      ]
    )[0];
    expect(payload.slPrice).toBe(49000);
    expect(payload.tpPrice).toBe(52000);
  });
});

describe("execution boundary contract — OrderManager lifecycle", () => {
  let om: OrderManager;
  const originalPaperTrade = process.env.PAPER_TRADE;

  beforeEach(() => {
    process.env.ACTIVE_EXCHANGE = "HL";
    process.env.PAPER_TRADE = "true";
    resetOrderManager();
    mockOrderSuccess = true;
    mockCancelSuccess = true;
    mockTriggerSuccess = true;
    mockSqlResponses = [];
    om = new OrderManager();
  });

  afterEach(() => {
    if (originalPaperTrade === undefined) {
      delete process.env.PAPER_TRADE;
    } else {
      process.env.PAPER_TRADE = originalPaperTrade;
    }
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

  it("BB fill skips post-fill trigger placement — SL/TP set inline at submit", async () => {
    process.env.ACTIVE_EXCHANGE = "BB";
    const placeTrigger = mock(() =>
      Promise.resolve({
        success: true,
        oid: 67890,
        avgPx: null,
        totalSz: null,
        status: "waitingForTrigger",
        error: null,
      }),
    );
    const bbSvc = {
      exchangeId: "BB",
      placeTrigger,
      getCachedAccountValue: () => 10_000,
      getMaxLeverage: () => 100,
    } as unknown as IExchangeService;

    om.setExchangePool({
      isInitialized: () => true,
      get: () => bbSvc,
    } as unknown as ExchangePool);

    const order = makeOrder({ exchange: "BB" });
    injectOrder(om, order);

    await om.onOrderFilled(order.id, 50050, 0.1);

    expect(placeTrigger).not.toHaveBeenCalled();
    expect(om.getTriggerOrders(order.id)).toHaveLength(0);
  });
});

describe("execution boundary contract — reconcileWithExchange", () => {
  let om: OrderManager;
  const originalPaperTrade = process.env.PAPER_TRADE;

  beforeEach(() => {
    process.env.ACTIVE_EXCHANGE = "HL";
    process.env.PAPER_TRADE = "false";
    resetOrderManager();
    mockCancelSuccess = true;
    mockSqlResponses = [];
    om = new OrderManager();
    resetReconcileThrottle(om);
  });

  afterEach(() => {
    if (originalPaperTrade === undefined) {
      delete process.env.PAPER_TRADE;
    } else {
      process.env.PAPER_TRADE = originalPaperTrade;
    }
  });

  it("skips reconciliation in paper mode", async () => {
    process.env.PAPER_TRADE = "true";
    const getOpenOrders = mock(() => Promise.resolve([]));

    om.setExchangePool({
      isInitialized: () => true,
      get: () =>
        ({
          exchangeId: "HL",
          getOpenOrders,
        }) as unknown as IExchangeService,
    } as unknown as ExchangePool);

    await om.reconcileWithExchange(new Map());

    expect(getOpenOrders).not.toHaveBeenCalled();
  });

  it("cancels exchange ghost when DB order is already cancelled", async () => {
    const order = makeOrder({
      status: "cancelled",
      exchangeOrderId: "12345",
      cloid: "0xghost",
    });
    mockSqlResponses.push([orderToDbRow(order)]);

    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(true)));
    const getOpenOrders = mock(() =>
      Promise.resolve([
        {
          coin: "BTC",
          exchangeOrderId: "12345",
          cloid: "0xghost",
          side: "long" as const,
          size: 0.1,
          price: 50000,
        },
      ]),
    );

    om.setExchangePool({
      isInitialized: () => true,
      get: () =>
        ({
          exchangeId: "HL",
          getOpenOrders,
          cancelByOid,
          cancelByCloid: mock(() => Promise.resolve(makeOrderResult(true))),
          cancelByOrderId: mock(() => Promise.resolve(makeOrderResult(true))),
        }) as unknown as IExchangeService,
    } as unknown as ExchangePool);

    await om.reconcileWithExchange(new Map());

    expect(getOpenOrders).toHaveBeenCalledTimes(1);
    expect(cancelByOid).toHaveBeenCalledWith("BTC", 12345);
  });

  it("retries cancel for stale active DB order still live on exchange", async () => {
    const order = makeOrder({
      id: "stale-order-1",
      status: "submitted",
      exchangeOrderId: "99999",
    });
    mockSqlResponses.push([orderToDbRow(order)]);

    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(true)));
    const getOpenOrders = mock(() =>
      Promise.resolve([
        {
          coin: "BTC",
          exchangeOrderId: "99999",
          cloid: null,
          side: "long" as const,
          size: 0.1,
          price: 50000,
        },
      ]),
    );

    om.setExchangePool({
      isInitialized: () => true,
      get: () =>
        ({
          exchangeId: "HL",
          getOpenOrders,
          cancelByOid,
          cancelByCloid: mock(() => Promise.resolve(makeOrderResult(true))),
          cancelByOrderId: mock(() => Promise.resolve(makeOrderResult(true))),
        }) as unknown as IExchangeService,
    } as unknown as ExchangePool);

    injectOrder(om, order);

    await om.reconcileWithExchange(new Map([["BTC", null]]));

    expect(cancelByOid).toHaveBeenCalledWith("BTC", 99999);
    expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
  });

  it("no-ops when getOpenOrders returns null (API error)", async () => {
    const cancelByOid = mock(() => Promise.resolve(makeOrderResult(true)));
    const getOpenOrders = mock(() => Promise.resolve(null));

    om.setExchangePool({
      isInitialized: () => true,
      get: () =>
        ({
          exchangeId: "HL",
          getOpenOrders,
          cancelByOid,
        }) as unknown as IExchangeService,
    } as unknown as ExchangePool);

    mockSqlResponses.push([]);

    await om.reconcileWithExchange(new Map());

    expect(getOpenOrders).toHaveBeenCalledTimes(1);
    expect(cancelByOid).not.toHaveBeenCalled();
  });
});
