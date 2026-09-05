/**
 * bybit-coin-selector tests — fetchBybitRankedCoins + makeBybitFetchRankedFn.
 *
 * Mocks RestClientV5.getTickers to test pure ranking/filtering logic.
 */

import { describe, expect, it, mock } from "bun:test";

// ── Mock bybit-api ──────────────────────────────────────────────────────────

type Ticker = {
  symbol: string;
  openInterestValue: string;
  turnover24h: string;
  markPrice: string;
};

let mockTickers: Ticker[] = [];
let mockRetCode = 0;

mock.module("bybit-api", () => ({
  RestClientV5: class {
    async getTickers(_params: unknown) {
      return {
        retCode: mockRetCode,
        retMsg: mockRetCode === 0 ? "OK" : "Internal error",
        result: { list: mockTickers },
      };
    }
  },
}));

// Import after mocks
const { fetchBybitRankedCoins, fetchBybitTopCoins, makeBybitFetchRankedFn } =
  await import("../../../src/feed/bb/bybit-coin-selector.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTicker(coin: string, oiValue: number, turnover: number): Ticker {
  return {
    symbol: `${coin}USDT`,
    openInterestValue: String(oiValue),
    turnover24h: String(turnover),
    markPrice: "100",
  };
}

// ── fetchBybitRankedCoins ────────────────────────────────────────────────────

describe("fetchBybitRankedCoins", () => {
  it("returns coins sorted by OI descending", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("ETH", 500_000_000, 2_000_000),
      makeTicker("BTC", 2_000_000_000, 5_000_000),
      makeTicker("SOL", 100_000_000, 1_500_000),
    ];
    const result = await fetchBybitRankedCoins();
    expect(result).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("filters coins below minVolume", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("BTC", 2_000_000_000, 5_000_000),
      makeTicker("LOWVOL", 1_000_000_000, 500_000), // below 1M threshold
    ];
    const result = await fetchBybitRankedCoins(1_000_000);
    expect(result).toEqual(["BTC"]);
    expect(result).not.toContain("LOWVOL");
  });

  it("filters non-USDT symbols", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("BTC", 2_000_000_000, 5_000_000),
      {
        symbol: "BTCUSD",
        openInterestValue: "999999999",
        turnover24h: "5000000",
        markPrice: "100",
      },
      {
        symbol: "BTC-28MAR25",
        openInterestValue: "999999999",
        turnover24h: "5000000",
        markPrice: "100",
      },
    ];
    const result = await fetchBybitRankedCoins();
    expect(result).toEqual(["BTC"]);
  });

  it("filters coins with zero OI", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("BTC", 2_000_000_000, 5_000_000),
      makeTicker("ZERO", 0, 5_000_000),
    ];
    const result = await fetchBybitRankedCoins();
    expect(result).toEqual(["BTC"]);
  });

  it("returns empty array on API error (retCode != 0)", async () => {
    mockRetCode = 10001;
    mockTickers = [];
    const result = await fetchBybitRankedCoins();
    expect(result).toEqual([]);
  });

  it("handles empty ticker list", async () => {
    mockRetCode = 0;
    mockTickers = [];
    const result = await fetchBybitRankedCoins();
    expect(result).toEqual([]);
  });

  it("extracts coin name correctly from USDT symbol", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("1000SHIB", 50_000_000, 2_000_000),
      makeTicker("BTC", 2_000_000_000, 5_000_000),
    ];
    const result = await fetchBybitRankedCoins();
    expect(result).toContain("BTC");
    expect(result).toContain("1000SHIB");
  });
});

// ── fetchBybitTopCoins ───────────────────────────────────────────────────────

describe("fetchBybitTopCoins", () => {
  it("respects limit parameter", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("BTC", 4_000_000_000, 5_000_000),
      makeTicker("ETH", 3_000_000_000, 4_000_000),
      makeTicker("SOL", 2_000_000_000, 3_000_000),
      makeTicker("BNB", 1_000_000_000, 2_000_000),
    ];
    const result = await fetchBybitTopCoins(2);
    expect(result).toEqual(["BTC", "ETH"]);
    expect(result).toHaveLength(2);
  });

  it("falls back to static coins when fetch returns empty", async () => {
    mockRetCode = 0;
    mockTickers = [];
    const result = await fetchBybitTopCoins(50);
    // Static fallback should contain well-known coins
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("BTC");
    expect(result).toContain("ETH");
  });
});

// ── makeBybitFetchRankedFn ───────────────────────────────────────────────────

describe("makeBybitFetchRankedFn", () => {
  it("returns full ranked list (not sliced)", async () => {
    mockRetCode = 0;
    mockTickers = [
      makeTicker("BTC", 4_000_000_000, 5_000_000),
      makeTicker("ETH", 3_000_000_000, 4_000_000),
      makeTicker("SOL", 2_000_000_000, 3_000_000),
    ];
    const fn = makeBybitFetchRankedFn();
    const result = await fn();
    expect(result).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("falls back to static coins when ranked fetch returns empty", async () => {
    mockRetCode = 10001;
    mockTickers = [];
    const fn = makeBybitFetchRankedFn();
    const result = await fn();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("BTC");
  });
});
