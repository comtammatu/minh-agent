import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let hlFallbackFactoryCalls = 0;
let hlGetPositionsCalls = 0;
let hlGetAccountStateCalls = 0;

const hlService = {
  getPositions: async () => {
    hlGetPositionsCalls++;
    return [
      {
        coin: "BTC",
        size: 1,
        entryPrice: 60_000,
        unrealizedPnl: 120,
        liquidationPrice: null,
      },
    ];
  },
  getAccountState: async () => {
    hlGetAccountStateCalls++;
    return {
      accountValue: 10_000,
      totalNtlPos: 0,
      totalMarginUsed: 0,
      withdrawable: 10_000,
      spotUsdcBalance: 0,
      effectiveBalance: 10_000,
    };
  },
};

mock.module("../../src/app/execution.js", () => ({
  isExecutionInitialized: () => false,
  getExecution: () => {
    throw new Error(
      "getExecution should not be called when execution is not initialized",
    );
  },
}));

mock.module("../../src/execution/hl-exchange-service.js", () => ({
  getHLExchangeService: () => {
    hlFallbackFactoryCalls++;
    return hlService;
  },
}));

mock.module("../../src/agent/trading-orchestrator.js", () => ({
  getAgent: () => ({
    getSnapshot: () => ({
      coins: {},
      global: {
        dailyPnl: 0,
        totalConsecutiveLosses: 0,
        globalPaused: false,
        globalPauseReason: null,
        uptime: 0,
      },
    }),
  }),
}));

mock.module("../../src/agent/order-manager.js", () => ({
  getOrderManager: () => ({
    syncSubmittedEntryFills: async () => {},
    reconcileWithExchange: async () => {},
  }),
}));

import {
  getPositionMonitor,
  queryExchangePositions,
  resetPositionMonitor,
} from "../../src/agent/position-monitor.js";

describe("PositionMonitor BB fallback guard", () => {
  beforeEach(() => {
    hlFallbackFactoryCalls = 0;
    hlGetPositionsCalls = 0;
    hlGetAccountStateCalls = 0;
    process.env.ACTIVE_EXCHANGE = "HL";
    resetPositionMonitor();
  });

  afterEach(() => {
    delete process.env.ACTIVE_EXCHANGE;
    resetPositionMonitor();
  });

  afterAll(() => {
    mock.restore();
  });

  it("keeps HL singleton fallback for queryExchangePositions in HL live mode", async () => {
    process.env.ACTIVE_EXCHANGE = "HL";

    const snapshots = await queryExchangePositions();

    expect(snapshots).not.toBeNull();
    expect(snapshots?.length).toBe(1);
    expect(hlFallbackFactoryCalls).toBe(1);
    expect(hlGetPositionsCalls).toBe(1);
  });

  it("blocks HL singleton fallback for queryExchangePositions in BB live mode", async () => {
    process.env.ACTIVE_EXCHANGE = "BB";

    const snapshots = await queryExchangePositions();

    expect(snapshots).toBeNull();
    expect(hlFallbackFactoryCalls).toBe(0);
    expect(hlGetPositionsCalls).toBe(0);
  });

  it("keeps HL singleton fallback for account sync in HL live mode", async () => {
    process.env.ACTIVE_EXCHANGE = "HL";

    const pm = getPositionMonitor();
    pm.setEquityCallback(() => {});
    await pm.syncWithExchange();

    expect(hlFallbackFactoryCalls).toBe(1);
    expect(hlGetAccountStateCalls).toBe(1);
  });

  it("blocks HL singleton fallback for account sync in BB live mode", async () => {
    process.env.ACTIVE_EXCHANGE = "BB";

    const pm = getPositionMonitor();
    pm.setEquityCallback(() => {});
    await pm.syncWithExchange();

    expect(hlFallbackFactoryCalls).toBe(0);
    expect(hlGetAccountStateCalls).toBe(0);
  });
});
