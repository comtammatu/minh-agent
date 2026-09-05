import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SIMULATED_ACCOUNT } from "../../src/config.js";

mock.module("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    signMessage: () => Promise.resolve("0x"),
    signTypedData: () => Promise.resolve("0x"),
  }),
}));

mock.module("../../src/feed/rate-limiter.js", () => ({
  acquire: () => Promise.resolve(),
}));

mock.module("@nktkas/hyperliquid", () => ({
  HttpTransport: class MockTransport {},
  ExchangeClient: class MockExchangeClient {},
}));

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
  formatPrice: (price: string | number) => String(price),
  formatSize: (size: string | number) => String(size),
}));

mock.module("../../src/feed/rest.js", () => ({
  info: {
    meta: () => Promise.resolve({ universe: [] }),
    clearinghouseState: () =>
      Promise.resolve({
        marginSummary: {
          accountValue: "10000",
          totalNtlPos: "0",
          totalMarginUsed: "0",
        },
        withdrawable: "10000",
        assetPositions: [],
      }),
    spotClearinghouseState: () => Promise.resolve({ balances: [] }),
  },
}));

import {
  getCachedAccountValue,
  initExecution,
  resetExecution,
} from "../../src/app/execution.js";
import { resetExchangeService } from "../../src/execution/exchange-service.js";

describe("app/execution", () => {
  const origActive = process.env.ACTIVE_EXCHANGE;
  const origPaper = process.env.PAPER_TRADE;
  const origPk = process.env.HL_PRIVATE_KEY;

  beforeEach(() => {
    mock.restore();
    resetExecution();
    resetExchangeService();
    process.env.ACTIVE_EXCHANGE = "HL";
    process.env.PAPER_TRADE = "true";
    process.env.HL_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  });

  afterEach(() => {
    resetExecution();
    resetExchangeService();
    if (origActive === undefined) delete process.env.ACTIVE_EXCHANGE;
    else process.env.ACTIVE_EXCHANGE = origActive;
    if (origPaper === undefined) delete process.env.PAPER_TRADE;
    else process.env.PAPER_TRADE = origPaper;
    if (origPk === undefined) delete process.env.HL_PRIVATE_KEY;
    else process.env.HL_PRIVATE_KEY = origPk;
  });

  it("initExecution returns a ready paper service", async () => {
    const svc = await initExecution();
    expect(svc.exchangeId).toBe("HL");
    expect(typeof svc.getPositions).toBe("function");
  });

  it("getCachedAccountValue falls back to simulated account in paper mode", () => {
    expect(getCachedAccountValue()).toBe(SIMULATED_ACCOUNT);
  });
});
