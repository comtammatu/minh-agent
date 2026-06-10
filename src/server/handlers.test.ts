import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AdvisorSnapshot } from "../advisor/index.js";
import type { ScoredMemory } from "../memory/index.js";
import type { TuiDataSources } from "../ui/tui.jsx";
import type { DashboardServerState } from "./contracts.js";
import { createDashboardFetchHandler } from "./handlers.js";

function createSources(): TuiDataSources {
  return {
    getAgentSnapshot: () => ({
      global: {
        dailyPnl: 10,
        totalConsecutiveLosses: 0,
        globalPaused: false,
        globalPauseReason: null,
        uptime: 1_000,
      },
      coins: {},
    }),
    getPositions: () =>
      new Map([
        [
          "pos-1",
          {
            positionId: "pos-1",
            coin: "BTC",
            side: "long" as const,
            leverage: 3,
            currentSize: 1,
            entryPrice: 100,
            slPrice: 95,
            tpPrice: 110,
          },
        ],
      ]),
    getStatus: () => [
      {
        coin: "BTC",
        interval: "1h",
        regime: "BULL" as const,
        bias: "bullish",
        biasConfidence: 0.7,
        confluenceGrade: "A" as const,
        activeCount: 1,
        lastUpdateAt: Date.now(),
      },
    ],
    getHealthReport: () => ({
      overall: "ok",
      uptime: 10,
      rssBytes: 100_000,
      components: {
        feed: {
          status: "ok",
          lastSuccessAt: 1,
          lastErrorAt: 0,
          lastError: null,
          consecutiveErrors: 0,
        },
        db: {
          status: "ok",
          lastSuccessAt: 1,
          lastErrorAt: 0,
          lastError: null,
          consecutiveErrors: 0,
        },
        exchange: {
          status: "ok",
          lastSuccessAt: 1,
          lastErrorAt: 0,
          lastError: null,
          consecutiveErrors: 0,
        },
      },
    }),
    getAccountState: () =>
      Promise.resolve({
        effectiveBalance: 1_000,
        accountValue: 1_050,
        spotUsdcBalance: 500,
        totalMarginUsed: 100,
        withdrawable: 900,
      }),
    getSubscriptionCount: () => 12,
    getTrackedCoins: () => ["BTC"],
    getPaperStats: () => null,
    getLiveWalletStats: () => ({
      wallets: [
        { label: "smc-sd", wins: 2, losses: 1, tradeCount: 3, winRate: 2 / 3 },
      ],
      wins: 2,
      losses: 1,
      tradeCount: 3,
      winRate: 2 / 3,
    }),
    getLiveAccountStates: () => null,
    getAssetPrice: () => ({
      markPrice: 102,
      funding: 0.001,
      dayChangePctUtc: 1.5,
    }),
    getActiveSetups: () => [
      {
        id: "BTC|1h|smc-sd",
        coin: "BTC",
        interval: "1h",
        type: "smc-sd",
        side: "long" as const,
        confidence: 0.85,
        entryPrice: 100,
        slPrice: 95,
        tpPrice: 110,
        patternData: {},
        detectedAt: Date.now(),
        detectedAtBar: 10,
        expiresAtBar: 20,
        exchange: "HL" as const,
      },
    ],
    getInvalidationStats: () => ({
      total: 0,
      matched: 0,
      skipped: 0,
      parseFailed: 0,
      actions: {},
      byStrategy: {},
    }),
  };
}

function createState(): DashboardServerState {
  return {
    activeExchange: "HL",
    getBootstrapPhase: () => "warming_up",
    sources: createSources(),
  };
}

describe("createDashboardFetchHandler", () => {
  let origExecutionMode: string | undefined;
  let origPaperTrade: string | undefined;
  let origAdvisorMode: string | undefined;

  beforeEach(() => {
    origExecutionMode = process.env.EXECUTION_MODE;
    origPaperTrade = process.env.PAPER_TRADE;
    origAdvisorMode = process.env.ADVISOR_MODE;
    delete process.env.EXECUTION_MODE;
    delete process.env.PAPER_TRADE;
    delete process.env.ADVISOR_MODE;
  });

  afterEach(() => {
    if (origExecutionMode === undefined) delete process.env.EXECUTION_MODE;
    else process.env.EXECUTION_MODE = origExecutionMode;
    if (origPaperTrade === undefined) delete process.env.PAPER_TRADE;
    else process.env.PAPER_TRADE = origPaperTrade;
    if (origAdvisorMode === undefined) delete process.env.ADVISOR_MODE;
    else process.env.ADVISOR_MODE = origAdvisorMode;
  });

  const handler = createDashboardFetchHandler({
    state: createState(),
    getSummaryMetrics: async () => ({
      winRate: { daily: 0.5, weekly: 0.5, monthly: 0.5, allTime: 0.5 },
      pnl: { daily: 10, weekly: 20, monthly: 30, allTime: 40 },
      trades: { daily: 1, weekly: 2, monthly: 3, allTime: 4 },
      patternMetrics: [],
      coinMetrics: [],
      currentDrawdown: 0.1,
      maxDrawdown: 0.2,
      openPositionCount: 1,
    }),
    readJournal: async (filter) => [
      {
        id: 1,
        ts: new Date("2026-04-16T00:00:00Z"),
        eventType: filter?.eventType ?? "signal",
        coin: filter?.coin ?? "BTC",
        details: { side: "long", interval: "1h", pnl: 12 },
        agentState: "WATCHING",
        exchange: "HL",
      },
    ],
    distDir: "/tmp/does-not-matter",
  });

  it("serves snapshot route with warming_up state", async () => {
    const response = await handler(
      new Request("http://localhost/api/dashboard/snapshot"),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.bootstrap.phase).toBe("warming_up");
    expect(body.positions).toHaveLength(1);
    expect(body.mode.executionMode).toBe("paper");
    expect(body.mode.paperTrade).toBe(true);
    expect(body.operator.globalPaused).toBe(false);
  });

  it("filters journal rows by coin and eventType", async () => {
    const response = await handler(
      new Request(
        "http://localhost/api/dashboard/journal?coin=BTC&eventType=exit&limit=5",
      ),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rows[0].eventType).toBe("exit");
    expect(body.rows[0].coin).toBe("BTC");
  });

  it("GET /api/advisor returns snapshot stats and insights", async () => {
    const advisorSnapshot: AdvisorSnapshot = {
      buckets: new Map([
        [
          "spring|BULL|long",
          {
            key: "spring|BULL|long",
            trades: 12,
            wins: 8,
            losses: 4,
            smoothedWinRate: 0.6429,
            avgR: 0.8,
          },
        ],
        [
          "ob|long",
          {
            key: "ob|long",
            trades: 20,
            wins: 9,
            losses: 11,
            smoothedWinRate: 0.4545,
            avgR: -0.1,
          },
        ],
      ]),
      global: {
        key: "*",
        trades: 32,
        wins: 17,
        losses: 15,
        smoothedWinRate: 0.5294,
        avgR: 0.24,
      },
      builtAt: 1_750_000_000_000,
      sampleSize: 32,
    };
    const insightMemory: ScoredMemory = {
      id: 7,
      category: "pattern_insight",
      coin: null,
      timeframe: null,
      pattern: "ob|long",
      regime: null,
      side: null,
      pnlR: null,
      confidence: null,
      content:
        "Bucket ob|long underperforms baseline: winRate 45% vs global 53%",
      metadata: { bucketKey: "ob|long", trades: 20 },
      importance: 0.7,
      accessCount: 0,
      createdAt: new Date("2026-06-09T00:00:00Z"),
      lastAccessedAt: new Date("2026-06-09T00:00:00Z"),
      score: 0.8,
    };
    const advisorHandler = createDashboardFetchHandler({
      state: createState(),
      getAdvisorSnapshot: () => advisorSnapshot,
      readMemories: async () => [insightMemory],
      distDir: "/tmp/does-not-matter",
    });
    const response = await advisorHandler(
      new Request("http://localhost/api/advisor"),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mode).toBe("shadow");
    expect(body.builtAt).toBe(1_750_000_000_000);
    expect(body.sampleSize).toBe(32);
    // Sorted by trades desc
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      "ob|long",
      "spring|BULL|long",
    ]);
    expect(body.buckets[0]).toEqual({
      key: "ob|long",
      trades: 20,
      wins: 9,
      losses: 11,
      smoothedWinRate: 0.4545,
      avgR: -0.1,
    });
    expect(body.insights).toHaveLength(1);
    expect(body.insights[0].content).toContain("underperforms");
    expect(body.insights[0].createdAt).toBe("2026-06-09T00:00:00.000Z");
    expect(body.insights[0].metadata.bucketKey).toBe("ob|long");
  });

  it("GET /api/advisor handles empty state before first refresh", async () => {
    const advisorHandler = createDashboardFetchHandler({
      state: createState(),
      getAdvisorSnapshot: () => null,
      readMemories: async () => [],
      distDir: "/tmp/does-not-matter",
    });
    const response = await advisorHandler(
      new Request("http://localhost/api/advisor"),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mode).toBe("shadow");
    expect(body.builtAt).toBeNull();
    expect(body.sampleSize).toBe(0);
    expect(body.buckets).toEqual([]);
    expect(body.insights).toEqual([]);
  });

  it("GET /api/advisor fails open when the memory read throws", async () => {
    const advisorHandler = createDashboardFetchHandler({
      state: createState(),
      getAdvisorSnapshot: () => null,
      readMemories: async () => {
        throw new Error("db down");
      },
      distDir: "/tmp/does-not-matter",
    });
    const response = await advisorHandler(
      new Request("http://localhost/api/advisor"),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.insights).toEqual([]);
  });

  it("POST /api/operator/flatten requires confirm", async () => {
    const response = await handler(
      new Request("http://localhost/api/operator/flatten", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("missing_confirm");
  });

  it("POST /api/operator/flatten executes with confirm", async () => {
    const operatorHandler = createDashboardFetchHandler({
      state: createState(),
      getSummaryMetrics: async () => ({
        winRate: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        pnl: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        trades: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        patternMetrics: [],
        coinMetrics: [],
        currentDrawdown: 0,
        maxDrawdown: 0,
        openPositionCount: 0,
      }),
      readJournal: async () => [],
      operatorActions: {
        flatten: async () => ({
          cancelled: 1,
          closed: 2,
          verifiedFlat: true,
          remainingPositions: 0,
          remainingOrders: 0,
        }),
        pause: () => {},
        resume: () => {},
        logAudit: async () => {},
      },
    });
    const response = await operatorHandler(
      new Request("http://localhost/api/operator/flatten", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, reason: "test" }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      cancelled: 1,
      closed: 2,
      verifiedFlat: true,
      remainingPositions: 0,
      remainingOrders: 0,
    });
  });

  it("POST /api/operator/resume requires confirm", async () => {
    const response = await handler(
      new Request("http://localhost/api/operator/resume", { method: "POST" }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("missing_confirm");
  });

  it("POST /api/operator/resume succeeds with confirm", async () => {
    let resumed = false;
    const operatorHandler = createDashboardFetchHandler({
      state: createState(),
      getSummaryMetrics: async () => ({
        winRate: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        pnl: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        trades: { daily: 0, weekly: 0, monthly: 0, allTime: 0 },
        patternMetrics: [],
        coinMetrics: [],
        currentDrawdown: 0,
        maxDrawdown: 0,
        openPositionCount: 0,
      }),
      readJournal: async () => [],
      operatorActions: {
        flatten: async () => ({
          cancelled: 0,
          closed: 0,
          verifiedFlat: true,
          remainingPositions: 0,
          remainingOrders: 0,
        }),
        pause: () => {},
        resume: () => {
          resumed = true;
        },
        logAudit: async () => {},
      },
    });
    const response = await operatorHandler(
      new Request("http://localhost/api/operator/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, resumed: true });
    expect(resumed).toBe(true);
  });
});
