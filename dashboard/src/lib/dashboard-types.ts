export type DashboardBootstrapPhase = "warming_up" | "ready";
export type DashboardEventType =
  | "signal"
  | "enter"
  | "exit"
  | "skip"
  | "invalidate"
  | "circuit_break"
  | "pause"
  | "resume"
  | "error"
  | "operator";

export interface DashboardSnapshotResponse {
  bootstrap: {
    phase: DashboardBootstrapPhase;
    trackedCoins: string[];
  };
  mode: {
    exchange: "HL" | "BB";
    paperTrade: boolean;
  };
  operator: {
    globalPaused: boolean;
    pauseReason: string | null;
  };
  health: {
    overall: string;
    uptime: number;
    rssBytes: number;
    components: {
      feed: { status: string; consecutiveErrors: number };
      db: { status: string; consecutiveErrors: number };
      exchange: { status: string; consecutiveErrors: number };
    };
  };
  account: {
    source: "paper" | "live";
    balance: number | null;
    equity: number | null;
    available: number | null;
    marginUsed: number | null;
    withdrawable: number | null;
    spotUsdcBalance: number | null;
    unrealizedPnl: number;
    wins: number;
    losses: number;
    tradeCount: number;
    winRate: number;
  };
  positions: Array<{
    positionId: string;
    coin: string;
    side: "long" | "short";
    leverage: number;
    entryPrice: number;
    currentSize: number;
    slPrice: number;
    tpPrice: number;
    exchangeOnly: boolean;
    markPrice: number | null;
    unrealizedPnl: number | null;
  }>;
  watchlist: Array<{
    coin: string;
    interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    regime: string;
    bias: string;
    biasConfidence: number;
    confluenceGrade: string | null;
    activeCount: number;
    lastUpdateAt: number;
    markPrice: number | null;
    funding: number | null;
    dayChangePctUtc: number | null;
  }>;
  activeSetups: Array<{
    id: string;
    coin: string;
    interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    side: "long" | "short";
    confidence: number;
    entryPrice: number;
    slPrice: number;
    tpPrice: number;
    detectedAt: number;
  }>;
  summaryMetrics: {
    winRate: Record<"daily" | "weekly" | "monthly" | "allTime", number>;
    pnl: Record<"daily" | "weekly" | "monthly" | "allTime", number>;
    trades: Record<"daily" | "weekly" | "monthly" | "allTime", number>;
    currentDrawdown: number;
    maxDrawdown: number;
    openPositionCount: number;
  };
  recentJournal: DashboardJournalRow[];
}

export interface DashboardJournalRow {
  id: number;
  ts: string;
  eventType: DashboardEventType;
  coin: string | null;
  details: Record<string, unknown>;
  agentState: string | null;
  exchange: "HL" | "BB";
}
