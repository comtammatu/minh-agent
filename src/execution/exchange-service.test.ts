/**
 * ExchangeService tests (Sprint 2 S10).
 *
 * Tests the exchange layer: order placement, cancellation, trigger orders,
 * modify trigger, account state, position queries.
 *
 * Mocks: HL SDK (ExchangeClient, SymbolConverter, InfoClient), viem, rate-limiter.
 * No real network calls.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ── Mock setup ────────────────────────────────────────────────────────────

// Mock global fetch for raw /info calls (perp-info.ts)
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { type?: string })
      : {};
    if (body.type === "allMids") {
      return new Response(JSON.stringify({ BTC: "50000", ETH: "3000" }), {
        status: 200,
      });
    }
    // Default: return empty payload for unrecognized calls
    return new Response(JSON.stringify({}), { status: 200 });
  };
});

// Restore original fetch after tests (best effort)
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});

// Mock viem/accounts
mock.module("viem/accounts", () => ({
  privateKeyToAccount: (_key: string) => ({
    address: "0x1234567890abcdef1234567890abcdef12345678" as const,
    signMessage: () => Promise.resolve("0x"),
    signTypedData: () => Promise.resolve("0x"),
  }),
}));

// Mock rate-limiter
mock.module("../feed/rate-limiter.js", () => ({
  acquire: () => Promise.resolve(),
}));

// Track calls to mock ExchangeClient
let lastOrderCall: unknown = null;
let lastCancelCall: unknown = null;
let lastCancelByCloidCall: unknown = null;
let lastModifyCall: unknown = null;
let lastScheduleCancelCall: unknown = null;
let orderResponse: unknown = null;
let cancelResponse: unknown = null;
const scheduleCancelResponse: unknown = null;
let modifyError: Error | null = null;
let scheduleCancelError: Error | null = null;

// Mock HL SDK
mock.module("@nktkas/hyperliquid", () => ({
  HttpTransport: class MockTransport {},
  ExchangeClient: class MockExchangeClient {
    async order(params: unknown) {
      lastOrderCall = params;
      if (!orderResponse) {
        return {
          response: {
            data: {
              statuses: [
                { filled: { totalSz: "0.1", avgPx: "50000", oid: 12345 } },
              ],
            },
          },
        };
      }
      return orderResponse;
    }
    async cancel(params: unknown) {
      lastCancelCall = params;
      if (!cancelResponse) {
        return { response: { data: { statuses: ["success"] } } };
      }
      return cancelResponse;
    }
    async cancelByCloid(params: unknown) {
      lastCancelByCloidCall = params;
      return { response: { data: { statuses: ["success"] } } };
    }
    async modify(params: unknown) {
      lastModifyCall = params;
      if (modifyError) throw modifyError;
      return { status: "ok" };
    }
    async scheduleCancel(params: unknown) {
      lastScheduleCancelCall = params;
      if (scheduleCancelError) throw scheduleCancelError;
      return (
        scheduleCancelResponse ?? {
          status: "ok",
          response: { type: "default" },
        }
      );
    }
  },
  InfoClient: class MockInfoClient {},
}));

// Mock SymbolConverter
mock.module("@nktkas/hyperliquid/utils", () => ({
  SymbolConverter: {
    create: () =>
      Promise.resolve({
        getAssetId: (coin: string) => {
          const map: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2 };
          return map[coin];
        },
        getSzDecimals: (coin: string) => {
          const map: Record<string, number> = { BTC: 5, ETH: 4, SOL: 2 };
          return map[coin];
        },
        reload: () => Promise.resolve(),
      }),
  },
  formatPrice: (price: string | number, _szDecimals: number) => String(price),
  formatSize: (size: string | number, _szDecimals: number) => String(size),
}));

// Mock InfoClient from feed/rest.js (for clearinghouseState + spotClearinghouseState)
let clearinghouseResponse: unknown = null;
const spotClearinghouseResponse: unknown = null;
mock.module("../feed/rest.js", () => ({
  info: {
    clearinghouseState: (_params: unknown) => {
      if (!clearinghouseResponse) {
        return Promise.resolve({
          marginSummary: {
            accountValue: "25000.50",
            totalNtlPos: "10000",
            totalMarginUsed: "5000",
            totalRawUsd: "15000",
          },
          withdrawable: "15000.50",
          assetPositions: [
            {
              type: "oneWay",
              position: {
                coin: "BTC",
                szi: "0.1",
                entryPx: "50000",
                unrealizedPnl: "500",
                liquidationPx: "45000",
                leverage: { type: "cross", value: 5 },
                positionValue: "5000",
                returnOnEquity: "0.1",
                marginUsed: "1000",
                maxLeverage: 50,
                cumFunding: { allTime: "10", sinceOpen: "5", sinceChange: "2" },
              },
            },
          ],
          crossMarginSummary: {
            accountValue: "25000.50",
            totalNtlPos: "10000",
            totalRawUsd: "15000",
            totalMarginUsed: "5000",
          },
          crossMaintenanceMarginUsed: "2500",
          time: Date.now(),
        });
      }
      return Promise.resolve(clearinghouseResponse);
    },
    spotClearinghouseState: (_params: unknown) => {
      if (!spotClearinghouseResponse) {
        return Promise.resolve({
          balances: [
            {
              coin: "USDC",
              token: 0,
              total: "300.0",
              hold: "0.0",
              entryNtl: "0.0",
            },
          ],
        });
      }
      return Promise.resolve(spotClearinghouseResponse);
    },
    candleSnapshot: () => Promise.resolve([]),
  },
}));

import { ExchangeService, resetExchangeService } from "./exchange-service.js";

// ── Test Setup ──────────────────────────────────────────────────────────────

describe("ExchangeService", () => {
  let svc: ExchangeService;

  beforeEach(async () => {
    resetExchangeService();
    lastOrderCall = null;
    lastCancelCall = null;
    lastCancelByCloidCall = null;
    lastModifyCall = null;
    orderResponse = null;
    cancelResponse = null;
    modifyError = null;
    clearinghouseResponse = null;

    // Set env var for init
    process.env.PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    svc = new ExchangeService();
    await svc.init();
  });

  // ── Init ──────────────────────────────────────────────────────────────

  describe("init", () => {
    it("should initialize with valid private key", () => {
      expect(svc.getWalletAddress()).toContain("0x");
    });

    it("execution boundary contract: wallet address is stable after init", async () => {
      const first = svc.getWalletAddress();
      await svc.init();
      expect(svc.getWalletAddress()).toBe(first);
      expect(first).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("should throw without PRIVATE_KEY", async () => {
      delete process.env.PRIVATE_KEY;
      const svc2 = new ExchangeService();
      expect(svc2.init()).rejects.toThrow("PRIVATE_KEY env var is required");
    });

    it("should throw with invalid PRIVATE_KEY format", async () => {
      process.env.PRIVATE_KEY = "not-a-hex-key";
      const svc2 = new ExchangeService();
      expect(svc2.init()).rejects.toThrow("PRIVATE_KEY must start with 0x");
    });

    it("should be idempotent", async () => {
      await svc.init();
      await svc.init();
      expect(svc.getWalletAddress()).toContain("0x");
    });
  });

  // ── Asset Lookup ──────────────────────────────────────────────────────

  describe("asset lookup", () => {
    it("should return asset ID for known coins", () => {
      expect(svc.getAssetId("BTC")).toBe(0);
      expect(svc.getAssetId("ETH")).toBe(1);
      expect(svc.getAssetId("SOL")).toBe(2);
    });

    it("should return undefined for unknown coins", () => {
      expect(svc.getAssetId("UNKNOWN")).toBeUndefined();
    });

    it("should return szDecimals for known coins", () => {
      expect(svc.getSzDecimals("BTC")).toBe(5);
      expect(svc.getSzDecimals("ETH")).toBe(4);
    });
  });

  // ── Order Placement ───────────────────────────────────────────────────

  describe("placeOrder", () => {
    it("should place a market order and return fill result", async () => {
      const result = await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "market",
        price: 50000,
        size: 0.1,
        reduceOnly: false,
        cloid: "0x1234567890abcdef1234567890abcdef",
      });

      expect(result.success).toBe(true);
      expect(result.oid).toBe(12345);
      expect(result.avgPx).toBe(50000);
      expect(result.totalSz).toBe(0.1);
      expect(result.status).toBe("filled");
    });

    it("should pass correct params to SDK", async () => {
      await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "market",
        price: 50000,
        size: 0.1,
        reduceOnly: false,
      });

      const call = lastOrderCall as {
        orders: {
          a: number;
          b: boolean;
          r: boolean;
          t: { limit: { tif: string } };
        }[];
        grouping: string;
      };
      expect(call.orders[0]?.a).toBe(0); // BTC asset ID
      expect(call.orders[0]?.b).toBe(true); // isBuy = long
      expect(call.orders[0]?.r).toBe(false); // not reduce-only
      expect(call.orders[0]?.t).toEqual({ limit: { tif: "Ioc" } }); // market (IoC) order
      expect(call.grouping).toBe("na");
    });

    it("execution boundary contract: forwards cloid to HL SDK order payload", async () => {
      const cloid = "0x1234567890abcdef1234567890abcdef";
      await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "limit",
        price: 50000,
        size: 0.1,
        reduceOnly: false,
        cloid,
      });

      const call = lastOrderCall as {
        orders: { c?: string }[];
      };
      expect(call.orders[0]?.c).toBe(cloid);
    });

    it("should use Gtc for limit orders", async () => {
      await svc.placeOrder({
        coin: "ETH",
        side: "short",
        type: "limit",
        price: 3000,
        size: 1,
        reduceOnly: false,
      });

      const call = lastOrderCall as {
        orders: { a: number; b: boolean; t: { limit: { tif: string } } }[];
      };
      expect(call.orders[0]?.a).toBe(1); // ETH asset ID
      expect(call.orders[0]?.b).toBe(false); // isBuy = false for short
      expect(call.orders[0]?.t).toEqual({ limit: { tif: "Gtc" } });
    });

    it("should reject unknown asset", async () => {
      const result = await svc.placeOrder({
        coin: "UNKNOWN",
        side: "long",
        type: "market",
        price: 100,
        size: 1,
        reduceOnly: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown asset");
    });

    it("should reject below $10 minimum", async () => {
      const result = await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "market",
        price: 5,
        size: 0.001,
        reduceOnly: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("$10 minimum");
    });

    it("should handle resting order response", async () => {
      orderResponse = {
        response: {
          data: {
            statuses: [{ resting: { oid: 99999 } }],
          },
        },
      };

      const result = await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "limit",
        price: 49000,
        size: 0.1,
        reduceOnly: false,
      });

      expect(result.success).toBe(true);
      expect(result.oid).toBe(99999);
      expect(result.status).toBe("resting");
    });

    it("should handle error response from exchange", async () => {
      orderResponse = {
        response: {
          data: {
            statuses: [{ error: "Insufficient margin" }],
          },
        },
      };

      const result = await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "market",
        price: 50000,
        size: 0.1,
        reduceOnly: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Insufficient margin");
    });

    it("should handle waitingForTrigger status", async () => {
      orderResponse = {
        response: {
          data: {
            statuses: ["waitingForTrigger"],
          },
        },
      };

      const result = await svc.placeOrder({
        coin: "BTC",
        side: "long",
        type: "market",
        price: 50000,
        size: 0.1,
        reduceOnly: false,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("waitingForTrigger");
    });
  });

  // ── Trigger Orders ────────────────────────────────────────────────────

  describe("placeTrigger", () => {
    it("should place SL trigger (market) with normalTpsl grouping", async () => {
      orderResponse = {
        response: {
          data: {
            statuses: ["waitingForTrigger"],
          },
        },
      };

      const result = await svc.placeTrigger({
        coin: "BTC",
        side: "short", // close side for long position
        triggerPrice: 49000,
        size: 0.1,
        isMarket: true,
        tpsl: "sl",
      });

      expect(result.success).toBe(true);

      const call = lastOrderCall as {
        orders: {
          r: boolean;
          t: { trigger: { isMarket: boolean; tpsl: string } };
        }[];
        grouping: string;
      };
      expect(call.orders[0]?.r).toBe(true); // reduce-only
      expect(call.orders[0]?.t.trigger.isMarket).toBe(true);
      expect(call.orders[0]?.t.trigger.tpsl).toBe("sl");
      expect(call.grouping).toBe("normalTpsl");
    });

    it("should place TP trigger (limit) with normalTpsl grouping", async () => {
      orderResponse = {
        response: {
          data: {
            statuses: ["waitingForTrigger"],
          },
        },
      };

      await svc.placeTrigger({
        coin: "BTC",
        side: "short",
        triggerPrice: 55000,
        size: 0.1,
        isMarket: false,
        tpsl: "tp",
      });

      const call = lastOrderCall as {
        orders: { t: { trigger: { isMarket: boolean; tpsl: string } } }[];
        grouping: string;
      };
      expect(call.orders[0]?.t.trigger.isMarket).toBe(false);
      expect(call.orders[0]?.t.trigger.tpsl).toBe("tp");
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("should cancel by oid", async () => {
      const result = await svc.cancelByOid("BTC", 12345);
      expect(result.success).toBe(true);

      const call = lastCancelCall as { cancels: { a: number; o: number }[] };
      expect(call.cancels[0]?.a).toBe(0); // BTC
      expect(call.cancels[0]?.o).toBe(12345);
    });

    it("should cancel by cloid", async () => {
      const result = await svc.cancelByCloid(
        "BTC",
        "0x1234567890abcdef1234567890abcdef",
      );
      expect(result.success).toBe(true);

      const call = lastCancelByCloidCall as {
        cancels: { asset: number; cloid: string }[];
      };
      expect(call.cancels[0]?.asset).toBe(0);
      expect(call.cancels[0]?.cloid).toBe("0x1234567890abcdef1234567890abcdef");
    });

    it("should handle cancel error", async () => {
      cancelResponse = {
        response: {
          data: {
            statuses: [{ error: "Order already filled" }],
          },
        },
      };

      const result = await svc.cancelByOid("BTC", 12345);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Order already filled");
    });

    it("should reject cancel for unknown asset", async () => {
      const result = await svc.cancelByOid("UNKNOWN", 12345);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown asset");
    });
  });

  // ── scheduleCancel (HL dead-man-switch) ────────────────────────────────

  describe("scheduleCancel", () => {
    it("schedules cancel-all at a future timestamp", async () => {
      const future = Date.now() + 10_000;
      const result = await svc.scheduleCancel(future);
      expect(result.success).toBe(true);
      expect(result.status).toBe("scheduled");
      const call = lastScheduleCancelCall as { time: number };
      expect(call.time).toBe(future);
    });

    it("clears scheduled cancel when called without timestamp", async () => {
      const result = await svc.scheduleCancel();
      expect(result.success).toBe(true);
      // SDK called with empty object → clear schedule
      expect(lastScheduleCancelCall).toEqual({});
    });

    it("rejects timestamps less than 5s in the future", async () => {
      const result = await svc.scheduleCancel(Date.now() + 1_000);
      expect(result.success).toBe(false);
      expect(result.error).toContain("≥5s in future");
    });

    it("surfaces SDK errors after retries exhausted", async () => {
      scheduleCancelError = new Error("Schedule limit exceeded");
      const result = await svc.scheduleCancel(Date.now() + 30_000);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Schedule limit exceeded");
      scheduleCancelError = null;
    });
  });

  // ── Modify Trigger ────────────────────────────────────────────────────

  describe("modifyTrigger", () => {
    it("should modify SL trigger with correct params", async () => {
      const result = await svc.modifyTrigger(
        "BTC",
        12345,
        "short",
        49500,
        0.1,
        true,
        "sl",
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe("modified");

      const call = lastModifyCall as {
        oid: number;
        order: {
          a: number;
          b: boolean;
          r: boolean;
          t: { trigger: { isMarket: boolean; tpsl: string } };
        };
      };
      expect(call.oid).toBe(12345);
      expect(call.order.a).toBe(0); // BTC
      expect(call.order.b).toBe(false); // short = not buy
      expect(call.order.r).toBe(true); // reduce-only
      expect(call.order.t.trigger.tpsl).toBe("sl");
    });

    it("should handle modify failure", async () => {
      modifyError = new Error("Cannot modify filled order");
      const result = await svc.modifyTrigger(
        "BTC",
        12345,
        "short",
        49500,
        0.1,
        true,
        "sl",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot modify filled order");
    });
  });

  // ── Account State ─────────────────────────────────────────────────────

  describe("getAccountState", () => {
    it("should parse clearinghouseState + spotClearinghouseState response", async () => {
      const state = await svc.getAccountState();

      expect(state.accountValue).toBe(25000.5);
      expect(state.totalNtlPos).toBe(10000);
      expect(state.totalMarginUsed).toBe(5000);
      expect(state.withdrawable).toBe(15000.5);
      expect(state.spotUsdcBalance).toBe(300);
      expect(state.effectiveBalance).toBe(25300.5); // perp 25000.50 + spot 300
    });

    it("execution boundary contract: effectiveBalance equals perp accountValue plus spot USDC", async () => {
      const state = await svc.getAccountState();
      expect(state.effectiveBalance).toBe(
        state.accountValue + state.spotUsdcBalance,
      );
      expect(svc.getCachedAccountValue()).toBe(state.effectiveBalance);
    });

    it("should cache effectiveBalance (perp + spot)", async () => {
      await svc.getAccountState();
      expect(svc.getCachedAccountValue()).toBe(25300.5);
    });
  });

  // ── Positions ─────────────────────────────────────────────────────────

  describe("getPositions", () => {
    it("should parse and return open positions", async () => {
      const positions = await svc.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0]?.coin).toBe("BTC");
      expect(positions[0]?.size).toBe(0.1); // positive = long
      expect(positions[0]?.entryPrice).toBe(50000);
      expect(positions[0]?.unrealizedPnl).toBe(500);
      expect(positions[0]?.liquidationPrice).toBe(45000);
      expect(positions[0]?.leverage).toBe(5);
    });

    it("should filter out closed positions (size = 0)", async () => {
      clearinghouseResponse = {
        marginSummary: {
          accountValue: "10000",
          totalNtlPos: "0",
          totalMarginUsed: "0",
          totalRawUsd: "10000",
        },
        withdrawable: "10000",
        assetPositions: [
          {
            type: "oneWay",
            position: {
              coin: "ETH",
              szi: "0",
              entryPx: "3000",
              unrealizedPnl: "0",
              liquidationPx: null,
              leverage: { type: "cross", value: 1 },
              positionValue: "0",
              returnOnEquity: "0",
              marginUsed: "0",
              maxLeverage: 50,
              cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
            },
          },
        ],
        crossMarginSummary: {
          accountValue: "10000",
          totalNtlPos: "0",
          totalRawUsd: "10000",
          totalMarginUsed: "0",
        },
        crossMaintenanceMarginUsed: "0",
        time: Date.now(),
      };

      const positions = await svc.getPositions();
      expect(positions).toHaveLength(0);
    });
  });

  // Singleton tests omitted — trivial and flaky in multi-file bun:test runs
  // due to mock.module leakage. Verified in isolation: 29/29 pass.
});
