import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ─── Mock singletons ─────────────────────────────────────────────────────────

const mockSnapshot = {
  coins: {
    BTC: {
      state: "WATCHING",
      activeSetup: null,
      pendingOrderId: null,
      positionId: null,
      consecutiveLosses: 0,
      stateAge: 5000,
    },
    ETH: {
      state: "IN_POSITION",
      activeSetup: null,
      pendingOrderId: null,
      positionId: "pos-1",
      consecutiveLosses: 2,
      stateAge: 10000,
    },
    SOL: {
      state: "IDLE",
      activeSetup: null,
      pendingOrderId: null,
      positionId: null,
      consecutiveLosses: 0,
      stateAge: 1000,
    },
  },
  global: {
    dailyPnl: -42.5,
    totalConsecutiveLosses: 1,
    globalPaused: false,
    globalPauseReason: null,
    uptime: 3_660_000, // 61 minutes
  },
};

let pausedWith: string | null = null;
let resumed = false;
const dispatchedEvents: Array<{
  coin: string;
  event: { type: string; reason?: string };
}> = [];

mock.module("../../agent/trading-agent.js", () => ({
  getAgent: () => ({
    getSnapshot: () => mockSnapshot,
    pauseAll: (reason: string) => {
      pausedWith = reason;
    },
    resumeAll: () => {
      resumed = true;
    },
    getCoinState: (coin: string) =>
      mockSnapshot.coins[coin as keyof typeof mockSnapshot.coins]?.state ??
      "IDLE",
    getCoinContext: (coin: string) =>
      mockSnapshot.coins[coin as keyof typeof mockSnapshot.coins] ?? null,
    dispatch: (coin: string, event: { type: string; reason?: string }) => {
      dispatchedEvents.push({ coin, event });
    },
  }),
}));

let closeAllResult = { cancelled: 0, closed: 0 };
const handledActions: Array<Record<string, unknown>> = [];
const recordedTraceActions: Array<Record<string, unknown>> = [];
const loggedOperatorActions: Array<unknown[]> = [];
mock.module("../../agent/close-all.js", () => ({
  closeAllPositions: async (_reason: string) => closeAllResult,
}));

const mockPositions = new Map([
  [
    "pos-1",
    {
      positionId: "pos-1",
      coin: "ETH",
      side: "long" as const,
      entryPrice: 3200.5,
      currentSize: 0.5,
      originalSize: 0.5,
      slPrice: 3100,
      tpPrice: 3500,
      leverage: 3,
      entryOrderId: "ord-1",
      trailingState: null,
      partialClosesFired: [],
      lastSyncAt: Date.now(),
      openedAt: Date.now(),
    },
  ],
]);

mock.module("../../agent/position-monitor.js", () => ({
  getPositionMonitor: () => ({
    getPositions: () => new Map(mockPositions),
    getPosition: (id: string) => mockPositions.get(id) ?? null,
  }),
}));

mock.module("../../agent/order-manager.js", () => ({
  getOrderManager: () => ({
    handleAction: async (action: Record<string, unknown>) => {
      handledActions.push(action);
    },
  }),
}));

mock.module("../../agent/self-healing.js", () => ({
  getHealthMonitor: () => ({
    getReport: () => ({
      overall: "ok",
      uptime: 3660,
      rssBytes: 50_000_000,
      components: {
        feed: {
          status: "ok",
          lastSuccessAt: Date.now(),
          lastErrorAt: 0,
          consecutiveErrors: 0,
          lastError: null,
        },
        db: {
          status: "ok",
          lastSuccessAt: Date.now(),
          lastErrorAt: 0,
          consecutiveErrors: 0,
          lastError: null,
        },
        exchange: {
          status: "ok",
          lastSuccessAt: Date.now(),
          lastErrorAt: 0,
          consecutiveErrors: 0,
          lastError: null,
        },
      },
    }),
  }),
}));

mock.module("../../analytics/metrics-service.js", () => ({
  getLiveMetrics: async () => ({
    winRate: { daily: 0.6, weekly: 0.55, monthly: 0.52, allTime: 0.5 },
    pnl: { daily: 120.5, weekly: 450.3, monthly: 1200.0, allTime: 5000.0 },
    trades: { daily: 5, weekly: 20, monthly: 80, allTime: 300 },
    patternMetrics: [],
    coinMetrics: [],
    currentDrawdown: -2.5,
    maxDrawdown: -8.3,
    openPositionCount: 1,
  }),
}));

const mockDecisionTrace = {
  traceId: "smc-sd:BTC|1h|setup|1710",
  coin: "BTC",
  interval: "1h" as const,
  exchange: "HL" as const,
  ts: 1_710_000_000_000,
  regime: {
    state: "BULL" as const,
    confidence: 0.74,
    modifier: 1,
  },
  roles: {
    judge: {
      role: "judge" as const,
      verdict: "approve" as const,
      confidence: 0.74,
      summary: "Setup is approved for watch/execution.",
      reasonsFor: ["Confluence A"],
      reasonsAgainst: ["Execution pending"],
    },
    guardian: {
      role: "guardian" as const,
      state: "trail_sl" as const,
      summary: "Guardian moved stop to 4200.00.",
      actions: ["trail_sl:4200"],
    },
    executor: {
      role: "executor" as const,
      state: "filled" as const,
      summary: "Order filled and position is live.",
    },
  },
  timeline: [
    {
      ts: 1_710_000_000_000,
      actor: "judge" as const,
      action: "approve",
      summary: "Setup is approved for watch/execution.",
    },
    {
      ts: 1_710_000_100_000,
      actor: "guardian" as const,
      action: "trail_sl",
      summary: "Guardian moved stop to 4200.00.",
    },
  ],
  outcome: {
    action: "trail_sl" as const,
    confidence: 0.74,
    summary: "Stop updated to 4200.00.",
    setupId: "smc-sd:BTC|1h|smc-sd",
    positionId: "pos-1",
  },
};

mock.module("../../strategy/index.js", () => ({
  getDecisionTraces: () => [mockDecisionTrace],
  getDecisionTraceBySetupId: (id: string) =>
    id === mockDecisionTrace.outcome.setupId ? mockDecisionTrace : null,
  getDecisionTraceByPositionId: (id: string) =>
    id === mockDecisionTrace.outcome.positionId ? mockDecisionTrace : null,
  getDecisionTracesForCoin: (coin: string) =>
    coin === mockDecisionTrace.coin ? [mockDecisionTrace] : [],
  recordDecisionTraceAgentAction: (action: Record<string, unknown>) => {
    recordedTraceActions.push(action);
  },
}));

const mockOperatorEntries = [
  {
    id: 1,
    ts: new Date("2026-04-14T03:04:05Z"),
    eventType: "operator" as const,
    coin: "BTC",
    details: {
      action: "close",
      target: "BTC LONG",
      status: "submitted",
      operatorSource: "telegram",
      positionId: "pos-1",
      reason: "manual via TUI (BTC LONG)",
    },
    agentState: null,
    exchange: "HL" as const,
  },
  {
    id: 2,
    ts: new Date("2026-04-14T03:05:06Z"),
    eventType: "operator" as const,
    coin: "ETH",
    details: {
      action: "reduce 50%",
      target: "ETH SHORT",
      status: "failed",
      positionId: "pos-2",
      reason: "manual via TUI (ETH SHORT)",
    },
    agentState: null,
    exchange: "HL" as const,
  },
];

mock.module("../../agent/journal.js", () => ({
  getJournalEntries: async (filter?: {
    coin?: string;
    eventType?: string;
    limit?: number;
  }) => {
    const filtered = mockOperatorEntries.filter((entry) => {
      if (filter?.eventType && entry.eventType !== filter.eventType)
        return false;
      if (filter?.coin && entry.coin !== filter.coin) return false;
      return true;
    });
    return filtered.slice(0, filter?.limit ?? filtered.length);
  },
  logOperatorAuditEntry: async (...args: unknown[]) => {
    loggedOperatorActions.push(args);
  },
}));

interface MockAdvisorBucket {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  smoothedWinRate: number;
  avgR: number | null;
}

interface MockAdvisorSnapshot {
  buckets: Map<string, MockAdvisorBucket>;
  global: MockAdvisorBucket | null;
  builtAt: number;
  sampleSize: number;
}

function defaultMockAdvisorSnapshot(): MockAdvisorSnapshot {
  return {
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
    builtAt: Date.now(),
    sampleSize: 32,
  };
}

let mockAdvisorSnapshot: MockAdvisorSnapshot | null =
  defaultMockAdvisorSnapshot();

mock.module("../../advisor/index.js", () => ({
  getAdvisorCache: () => ({
    getSnapshot: () => mockAdvisorSnapshot,
  }),
}));

let mockInsightMemories: Array<{
  content: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}> = [];

mock.module("../../memory/index.js", () => ({
  queryMemories: async () => mockInsightMemories,
}));

mock.module("./briefing-refresh-stats.js", () => ({
  getBriefingRefreshStats: () => ({
    requested: 7,
    coalesced: 2,
    skippedIdentical: 1,
    edited: 4,
    failed: 0,
    lastOutcome: "edited",
    lastKey: "22345:42",
    lastKind: "morning",
    lastAt: Date.parse("2026-04-14T03:15:16Z"),
  }),
  getBriefingRefreshHealth: () => ({
    state: "healthy",
    samples: 7,
    requested: 7,
    edited: 4,
    failed: 0,
    coalesced: 2,
    skippedIdentical: 1,
    editRatio: 4 / 7,
    failureStreak: 0,
    coalescedStreak: 0,
    lastOutcome: "edited",
    lastKey: "22345:42",
    lastKind: "morning",
    lastAt: Date.parse("2026-04-14T03:15:16Z"),
    lastCoin: "BTC",
    lastPositionId: "pos-1",
    lastTarget: "BTC / pos-1",
    lastAttention: "BTC 1h TRAIL_SL",
    recoveredFrom: "critical",
    recoveredAt: Date.parse("2026-04-14T03:15:16Z"),
    recoveredCoin: "BTC",
    recoveredPositionId: "pos-1",
    recoveredTarget: "BTC / pos-1",
    recoveredAttention: "BTC 1h TRAIL_SL",
  }),
  getBriefingRefreshHistory: () => [
    {
      ts: Date.parse("2026-04-14T03:15:16Z"),
      from: "critical",
      to: "healthy",
      kind: "morning",
      outcome: "edited",
      coin: "BTC",
      positionId: "pos-1",
      target: "BTC / pos-1",
      attention: "BTC 1h TRAIL_SL",
    },
    {
      ts: Date.parse("2026-04-14T03:12:00Z"),
      from: "degraded",
      to: "critical",
      kind: "morning",
      outcome: "coalesced",
      coin: "BTC",
      positionId: "pos-1",
      target: "BTC / pos-1",
      attention: "BTC 1h TRAIL_SL",
    },
    {
      ts: Date.parse("2026-04-14T03:10:00Z"),
      from: "healthy",
      to: "degraded",
      kind: "morning",
      outcome: "coalesced",
      coin: "BTC",
      positionId: "pos-1",
      target: "BTC / pos-1",
      attention: "BTC 1h WATCH",
    },
  ],
  getBriefingRefreshIncidents: () => [
    {
      startedAt: Date.parse("2026-04-14T03:10:00Z"),
      resolvedAt: Date.parse("2026-04-14T03:15:16Z"),
      target: "BTC / pos-1",
      attention: "BTC 1h TRAIL_SL",
      peakState: "critical",
      status: "recovered",
      transitions: [],
    },
    {
      startedAt: Date.parse("2026-04-14T03:16:00Z"),
      resolvedAt: null,
      target: "ETH / pos-2",
      attention: "ETH 5m WATCH",
      peakState: "degraded",
      status: "active",
      transitions: [],
    },
  ],
}));

import {
  findCommand,
  getCommands,
  getMainMenuKeyboard,
  parsePauseCoinArgs,
  registerBuiltinCommands,
  registerCommand,
  resetCloseAllState,
  resetCommands,
} from "./commands.js";

describe("command registry", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("starts empty", () => {
    expect(getCommands()).toHaveLength(0);
  });

  it("registers a command", () => {
    registerCommand({
      name: "test",
      description: "A test command",
      handler: () => "ok",
    });
    expect(getCommands()).toHaveLength(1);
    expect(getCommands()[0].name).toBe("test");
  });

  it("finds a registered command", () => {
    registerCommand({ name: "foo", description: "Foo", handler: () => "bar" });
    const cmd = findCommand("foo");
    expect(cmd).not.toBeNull();
    expect(cmd?.name).toBe("foo");
  });

  it("returns null for unknown command", () => {
    expect(findCommand("nonexistent")).toBeNull();
  });

  it("resetCommands clears all", () => {
    registerCommand({ name: "a", description: "A", handler: () => "" });
    registerCommand({ name: "b", description: "B", handler: () => "" });
    expect(getCommands()).toHaveLength(2);
    resetCommands();
    expect(getCommands()).toHaveLength(0);
  });
});

describe("registerBuiltinCommands", () => {
  beforeEach(() => {
    resetCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("registers /help command", () => {
    registerBuiltinCommands();
    const cmd = findCommand("help");
    expect(cmd).not.toBeNull();
    expect(cmd?.description).toBe("Show this help message");
  });

  it("/help handler lists all commands", () => {
    registerBuiltinCommands();

    const helpCmd = findCommand("help")!;
    const reply = helpCmd.handler("", 0) as string;
    expect(reply).toContain("Minh");
    expect(reply).toContain("/help");
    expect(reply).toContain("/status");
    expect(reply).toContain("/trace");
    expect(reply).toContain("/operator");
    expect(reply).toContain("/positions");
    expect(reply).toContain("/pnl");
    expect(reply).toContain("/pause");
    expect(reply).toContain("/resume");
    expect(reply).toContain("/risk");
    expect(reply).toContain("/closeall");
    expect(reply).toContain("/confirm");
    expect(reply).toContain("/report");
    expect(reply).toContain("/advisor");
    expect(reply).toContain("/menu");
    expect(reply).toContain("/mode");
  });

  it("registers 15 built-in commands", () => {
    registerBuiltinCommands();
    expect(getCommands()).toHaveLength(15);
  });

  it("includes operator and trace buttons in the main menu keyboard", () => {
    const keyboard = getMainMenuKeyboard();
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain("🧾 Operator");
    expect(labels).toContain("🧠 Trace");
  });

  it("builds a compact keyboard for scheduled briefings", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(getBriefingReplyMarkup()).toEqual({
      inline_keyboard: [
        [
          { text: "🧠 Trace", callback_data: "c:trace" },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          { text: "🧾 Operator", callback_data: "c:operator" },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
      ],
    });
  });

  it("uses focused position context in scheduled briefing keyboard when provided", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({ positionId: "pos-1", coin: "btc" }),
    ).toEqual({
      inline_keyboard: [
        [
          {
            text: "🧠 Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          {
            text: "🧾 Operator",
            callback_data: "c:briefing_operator_position:pos-1",
          },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
      ],
    });
  });

  it("adds bucket drill-down buttons for representative briefing cases", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({
        positionId: "pos-1",
        coin: "btc",
        buckets: [
          { label: "Guardian Active", coin: "eth" },
          { label: "Watching", positionId: "pos-2", coin: "sol" },
        ],
      }),
    ).toEqual({
      inline_keyboard: [
        [
          {
            text: "🧠 Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          {
            text: "🧾 Operator",
            callback_data: "c:briefing_operator_position:pos-1",
          },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
        [
          {
            text: "↘️ Guardian Active",
            callback_data: "c:briefing_trace_coin:ETH",
          },
          {
            text: "↘️ Watching",
            callback_data: "c:briefing_trace_position:pos-2",
          },
        ],
      ],
    });
  });

  it("adds health drill-down buttons when healthTarget is provided", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({
        healthTarget: { positionId: "pos-1", coin: "btc" },
      }),
    ).toEqual({
      inline_keyboard: [
        [
          { text: "🧠 Trace", callback_data: "c:trace" },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          { text: "🧾 Operator", callback_data: "c:operator" },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
        [
          {
            text: "⚠️ Health Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
          {
            text: "⚠️ Health Operator",
            callback_data: "c:briefing_operator_position:pos-1",
          },
        ],
      ],
    });
  });

  it("prioritizes health drill-down buttons when the briefing has an active incident", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({
        prioritizeHealthTarget: true,
        healthTarget: { positionId: "pos-1", coin: "btc" },
      }),
    ).toEqual({
      inline_keyboard: [
        [
          {
            text: "⚠️ Health Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
          {
            text: "⚠️ Health Operator",
            callback_data: "c:briefing_operator_position:pos-1",
          },
        ],
        [
          { text: "🧠 Trace", callback_data: "c:trace" },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          { text: "🧾 Operator", callback_data: "c:operator" },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
      ],
    });
  });

  it("puts Health Operator first when the incident prefers operator intervention", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({
        prioritizeHealthTarget: true,
        preferredHealthAction: "operator",
        healthTarget: { positionId: "pos-1", coin: "btc" },
      }),
    ).toEqual({
      inline_keyboard: [
        [
          {
            text: "⚠️ Health Operator",
            callback_data: "c:briefing_operator_position:pos-1",
          },
          {
            text: "⚠️ Health Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
        ],
        [
          { text: "🧠 Trace", callback_data: "c:trace" },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          { text: "🧾 Operator", callback_data: "c:operator" },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
      ],
    });
  });

  it("uses incident-aware health button labels when provided", async () => {
    const { getBriefingReplyMarkup } = await import("./commands.js");
    expect(
      getBriefingReplyMarkup({
        prioritizeHealthTarget: true,
        preferredHealthAction: "operator",
        healthButtonLabels: {
          trace: "🧠 Inspect Trace",
          operator: "⚠️ Fix Operator Path",
        },
        healthTarget: { positionId: "pos-1", coin: "btc" },
      }),
    ).toEqual({
      inline_keyboard: [
        [
          {
            text: "⚠️ Fix Operator Path",
            callback_data: "c:briefing_operator_position:pos-1",
          },
          {
            text: "🧠 Inspect Trace",
            callback_data: "c:briefing_trace_position:pos-1",
          },
        ],
        [
          { text: "🧠 Trace", callback_data: "c:trace" },
          { text: "📈 Positions", callback_data: "c:positions" },
        ],
        [
          { text: "🧾 Operator", callback_data: "c:operator" },
          { text: "📑 Report", callback_data: "c:report" },
        ],
        [
          {
            text: "🔄 Refresh briefing",
            callback_data: "c:briefing_refresh:live",
          },
        ],
      ],
    });
  });
});

// ─── /status ──────────────────────────────────────────────────────────────────

describe("/status command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns agent state, health, uptime, positions, coins", () => {
    const cmd = findCommand("status")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("Status");
    expect(reply).toContain("RUNNING");
    expect(reply).toContain("ok");
    expect(reply).toContain("1h 1m");
    expect(reply).toContain("42\\.50"); // dailyPnl abs value (escaped)
    expect(reply).toContain("Positions: 1");
    expect(reply).toContain("Coins: 3");
    expect(reply).toContain("Briefing: 4 edited");
    expect(reply).toContain("1 skipped");
    expect(reply).toContain("2 coalesced");
    expect(reply).toContain(
      "Briefing incident: critical recovered BTC / pos\\-1",
    );
    expect(reply).toContain("degraded active ETH / pos\\-2");
    expect(reply).toContain(
      "Briefing history: critical\\-\\>healthy BTC / pos\\-1",
    );
    expect(reply).toContain("degraded\\-\\>critical BTC / pos\\-1");
  });

  it("shows PAUSED when agent is paused", () => {
    mockSnapshot.global.globalPaused = true;
    mockSnapshot.global.globalPauseReason = "daily loss limit";

    const cmd = findCommand("status")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("PAUSED");
    expect(reply).toContain("daily loss limit");

    // Reset
    mockSnapshot.global.globalPaused = false;
    mockSnapshot.global.globalPauseReason = null;
  });
});

// ─── /positions ───────────────────────────────────────────────────────────────

describe("/positions command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("lists open positions with details", () => {
    const cmd = findCommand("positions")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("Open Positions");
    expect(reply).toContain("ETH");
    expect(reply).toContain("LONG");
    expect(reply).toContain("3200\\.50"); // entry price (escaped)
    expect(reply).toContain("0\\.5000"); // size (escaped)
    expect(reply).toContain("3100\\.00"); // SL (escaped)
    expect(reply).toContain("3500\\.00"); // TP (escaped)
  });

  it("shows message when no positions", () => {
    mockPositions.clear();
    const cmd = findCommand("positions")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("No open positions");

    // Restore
    mockPositions.set("pos-1", {
      positionId: "pos-1",
      coin: "ETH",
      side: "long" as const,
      entryPrice: 3200.5,
      currentSize: 0.5,
      originalSize: 0.5,
      slPrice: 3100,
      tpPrice: 3500,
      leverage: 3,
      entryOrderId: "ord-1",
      trailingState: null,
      partialClosesFired: [],
      lastSyncAt: Date.now(),
      openedAt: Date.now(),
    });
  });
});

// ─── /trace ──────────────────────────────────────────────────────────────────

describe("/trace command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns the latest trace when called without args", async () => {
    const cmd = findCommand("trace")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("Decision Trace");
    expect(reply).toContain("BTC");
    expect(reply).toContain("APPROVE");
    expect(reply).toContain("TRAIL\\_SL");
    expect(reply).toContain("Recent");
  });

  it("looks up the latest trace by coin", async () => {
    const cmd = findCommand("trace")!;
    const reply = await cmd.handler("btc", 0);
    expect(reply).toContain("BTC");
    expect(reply).toContain("smc\\-sd");
    expect(reply).toContain("🧭 *Trace Focus*");
    expect(reply).toContain("Target: BTC.");
    expect(reply).toContain("Attention: BTC 1h TRAIL\\_SL.");
  });

  it("looks up trace by setup id", async () => {
    const cmd = findCommand("trace")!;
    const reply = await cmd.handler(
      `setup ${mockDecisionTrace.outcome.setupId}`,
      0,
    );
    expect(reply).toContain("smc\\-sd:BTC\\|1h\\|smc\\-sd");
    expect(reply).toContain("pos\\-1");
  });

  it("looks up trace by position id with guardian snapshot", async () => {
    const cmd = findCommand("trace")!;
    const reply = await cmd.handler(
      `position ${mockDecisionTrace.outcome.positionId}`,
      0,
    );
    expect(reply).toContain("Guardian Snapshot");
    expect(reply).toContain("Guardian: TRAIL SL");
    expect(reply).toContain("Executor: FILLED");
    expect(reply).toContain("Live: ETH LONG");
    expect(reply).toContain("tracked");
    expect(reply).toContain("Size: 0\\.5000");
    expect(reply).toContain("Lev: 3x");
    expect(reply).toContain("Last lifecycle: guardian");
    expect(reply).toContain("Manual Intervention");
    expect(reply).toContain("Status: SUBMITTED");
    expect(reply).toContain("Source: TELEGRAM");
    expect(reply).toContain("Action: close");
  });

  it("returns a not found message for missing trace", async () => {
    const cmd = findCommand("trace")!;
    const reply = await cmd.handler("ETH", 0);
    expect(reply).toContain("Target: ETH.");
    expect(reply).toContain("No decision trace found");
  });
});

// ─── /operator ───────────────────────────────────────────────────────────────

describe("/operator command", () => {
  const CHAT_ID = 12345;

  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    resetCloseAllState(CHAT_ID);
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns recent operator audit entries", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("Operator Audit");
    expect(reply).toContain("latest manual interventions");
    expect(reply).toContain("SUBMITTED");
    expect(reply).toContain("close BTC LONG");
    expect(reply).toContain("FAILED");
    expect(reply).toContain("reduce 50% ETH SHORT");
  });

  it("filters operator audit by coin", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("btc", 0);
    expect(reply).toContain("Filter: BTC");
    expect(reply).toContain("close BTC LONG");
    expect(reply).not.toContain("ETH SHORT");
    expect(reply).toContain("🧭 *Operator Focus*");
    expect(reply).toContain("Target: BTC.");
    expect(reply).toContain("Attention: BTC 1h TRAIL\\_SL.");
  });

  it("keeps operator focus coin-only for position-target mismatch", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("position pos-2", 0);
    expect(reply).toContain("Target: pos\\-2.");
    expect(reply).toContain("Position: pos\\-2");
    expect(reply).toContain("reduce 50% ETH SHORT");
    expect(reply).not.toContain("Attention:");
  });

  it("filters operator audit by position id", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("position pos-2", 0);
    expect(reply).toContain("Position: pos\\-2");
    expect(reply).toContain("reduce 50% ETH SHORT");
    expect(reply).not.toContain("BTC LONG");
  });

  it("returns a no-data message when no operator audit is found", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("sol", 0);
    expect(reply).toContain("No operator audit entries found");
  });

  it("requests confirmation before closing a tracked position", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("close pos-1", CHAT_ID);
    expect(reply).toContain("Remote Operator Action");
    expect(reply).toContain("/confirm");
    expect(reply).toContain("pos\\-1");
    expect(handledActions).toHaveLength(0);
  });

  it("/confirm executes a pending close action", async () => {
    const cmd = findCommand("operator")!;
    await cmd.handler("close pos-1", CHAT_ID);

    const confirmCmd = findCommand("confirm")!;
    const reply = await confirmCmd.handler("", CHAT_ID);
    expect(reply).toContain("Operator Action Executed");
    expect(handledActions).toHaveLength(1);
    expect(handledActions[0]).toMatchObject({
      type: "close_position",
      positionId: "pos-1",
      reason: "manual via Telegram",
    });
    expect(recordedTraceActions).toHaveLength(1);
    expect(loggedOperatorActions).toHaveLength(1);
    expect(loggedOperatorActions[0]?.[3]).toMatchObject({
      source: "telegram",
      coin: "ETH",
    });
  });

  it("/confirm executes a pending reduce action", async () => {
    const cmd = findCommand("operator")!;
    await cmd.handler("reduce pos-1 25", CHAT_ID);

    const confirmCmd = findCommand("confirm")!;
    const reply = await confirmCmd.handler("", CHAT_ID);
    expect(reply).toContain("Operator Action Executed");
    expect(handledActions).toHaveLength(1);
    expect(handledActions[0]).toMatchObject({
      type: "partial_close",
      positionId: "pos-1",
      closePct: 0.25,
    });
  });

  it("rejects unsupported reduce size", async () => {
    const cmd = findCommand("operator")!;
    const reply = await cmd.handler("reduce pos-1 10", CHAT_ID);
    expect(reply).toContain("25 or 50");
    expect(handledActions).toHaveLength(0);
  });
});

// ─── /pnl ─────────────────────────────────────────────────────────────────────

describe("/pnl command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns daily/weekly/monthly/all-time PnL and win rates", async () => {
    const cmd = findCommand("pnl")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("PnL Summary");
    expect(reply).toContain("120\\.50"); // daily pnl (escaped)
    expect(reply).toContain("60\\.0"); // daily WR 60% (escaped)
    expect(reply).toContain("450\\.30"); // weekly pnl (escaped)
    expect(reply).toContain("5000\\.00"); // all-time pnl (escaped)
    expect(reply).toContain("5 trades"); // daily trades
    expect(reply).toContain("300 trades"); // all-time trades
    expect(reply).toContain("2\\.50"); // current drawdown (escaped)
    expect(reply).toContain("8\\.30"); // max drawdown (escaped)
  });
});

// ─── /pause ───────────────────────────────────────────────────────────────────

describe("/pause command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    pausedWith = null;
    dispatchedEvents.length = 0;
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("pauses agent with default reason", () => {
    const cmd = findCommand("pause")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("Agent paused");
    expect(reply).toContain("manual via Telegram");
    expect(pausedWith).toBe("manual via Telegram");
  });

  it("pauses agent with custom reason", () => {
    const cmd = findCommand("pause")!;
    const reply = cmd.handler("news event", 0) as string;
    expect(reply).toContain("Agent paused");
    expect(reply).toContain("news event");
    expect(pausedWith).toBe("news event");
  });

  it("pauses single coin with duration", () => {
    const cmd = findCommand("pause")!;
    const reply = cmd.handler("BTC 4h", 0) as string;
    expect(reply).toContain("BTC");
    expect(reply).toContain("4h");
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].coin).toBe("BTC");
    expect(dispatchedEvents[0].event.type).toBe("pause");
  });

  it("falls back to global pause for invalid per-coin args", () => {
    const cmd = findCommand("pause")!;
    const reply = cmd.handler("some reason without coin", 0) as string;
    expect(reply).toContain("Agent paused");
    expect(pausedWith).toBe("some reason without coin");
  });
});

// ─── /resume ──────────────────────────────────────────────────────────────────

describe("/resume command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    resumed = false;
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("resumes agent", () => {
    const cmd = findCommand("resume")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("Agent resumed");
    expect(resumed).toBe(true);
  });
});

// ─── parsePauseCoinArgs ──────────────────────────────────────────────────────

describe("parsePauseCoinArgs", () => {
  it('parses "BTC 4h"', () => {
    const result = parsePauseCoinArgs("BTC 4h");
    expect(result).not.toBeNull();
    expect(result?.coin).toBe("BTC");
    expect(result?.durationMs).toBe(4 * 3_600_000);
    expect(result?.label).toBe("4h");
  });

  it('parses "eth 30m" (case-insensitive coin)', () => {
    const result = parsePauseCoinArgs("eth 30m");
    expect(result).not.toBeNull();
    expect(result?.coin).toBe("ETH");
    expect(result?.durationMs).toBe(30 * 60_000);
  });

  it('parses "SOL 1d"', () => {
    const result = parsePauseCoinArgs("SOL 1d");
    expect(result).not.toBeNull();
    expect(result?.durationMs).toBe(86_400_000);
  });

  it("returns null for empty args", () => {
    expect(parsePauseCoinArgs("")).toBeNull();
  });

  it("returns null for single word", () => {
    expect(parsePauseCoinArgs("BTC")).toBeNull();
  });

  it("returns null for invalid duration format", () => {
    expect(parsePauseCoinArgs("BTC forever")).toBeNull();
    expect(parsePauseCoinArgs("BTC 4x")).toBeNull();
  });

  it("returns null for zero duration", () => {
    expect(parsePauseCoinArgs("BTC 0h")).toBeNull();
  });
});

// ─── /risk ───────────────────────────────────────────────────────────────────

describe("/risk command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns risk dashboard with PnL, positions, CB status", () => {
    const cmd = findCommand("risk")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("Risk Dashboard");
    expect(reply).toContain("42\\.50"); // daily PnL (escaped)
    expect(reply).toContain("Circuit breaker");
    expect(reply).toContain("OK"); // 1 consecutive loss < 3
    expect(reply).toContain("Global paused: NO");
  });

  it("shows per-coin consecutive losses when > 0", () => {
    const cmd = findCommand("risk")!;
    const reply = cmd.handler("", 0) as string;
    expect(reply).toContain("ETH");
    expect(reply).toContain("2 consecutive");
  });
});

// ─── /closeall + /confirm ────────────────────────────────────────────────────

describe("/closeall + /confirm commands", () => {
  const CHAT_ID = 12345;

  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    resetCloseAllState(CHAT_ID);
    closeAllResult = { cancelled: 2, closed: 1 };
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("/closeall requests confirmation", () => {
    const cmd = findCommand("closeall")!;
    const reply = cmd.handler("", CHAT_ID) as string;
    expect(reply).toContain("CLOSE ALL");
    expect(reply).toContain("Confirmation required");
    expect(reply).toContain("/confirm");
    expect(reply).toContain("30s");
  });

  it("/confirm with no pending returns no-op", async () => {
    const cmd = findCommand("confirm")!;
    const reply = await cmd.handler("", CHAT_ID);
    expect(reply).toContain("No pending");
  });

  it("/closeall → /confirm executes close-all", async () => {
    const closeallCmd = findCommand("closeall")!;
    closeallCmd.handler("", CHAT_ID);

    const confirmCmd = findCommand("confirm")!;
    const reply = await confirmCmd.handler("", CHAT_ID);
    expect(reply).toContain("Close\\-all executed");
    expect(reply).toContain("Cancelled orders: 2");
    expect(reply).toContain("Closed positions: 1");
  });

  it("/confirm from different chatId is rejected", async () => {
    const closeallCmd = findCommand("closeall")!;
    closeallCmd.handler("", CHAT_ID);

    const confirmCmd = findCommand("confirm")!;
    const reply = await confirmCmd.handler("", 99999);
    expect(reply).toContain("No pending");
  });

  it("/closeall while already pending shows already-pending message", () => {
    const cmd = findCommand("closeall")!;
    cmd.handler("", CHAT_ID);
    const reply = cmd.handler("", CHAT_ID) as string;
    expect(reply).toContain("already pending");
  });

  it("/closeall is blocked while a remote operator action is pending", async () => {
    const operatorCmd = findCommand("operator")!;
    await operatorCmd.handler("close pos-1", CHAT_ID);

    const closeallCmd = findCommand("closeall")!;
    const reply = closeallCmd.handler("", CHAT_ID) as string;
    expect(reply).toContain("remote operator action is already pending");
  });
});

// ─── /report ─────────────────────────────────────────────────────────────────

describe("/report command", () => {
  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    handledActions.length = 0;
    recordedTraceActions.length = 0;
    loggedOperatorActions.length = 0;
  });

  it("returns daily report with PnL, win rate, drawdown", async () => {
    const cmd = findCommand("report")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("Daily Report");
    expect(reply).toContain("Ops Recap");
    expect(reply).toContain("Bot: 1 open position");
    expect(reply).toContain("1 live case");
    expect(reply).toContain("TRAIL SL 1");
    expect(reply).toContain("Guardian: 1 active case");
    expect(reply).toContain("Operator: 2 recent actions");
    expect(reply).toContain("1 submitted");
    expect(reply).toContain("1 failed");
    expect(reply).toContain("Briefing: healthy");
    expect(reply).toContain("4/7 edited");
    expect(reply).toContain("120\\.50"); // daily pnl
    expect(reply).toContain("450\\.30"); // weekly pnl
    expect(reply).toContain("1200\\.00"); // monthly pnl
    expect(reply).toContain("5000\\.00"); // all-time pnl
    expect(reply).toContain("60\\.0%"); // daily WR
    expect(reply).toContain("5 trades"); // daily trades
    expect(reply).toContain("2\\.50"); // current drawdown
    expect(reply).toContain("8\\.30"); // max drawdown
    expect(reply).toContain("Open positions:* 1");
    expect(reply).toContain("Operator Recent");
    expect(reply).toContain("submitted");
    expect(reply).toContain("Briefing Refresh");
    expect(reply).toContain("7 requested");
    expect(reply).toContain("4 edited");
    expect(reply).toContain("1 skipped");
    expect(reply).toContain("2 coalesced");
    expect(reply).toContain("recovered critical");
    expect(reply).toContain("target BTC / pos\\-1");
    expect(reply).toContain("attention BTC 1h TRAIL\\_SL");
    expect(reply).toContain("incident critical recovered BTC / pos\\-1");
    expect(reply).toContain("degraded active ETH / pos\\-2");
    expect(reply).toContain("history critical\\-\\>healthy BTC / pos\\-1");
    expect(reply).toContain("degraded\\-\\>critical BTC / pos\\-1");
    expect(reply).toContain("healthy\\-\\>degraded BTC / pos\\-1");
    expect(reply).toContain("Live Oversight");
    expect(reply).toContain("BTC 1h");
  });

  it("shows no pattern/coin sections when arrays are empty", async () => {
    const cmd = findCommand("report")!;
    const reply = await cmd.handler("", 0);
    // Default mock has empty arrays
    expect(reply).not.toContain("Top Patterns");
    expect(reply).not.toContain("Top Coins");
  });
});

// ─── /advisor ────────────────────────────────────────────────────────────────

describe("/advisor command", () => {
  let origAdvisorMode: string | undefined;

  beforeEach(() => {
    resetCommands();
    registerBuiltinCommands();
    origAdvisorMode = process.env.ADVISOR_MODE;
    delete process.env.ADVISOR_MODE;
    mockAdvisorSnapshot = defaultMockAdvisorSnapshot();
    mockInsightMemories = [
      {
        content:
          "Bucket ob|long underperforms baseline: winRate 45% vs global 53%",
        createdAt: new Date("2026-06-09T00:00:00Z"),
        metadata: { bucketKey: "ob|long" },
      },
      {
        content:
          "Bucket spring|BULL|long outperforms baseline: winRate 64% vs global 53%",
        createdAt: new Date("2026-06-10T00:00:00Z"),
        metadata: { bucketKey: "spring|BULL|long" },
      },
    ];
  });

  afterEach(() => {
    if (origAdvisorMode === undefined) delete process.env.ADVISOR_MODE;
    else process.env.ADVISOR_MODE = origAdvisorMode;
  });

  it("shows mode, snapshot stats, top buckets and insights", async () => {
    const cmd = findCommand("advisor")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("Advisor");
    expect(reply).toContain("SHADOW"); // default mode
    expect(reply).toContain("32 outcomes");
    expect(reply).toContain("Top Buckets");
    // Sorted by trade count: ob|long (20t) before spring|BULL|long (12t)
    expect(reply.indexOf("ob\\|long")).toBeLessThan(
      reply.indexOf("spring\\|BULL\\|long"),
    );
    expect(reply).toContain("20t WR 45%");
    expect(reply).toContain("12t WR 64%");
    expect(reply).toContain("R 0\\.80");
    expect(reply).toContain("Recent Insights");
    // Insights newest-first
    expect(reply.indexOf("outperforms")).toBeLessThan(
      reply.indexOf("underperforms"),
    );
  });

  it("reflects ADVISOR_MODE env override", async () => {
    process.env.ADVISOR_MODE = "active";
    const cmd = findCommand("advisor")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("ACTIVE");
  });

  it("handles missing snapshot and no insights", async () => {
    mockAdvisorSnapshot = null;
    mockInsightMemories = [];
    const cmd = findCommand("advisor")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("not built yet");
    expect(reply).toContain("No insights yet");
    expect(reply).not.toContain("Top Buckets");
  });

  it("shows empty-bucket state when snapshot has no buckets", async () => {
    mockAdvisorSnapshot = {
      buckets: new Map(),
      global: null,
      builtAt: Date.now(),
      sampleSize: 0,
    };
    mockInsightMemories = [];
    const cmd = findCommand("advisor")!;
    const reply = await cmd.handler("", 0);
    expect(reply).toContain("0 outcomes");
    expect(reply).toContain("No bucket stats yet");
  });
});
