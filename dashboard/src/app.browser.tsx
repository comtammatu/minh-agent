import { render, screen, waitFor } from "@testing-library/react";
import { App } from "@/app";

const SNAPSHOT_PAYLOAD = {
  bootstrap: { phase: "ready", trackedCoins: ["BTC", "ETH"] },
  mode: { exchange: "HL", paperTrade: true },
  operator: { globalPaused: false, pauseReason: null },
  health: {
    overall: "ok",
    uptime: 120,
    rssBytes: 1_000_000,
    components: {
      feed: { status: "ok", consecutiveErrors: 0 },
      db: { status: "ok", consecutiveErrors: 0 },
      exchange: { status: "ok", consecutiveErrors: 0 },
    },
  },
  account: {
    source: "live",
    balance: 1000,
    equity: 1010,
    available: 900,
    marginUsed: 100,
    withdrawable: null,
    spotUsdcBalance: null,
    unrealizedPnl: 10,
    wins: 2,
    losses: 1,
    tradeCount: 3,
    winRate: 2 / 3,
  },
  positions: [
    {
      positionId: "eth-position",
      coin: "ETH",
      side: "short",
      entryPrice: 3200,
      markPrice: 3150,
      unrealizedPnl: 50,
      currentSize: 2,
      leverage: 3,
    },
  ],
  watchlist: [
    {
      coin: "BTC",
      interval: "1h",
      regime: "BULL",
      bias: "bullish",
      biasConfidence: 0.72,
      confluenceGrade: "A",
      activeCount: 1,
      lastUpdateAt: 1_780_806_000_000,
      markPrice: 65_120,
      funding: 0.0001,
      dayChangePctUtc: 0.012,
    },
  ],
  activeSetups: [
    {
      id: "eth-setup",
      coin: "ETH",
      side: "short",
      interval: "4h",
      entryPrice: 3200,
      slPrice: 3260,
      tpPrice: 3050,
      confidence: 0.71,
      detectedAt: "2026-04-16T04:35:00.000Z",
    },
  ],
  summaryMetrics: {
    winRate: { daily: 0.5, weekly: 0.5, monthly: 0.5, allTime: 0.5 },
    pnl: { daily: 10, weekly: 20, monthly: 30, allTime: 40 },
    trades: { daily: 1, weekly: 2, monthly: 3, allTime: 4 },
    currentDrawdown: 0.1,
    maxDrawdown: 0.2,
    openPositionCount: 1,
  },
  recentJournal: [],
};

function installFetchMock() {
  const mock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/api/dashboard/snapshot")) {
      return new Response(JSON.stringify(SNAPSHOT_PAYLOAD));
    }
    if (url.includes("/api/dashboard/journal")) {
      return new Response(
        JSON.stringify({
          rows: [
            {
              id: "row-1",
              ts: "2026-04-16T04:35:00.000Z",
              eventType: "enter",
              coin: "ETH",
              exchange: "HL",
              agentState: "ENTERING",
              details: { note: "test row" },
            },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ rows: [] }));
  });

  global.fetch = mock as typeof fetch;
  return mock;
}

describe("App", () => {
  it("renders overview shell from snapshot API", async () => {
    window.history.pushState({}, "", "/dashboard/");
    installFetchMock();

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getAllByText("Minh Algo Trading Terminal").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Live exposure")).toBeInTheDocument();
      expect(screen.getByText("PAPER")).toBeInTheDocument();
    });
  });

  it("hydrates market state from query params and canonicalizes invalid params", async () => {
    installFetchMock();
    window.history.pushState(
      {},
      "",
      "/dashboard/market?coin=DOGE&resolution=3",
    );

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Market" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Runtime market state")).toBeInTheDocument();
      expect(screen.getByText("$65,120.00")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(window.location.search).toBe("?coin=BTC");
    });
  });

  it("hydrates journal filters from query params", async () => {
    const fetchMock = installFetchMock();
    window.history.pushState({}, "", "/dashboard/journal?coin=ETH&event=enter");

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Journal" }),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Open")[0]).toBeInTheDocument();
    });

    await waitFor(() => {
      const journalCall = fetchMock.mock.calls
        .map(([input]: [string | URL | Request]) =>
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        )
        .find((url: string) => url.includes("/api/dashboard/journal"));

      expect(journalCall).toContain("coin=ETH");
      expect(journalCall).toContain("eventType=enter");
    });
  });
});
