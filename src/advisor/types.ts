/**
 * Advisor types (stub per optional advisor-foundation in arch+ai plan).
 * Advisor is NEVER executor. Suggestions go through backtest gate + human approve (Telegram/dashboard).
 */
import type { CandleInterval, MarketRegime, SignalSide } from "../types.js";

export interface AdvisorSuggestion {
  type:
    | "config_change"
    | "anomaly_explain"
    | "daily_review"
    | "pattern_insight";
  key?: string; // e.g. "MIN_CONFIDENCE"
  value?: unknown;
  reason: string;
  confidence: number; // 0-1, LLM self
  backtestRequired: boolean;
}

export interface AdvisorTradeContext {
  coin?: string;
  interval?: CandleInterval;
  side?: SignalSide;
  pnlR?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface AdvisorContext {
  recentMemories: import("../memory/types.js").ScoredMemory[];
  recentTrades: AdvisorTradeContext[];
  regime: MarketRegime;
  coin: string;
  interval: CandleInterval;
}
