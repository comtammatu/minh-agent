import { describe, expect, it, mock } from "bun:test";

// ─── Mock dependencies before any import of bybit-feed ───────────────────────

const mockBackfillBybitCoins = mock(() =>
  Promise.resolve([{ coin: "BTC", readyTFs: 6 }]),
);

const mockSubscribeBybitCandles = mock(() => Promise.resolve());
const mockCloseAllBybit = mock(() => Promise.resolve());
const mockCheckBybitStaleness = mock(() => {});

mock.module("./bybit-rest.js", () => ({
  backfillBybitCoins: mockBackfillBybitCoins,
}));

mock.module("./bybit-ws.js", () => ({
  subscribeBybitCandles: mockSubscribeBybitCandles,
  closeAllBybit: mockCloseAllBybit,
  checkBybitStaleness: mockCheckBybitStaleness,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BybitFeed", () => {
  it("exchangeId is BB", async () => {
    const { BybitFeed } = await import("./bybit-feed.js");
    const feed = new BybitFeed();
    expect(feed.exchangeId).toBe("BB");
  });

  it("backfill delegates to backfillBybitCoins", async () => {
    const { BybitFeed } = await import("./bybit-feed.js");
    const feed = new BybitFeed();
    const result = await feed.backfill(["BTC"], () => {});
    expect(mockBackfillBybitCoins).toHaveBeenCalled();
    expect(result[0]?.coin).toBe("BTC");
  });

  it("subscribe calls subscribeBybitCandles for each coin×tf", async () => {
    const { BybitFeed } = await import("./bybit-feed.js");
    const feed = new BybitFeed();
    mockSubscribeBybitCandles.mockClear();
    await feed.subscribe(["BTC", "ETH"], () => {});
    // 2 coins × 6 timeframes = 12 calls
    expect(mockSubscribeBybitCandles).toHaveBeenCalledTimes(12);
  });

  it("closeAll delegates to closeAllBybit", async () => {
    const { BybitFeed } = await import("./bybit-feed.js");
    const feed = new BybitFeed();
    await feed.closeAll();
    expect(mockCloseAllBybit).toHaveBeenCalled();
  });

  it("checkStaleness delegates to checkBybitStaleness", async () => {
    const { BybitFeed } = await import("./bybit-feed.js");
    const feed = new BybitFeed();
    feed.checkStaleness();
    expect(mockCheckBybitStaleness).toHaveBeenCalled();
  });
});
