/**
 * Analytics type definitions — live metrics, per-pattern/coin breakdowns.
 * Pure data types, no I/O.
 */

// ─── Closed Trade Row (from DB) ─────────────────────────────────────────────

/** Minimal closed position data needed for live metrics. */
export interface ClosedTradeRow {
  coin: string;
  side: "long" | "short";
  realizedPnl: number;
  closedAt: Date;
}

// ─── Daily Performance Row (from matview) ────────────────────────────────────

export interface DailyPerfRow {
  day: Date;
  coin: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
}

// ─── Pattern Performance Row (from matview) ──────────────────────────────────

export interface PatternPerfRow {
  week: Date;
  patternType: string;
  signalGrade: string;
  trades: number;
  wins: number;
  totalPnl: number;
  avgPnl: number;
}

// ─── Live Metrics (computed) ─────────────────────────────────────────────────

export interface LiveMetrics {
  /** Summary stats by time window. */
  winRate: { daily: number; weekly: number; monthly: number; allTime: number };
  pnl: { daily: number; weekly: number; monthly: number; allTime: number };
  trades: { daily: number; weekly: number; monthly: number; allTime: number };

  /** Per-pattern performance. */
  patternMetrics: PatternMetric[];

  /** Per-coin performance. */
  coinMetrics: CoinMetric[];

  /** Drawdown tracking. */
  currentDrawdown: number;
  maxDrawdown: number;

  /** Exposure. */
  openPositionCount: number;
}

export interface PatternMetric {
  patternType: string;
  signalGrade: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

export interface CoinMetric {
  coin: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}
