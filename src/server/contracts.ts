import type { JournalEntry } from "../agent/types.js";
import type { LiveMetrics } from "../analytics/types.js";
import type { StatusSnapshot } from "../strategy/index.js";
import type { ActiveSetup, CandleInterval, ExchangeId } from "../types.js";
import type { LiveWalletStats } from "../ui/live-account-stats.js";
import type { TuiDataSources } from "../ui/tui.jsx";

export type DashboardBootstrapPhase = "warming_up" | "ready";

export interface DashboardServerState {
  activeExchange: ExchangeId;
  getBootstrapPhase: () => DashboardBootstrapPhase;
  sources: TuiDataSources;
}

export interface DashboardMode {
  exchange: ExchangeId;
  paperTrade: boolean;
}

export interface DashboardAccountSnapshot {
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
}

export interface DashboardPositionRow {
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
}

export interface DashboardWatchlistRow {
  coin: string;
  interval: CandleInterval;
  regime: StatusSnapshot["regime"];
  bias: string;
  biasConfidence: number;
  confluenceGrade: StatusSnapshot["confluenceGrade"];
  activeCount: number;
  lastUpdateAt: number;
  markPrice: number | null;
  funding: number | null;
  dayChangePctUtc: number | null;
}

export interface DashboardActiveSetupRow {
  id: string;
  coin: string;
  interval: CandleInterval;
  side: ActiveSetup["side"];
  confidence: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  detectedAt: number;
}

export interface DashboardJournalRow {
  id: number;
  ts: string;
  eventType: JournalEntry["eventType"];
  coin: string | null;
  details: Record<string, unknown>;
  agentState: string | null;
  exchange: ExchangeId;
}

export interface DashboardOperatorSummary {
  globalPaused: boolean;
  pauseReason: string | null;
}

export interface DashboardSnapshotResponse {
  bootstrap: {
    phase: DashboardBootstrapPhase;
    trackedCoins: string[];
  };
  mode: DashboardMode;
  operator: DashboardOperatorSummary;
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
  account: DashboardAccountSnapshot;
  positions: DashboardPositionRow[];
  watchlist: DashboardWatchlistRow[];
  activeSetups: DashboardActiveSetupRow[];
  summaryMetrics: LiveMetrics;
  recentJournal: DashboardJournalRow[];
}

export interface DashboardAccountSources {
  liveWalletStats: () => LiveWalletStats | null;
}
