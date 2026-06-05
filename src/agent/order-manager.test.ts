/**
 * OrderManager tests (Sprint 2 S6, updated S10).
 *
 * Tests the order lifecycle: place, fill, reject, cancel, timeout, SL/TP triggers.
 * Mocks DB via bun:test mock.module — pure logic verification.
 * S10: Also mocks ExchangeService (replaces old stubs).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the DB connection BEFORE importing OrderManager
let mockSqlResponses: Record<string, unknown>[][] = [];

mock.module("../db/connection.js", () => {
  const sqlTag = () => {
    const next = mockSqlResponses.shift();
    return Promise.resolve(next ?? []);
  };
  return {
    sql: Object.assign(sqlTag, { end: () => Promise.resolve() }),
  };
});

// S10: Mock ExchangeService so OrderManager's exchange wrappers return success
let mockOrderSuccess = true;
let mockCancelSuccess = true;
let mockTriggerSuccess = true;

mock.module("../execution/hl-exchange-service.js", () => ({
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
    modifyTrigger: () =>
      Promise.resolve({
        success: true,
        oid: 67890,
        avgPx: null,
        totalSz: null,
        status: "modified",
        error: null,
      }),
    getFillAggregateByCloid: () => Promise.resolve(null),
  }),
}));

import type {
  ExchangePool,
  IExchangeService,
} from "../execution/exchange-pool.js";
import {
  generateCloid,
  OrderManager,
  resetOrderManager,
} from "./order-manager.js";
import type { AgentEvent, Order, TriggerOrder } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Access the private orders map. */
function getOrdersMap(om: OrderManager): Map<string, Order> {
  return (om as unknown as { orders: Map<string, Order> }).orders;
}

/** Inject an order into the cache (bypasses DB). */
function injectOrder(om: OrderManager, order: Order): void {
  getOrdersMap(om).set(order.id, order);
}

/** Access the private triggerOrders map. */
function getTriggerOrdersMap(om: OrderManager): Map<string, TriggerOrder[]> {
  return (om as unknown as { triggerOrders: Map<string, TriggerOrder[]> })
    .triggerOrders;
}

/** Inject trigger orders for a parent order (test-only helper). */
function injectTriggers(
  om: OrderManager,
  parentOrderId: string,
  triggers: TriggerOrder[],
): void {
  getTriggerOrdersMap(om).set(parentOrderId, triggers);
}

function queueSqlResult(rows: Record<string, unknown>[]): void {
  mockSqlResponses.push(rows);
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
    exchangeOrderId: `sim-${Date.now()}`,
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

// ── generateCloid ──────────────────────────────────────────────────────────

describe("generateCloid", () => {
  it("returns a 0x-prefixed 32-char hex string", () => {
    const cloid = generateCloid();
    expect(cloid).toStartWith("0x");
    expect(cloid).toHaveLength(34); // 0x + 32 hex chars
    expect(/^0x[0-9a-f]{32}$/.test(cloid)).toBe(true);
  });

  it("generates unique values", () => {
    const a = generateCloid();
    const b = generateCloid();
    expect(a).not.toBe(b);
  });
});

// ── OrderManager (unit, mocked DB) ─────────────────────────────────────────

describe("OrderManager", () => {
  let om: OrderManager;
  let dispatchedEvents: Array<{ coin: string; event: AgentEvent }>;
  const originalActiveExchange = process.env.ACTIVE_EXCHANGE;

  beforeEach(() => {
    process.env.ACTIVE_EXCHANGE = "HL";
    resetOrderManager();
    mockOrderSuccess = true;
    mockCancelSuccess = true;
    mockTriggerSuccess = true;
    mockSqlResponses = [];
    om = new OrderManager();
    dispatchedEvents = [];
    om.setAgentDispatch((coin, event) => {
      dispatchedEvents.push({ coin, event });
    });
  });

  afterEach(() => {
    if (originalActiveExchange === undefined) {
      delete process.env.ACTIVE_EXCHANGE;
    } else {
      process.env.ACTIVE_EXCHANGE = originalActiveExchange;
    }
  });

  it("getOrder returns null for malformed order ids without hitting DB", async () => {
    expect(await om.getOrder("abc-123")).toBeNull();
    expect(await om.getOrder("not-a-uuid")).toBeNull();
  });

  describe("DB row mapping + recovery lookup", () => {
    it("loadActiveOrders maps cloid from DB cloid column (not exchange_order_id)", async () => {
      process.env.ACTIVE_EXCHANGE = "BB";
      const rowId = crypto.randomUUID();
      queueSqlResult([
        {
          id: rowId,
          coin: "BTC",
          side: "long",
          type: "limit",
          price: 50000,
          size: 0.1,
          status: "filled",
          setup_id: "setup-1",
          sl_price: 49000,
          tp_price: 52000,
          cloid: "bb-link-123",
          exchange_order_id: "be411c88-aaaa-bbbb-cccc-111122223333",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          filled_at: new Date().toISOString(),
          fill_price: 50010,
          fill_size: 0.1,
          position_id: "pos-1",
          exchange: "BB",
        },
      ]);

      await om.loadActiveOrders();

      const loaded = getOrdersMap(om).get(rowId);
      expect(loaded).not.toBeUndefined();
      expect(loaded?.cloid).toBe("bb-link-123");
      expect(loaded?.exchangeOrderId).toBe(
        "be411c88-aaaa-bbbb-cccc-111122223333",
      );
    });

    it("loadActiveOrders does not infer Bybit cloid from exchange_order_id when cloid is empty", async () => {
      process.env.ACTIVE_EXCHANGE = "BB";
      const rowId = crypto.randomUUID();
      queueSqlResult([
        {
          id: rowId,
          coin: "ETH",
          side: "short",
          type: "limit",
          price: 3000,
          size: 1,
          status: "submitted",
          setup_id: "setup-2",
          sl_price: 3100,
          tp_price: 2800,
          cloid: "",
          exchange_order_id: "be411c88-aaaa-bbbb-cccc-111122223333",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          filled_at: null,
          fill_price: null,
          fill_size: 0,
          position_id: null,
          exchange: "BB",
        },
      ]);

      await om.loadActiveOrders();

      const loaded = getOrdersMap(om).get(rowId);
      expect(loaded).not.toBeUndefined();
      expect(loaded?.cloid).toBe("");
      expect(loaded?.exchangeOrderId).toBe(
        "be411c88-aaaa-bbbb-cccc-111122223333",
      );
    });

    it("syncSubmittedEntryFills prefers cloid lookup when cloid exists", async () => {
      const order = makeOrder({
        exchange: "BB",
        status: "submitted",
        size: 1,
        fillSize: 0,
        cloid: "bb-link-live",
        exchangeOrderId: "bb-order-1",
      });
      injectOrder(om, order);

      const getFillAggregateByCloid = mock(() =>
        Promise.resolve({ avgPx: 50000, totalSz: 0.4, isFilled: false }),
      );
      const getFillAggregateByOrderId = mock(() => Promise.resolve(null));
      const bbSvc = {
        exchangeId: "BB",
        getFillAggregateByCloid,
        getFillAggregateByOrderId,
      } as unknown as IExchangeService;
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool;
      om.setExchangePool(fakePool);

      await om.syncSubmittedEntryFills();

      expect(getFillAggregateByCloid).toHaveBeenCalledTimes(1);
      expect(getFillAggregateByCloid).toHaveBeenCalledWith(
        "bb-link-live",
        "BTC",
      );
      expect(getFillAggregateByOrderId).toHaveBeenCalledTimes(0);
      expect(getOrdersMap(om).get(order.id)?.status).toBe("partial");
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.4);
    });

    it("syncSubmittedEntryFills falls back to orderId lookup when cloid lookup misses", async () => {
      const order = makeOrder({
        exchange: "BB",
        status: "submitted",
        size: 1,
        fillSize: 0,
        cloid: "bb-link-stale",
        exchangeOrderId: "bb-order-fallback",
      });
      injectOrder(om, order);

      const getFillAggregateByCloid = mock(() => Promise.resolve(null));
      const getFillAggregateByOrderId = mock(() =>
        Promise.resolve({ avgPx: 49990, totalSz: 0.25, isFilled: false }),
      );
      const bbSvc = {
        exchangeId: "BB",
        getFillAggregateByCloid,
        getFillAggregateByOrderId,
      } as unknown as IExchangeService;
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool;
      om.setExchangePool(fakePool);

      await om.syncSubmittedEntryFills();

      expect(getFillAggregateByCloid).toHaveBeenCalledTimes(1);
      expect(getFillAggregateByOrderId).toHaveBeenCalledTimes(1);
      expect(getFillAggregateByOrderId).toHaveBeenCalledWith(
        "bb-order-fallback",
        "BTC",
      );
      expect(getOrdersMap(om).get(order.id)?.status).toBe("partial");
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.25);
    });
  });

  // ── Cancel ───────────────────────────────────────────────────────────

  describe("cancelOrder", () => {
    it("cancels a submitted order", async () => {
      const order = makeOrder({ status: "submitted" });
      injectOrder(om, order);

      await om.cancelOrder(order.id, "invalidation");

      expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
    });

    it("cancels a pending order", async () => {
      const order = makeOrder({ status: "pending", exchangeOrderId: null });
      injectOrder(om, order);

      await om.cancelOrder(order.id, "timeout");

      expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
    });

    it("is idempotent on filled order", async () => {
      const order = makeOrder({
        status: "filled",
        fillPrice: 50000,
        filledAt: Date.now(),
      });
      injectOrder(om, order);

      await om.cancelOrder(order.id, "test");

      expect(getOrdersMap(om).get(order.id)?.status).toBe("filled");
    });

    it("is idempotent on already-cancelled order", async () => {
      const order = makeOrder({ status: "cancelled" });
      injectOrder(om, order);

      await om.cancelOrder(order.id, "double-cancel");

      expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
    });

    it("is no-op for unknown order", async () => {
      // Should not throw
      await om.cancelOrder("nonexistent-id", "test");
    });

    it("preserves status when exchange cancel + cloid retry both fail", async () => {
      // Regression test for cancel-failure-hidden bug (autoplan eng review 2026-05-19):
      // Previously, a failed exchange cancel still mutated DB status to 'cancelled',
      // creating a phantom state where reconciliation believed the order was gone
      // while the exchange still held it live. The order must stay 'submitted' so
      // checkTimeouts() retries on the next sweep.
      mockCancelSuccess = false;
      const order = makeOrder({
        status: "submitted",
        exchangeOrderId: "oid-12345",
        cloid: "0xabc",
      });
      injectOrder(om, order);

      await om.cancelOrder(order.id, "invalidation");

      // Status MUST remain 'submitted' — exchange still holds the order.
      expect(getOrdersMap(om).get(order.id)?.status).toBe("submitted");
      // Order is still eligible for retry on next timeout sweep.
      expect(getOrdersMap(om).get(order.id)?.exchangeOrderId).toBe("oid-12345");

      mockCancelSuccess = true; // reset for subsequent tests
    });
  });

  // ── Fill ─────────────────────────────────────────────────────────────

  describe("onOrderFilled", () => {
    it("transitions to filled and places SL/TP triggers", async () => {
      const order = makeOrder({
        coin: "BTC",
        side: "long",
        slPrice: 49000,
        tpPrice: 52000,
      });
      injectOrder(om, order);

      await om.onOrderFilled(order.id, 50050, 0.1);

      // Order should be filled
      const cached = getOrdersMap(om).get(order.id)!;
      expect(cached.status).toBe("filled");
      expect(cached.fillPrice).toBe(50050);
      expect(cached.fillSize).toBe(0.1);

      // SL/TP triggers should exist
      const triggers = om.getTriggerOrders(order.id);
      expect(triggers).toHaveLength(2);

      const sl = triggers.find((t) => t.type === "sl")!;
      expect(sl.triggerPrice).toBe(49000);
      expect(sl.isMarket).toBe(true); // R9: SL = trigger-market
      expect(sl.side).toBe("short"); // close side = opposite of entry

      const tp = triggers.find((t) => t.type === "tp")!;
      expect(tp.triggerPrice).toBe(52000);
      expect(tp.isMarket).toBe(true); // TP = trigger-market
      expect(tp.side).toBe("short");

      // Agent receives order_filled event
      expect(dispatchedEvents).toHaveLength(1);
      expect(dispatchedEvents[0]?.coin).toBe("BTC");
      expect(dispatchedEvents[0]?.event.type).toBe("order_filled");
    });

    it("places triggers with short close side for short entry", async () => {
      const order = makeOrder({
        coin: "ETH",
        side: "short",
        slPrice: 3100,
        tpPrice: 2800,
      });
      injectOrder(om, order);

      await om.onOrderFilled(order.id, 3000, 1);

      const triggers = om.getTriggerOrders(order.id);
      expect(triggers[0]?.side).toBe("long"); // close side for short = long
      expect(triggers[1]?.side).toBe("long");
    });

    it("skips SL/TP if prices are null", async () => {
      const order = makeOrder({ slPrice: null, tpPrice: null });
      injectOrder(om, order);

      await om.onOrderFilled(order.id, 50000, 0.1);

      expect(om.getTriggerOrders(order.id)).toHaveLength(0);
      expect(dispatchedEvents).toHaveLength(1); // still dispatches fill
    });

    it("is no-op for unknown order", async () => {
      await om.onOrderFilled("unknown-id", 50000, 0.1);
      expect(dispatchedEvents).toHaveLength(0);
    });
  });

  // ── Partial Fill ─────────────────────────────────────────────────────

  describe("onPartialFill", () => {
    it("marks as partial when size < requested", async () => {
      const order = makeOrder({ size: 1.0 });
      injectOrder(om, order);

      await om.onPartialFill(order.id, 0.5);

      expect(getOrdersMap(om).get(order.id)?.status).toBe("partial");
      expect(getOrdersMap(om).get(order.id)?.fillSize).toBe(0.5);
      expect(dispatchedEvents).toHaveLength(0); // no agent dispatch yet
    });

    it("auto-promotes to filled when partial >= size", async () => {
      const order = makeOrder({
        coin: "SOL",
        side: "short",
        size: 10,
        slPrice: 105,
        tpPrice: 90,
      });
      injectOrder(om, order);

      await om.onPartialFill(order.id, 10);

      expect(getOrdersMap(om).get(order.id)?.status).toBe("filled");
      expect(om.getTriggerOrders(order.id)).toHaveLength(2);
      expect(dispatchedEvents).toHaveLength(1);
      expect(dispatchedEvents[0]?.event.type).toBe("order_filled");
    });
  });

  // ── Timeout ──────────────────────────────────────────────────────────

  describe("checkTimeouts", () => {
    it("cancels orders older than ORDER_FILL_TIMEOUT_MS", async () => {
      const oldTime = Date.now() - 6 * 60 * 1000; // 6 min ago (> 5 min timeout)
      const order = makeOrder({
        coin: "HYPE",
        createdAt: oldTime,
        updatedAt: oldTime,
      });
      injectOrder(om, order);

      await om.checkTimeouts();

      expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
      expect(dispatchedEvents).toHaveLength(1);
      expect(dispatchedEvents[0]?.event.type).toBe("order_timeout");
      expect(dispatchedEvents[0]?.coin).toBe("HYPE");
    });

    it("does not cancel recent orders", async () => {
      const order = makeOrder({ coin: "TAO" });
      injectOrder(om, order);

      await om.checkTimeouts();

      expect(getOrdersMap(om).get(order.id)?.status).toBe("submitted");
      expect(dispatchedEvents).toHaveLength(0);
    });

    it("skips already-cancelled and filled orders", async () => {
      const cancelled = makeOrder({
        coin: "A",
        status: "cancelled",
        createdAt: 0,
      });
      const filled = makeOrder({ coin: "B", status: "filled", createdAt: 0 });
      injectOrder(om, cancelled);
      injectOrder(om, filled);

      await om.checkTimeouts();

      expect(getOrdersMap(om).get(cancelled.id)?.status).toBe("cancelled");
      expect(getOrdersMap(om).get(filled.id)?.status).toBe("filled");
      expect(dispatchedEvents).toHaveLength(0);
    });
  });

  // ── Modify SL ────────────────────────────────────────────────────────

  describe("modifySLPrice", () => {
    it("updates SL trigger price in memory", async () => {
      const order = makeOrder();
      injectOrder(om, order);
      await om.onOrderFilled(order.id, 50000, 0.1);

      const triggers = om.getTriggerOrders(order.id);
      expect(triggers.find((t) => t.type === "sl")?.triggerPrice).toBe(49000);

      await om.modifySLPrice(order.id, 49500);

      const updated = om.getTriggerOrders(order.id);
      expect(updated.find((t) => t.type === "sl")?.triggerPrice).toBe(49500);
    });

    it("is no-op for unknown parent order", async () => {
      // Should not throw
      await om.modifySLPrice("nonexistent", 50000);
    });

    it("uses Bybit position-level stop update without requiring triggerOrders", async () => {
      const order = makeOrder({
        status: "filled",
        exchange: "BB",
        slPrice: 49000,
      });
      injectOrder(om, order);

      const modifyTrigger = mock(() =>
        Promise.resolve({
          success: true,
          oid: 67890,
          avgPx: null,
          totalSz: null,
          status: "modified",
          error: null,
        }),
      );
      const updatePositionStop = mock(() =>
        Promise.resolve({
          success: true,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: "submitted",
          error: null,
        }),
      );
      const bbSvc = {
        exchangeId: "BB",
        modifyTrigger,
        updatePositionStop,
      } as unknown as IExchangeService;
      const fakePool = {
        isInitialized: () => true,
        get: () => bbSvc,
      } as unknown as ExchangePool;
      om.setExchangePool(fakePool);

      await om.modifySLPrice(order.id, 49500);

      expect(updatePositionStop).toHaveBeenCalledTimes(1);
      expect(modifyTrigger).toHaveBeenCalledTimes(0);
      const params = (
        updatePositionStop.mock.calls[0] as [
          {
            coin: string;
            positionSide: "long" | "short";
            triggerPrice: number;
            tpsl: "tp" | "sl";
          },
        ]
      )[0];
      expect(params.coin).toBe("BTC");
      expect(params.positionSide).toBe("long");
      expect(params.triggerPrice).toBe(49500);
      expect(params.tpsl).toBe("sl");
    });

    it("keeps HL path on modifyTrigger for trailing SL updates", async () => {
      const order = makeOrder({
        status: "filled",
        exchange: "HL",
      });
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
          success: true,
          oid: 67890,
          avgPx: null,
          totalSz: null,
          status: "modified",
          error: null,
        }),
      );
      const updatePositionStop = mock(() =>
        Promise.resolve({
          success: true,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: "submitted",
          error: null,
        }),
      );
      const hlSvc = {
        exchangeId: "HL",
        modifyTrigger,
        updatePositionStop,
      } as unknown as IExchangeService;
      const fakePool = {
        isInitialized: () => true,
        get: () => hlSvc,
      } as unknown as ExchangePool;
      om.setExchangePool(fakePool);

      await om.modifySLPrice(order.id, 49500);

      expect(modifyTrigger).toHaveBeenCalledTimes(1);
      expect(updatePositionStop).toHaveBeenCalledTimes(0);
      expect(
        om.getTriggerOrders(order.id).find((t) => t.type === "sl")
          ?.triggerPrice,
      ).toBe(49500);
    });
  });

  // ── handleAction ─────────────────────────────────────────────────────

  describe("handleAction", () => {
    it("routes cancel_order to cancelOrder", async () => {
      const order = makeOrder();
      injectOrder(om, order);

      await om.handleAction({
        type: "cancel_order",
        orderId: order.id,
        reason: "test",
      });

      expect(getOrdersMap(om).get(order.id)?.status).toBe("cancelled");
    });

    it("ignores non-order actions", async () => {
      // Should not throw for watch, none, log_journal
      await om.handleAction({ type: "none" });
      await om.handleAction({ type: "watch", setup: {} as never });
      await om.handleAction({
        type: "log_journal",
        eventType: "test",
        coin: "BTC",
        details: {},
      });
    });
  });

  // ── Query ────────────────────────────────────────────────────────────

  describe("getOrders / getTriggerOrders", () => {
    it("returns empty map when nothing cached", () => {
      expect(om.getOrders().size).toBe(0);
    });

    it("returns empty array for unknown trigger parent", () => {
      expect(om.getTriggerOrders("nonexistent")).toEqual([]);
    });

    it("returns cached orders", () => {
      const order = makeOrder();
      injectOrder(om, order);
      expect(om.getOrders().size).toBe(1);
    });
  });
});
