/**
 * Advisor stats cache — reads closed-trade exits from trade_journal.
 */
import { ADVISOR } from "../config.js";
import { sql } from "../db/connection.js";
import { log } from "../lib/logger.js";
import type { CandleInterval, MarketRegime, SignalSide } from "../types.js";
import { aggregateOutcomes } from "./stats.js";
import type { AdvisorSnapshot, OutcomeRow } from "./types.js";

interface OutcomeQueryRow {
  pattern: string | null;
  regime: string | null;
  side: string | null;
  timeframe: string | null;
  pnl_r: number | null;
  pnl: number | null;
}

export class AdvisorStatsCache {
  private snapshot: AdvisorSnapshot | null = null;
  private refreshing = false;

  getSnapshot(): AdvisorSnapshot | null {
    return this.snapshot;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const rows = await sql<OutcomeQueryRow[]>`
        SELECT
          details->>'pattern_type' AS pattern,
          details->>'regime' AS regime,
          details->>'side' AS side,
          details->>'interval' AS timeframe,
          (details->>'pnlR')::double precision AS pnl_r,
          (details->>'pnl')::double precision AS pnl
        FROM trade_journal
        WHERE event_type = 'exit'
          AND details->>'pattern_type' IS NOT NULL
          AND details->>'side' IS NOT NULL
          AND ts >= NOW() - INTERVAL '1 day' * ${ADVISOR.statsWindowDays}
      `;

      const outcomes: OutcomeRow[] = rows
        .filter((r): r is OutcomeQueryRow & { pattern: string; side: string } =>
          Boolean(r.pattern && r.side),
        )
        .map((r) => ({
          pattern: r.pattern,
          regime: (r.regime as MarketRegime | null) ?? null,
          side: r.side as SignalSide,
          timeframe: (r.timeframe as CandleInterval | null) ?? null,
          pnlR: r.pnl_r,
          pnl: r.pnl,
        }));

      this.snapshot = aggregateOutcomes(outcomes, Date.now());
      log.info(
        "advisor",
        `Stats refreshed: ${this.snapshot.sampleSize} outcomes → ${this.snapshot.buckets.size} buckets`,
      );
    } catch (err) {
      log.error(
        "advisor",
        `Stats refresh failed (keeping previous snapshot): ${(err as Error).message}`,
      );
    } finally {
      this.refreshing = false;
    }
  }
}

let cacheInstance: AdvisorStatsCache | null = null;

export function getAdvisorCache(): AdvisorStatsCache {
  if (!cacheInstance) {
    cacheInstance = new AdvisorStatsCache();
  }
  return cacheInstance;
}

export function resetAdvisorCache(): void {
  cacheInstance = null;
}
