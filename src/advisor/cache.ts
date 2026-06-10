/**
 * Advisor stats cache — I/O edge for the learning loop.
 *
 * Loads trade_outcome rows from trade_memory, aggregates them into an
 * immutable AdvisorSnapshot, and serves it synchronously to the entry path.
 * Refresh failures keep the previous snapshot (fail-open: a stale snapshot
 * eventually stops driving vetoes via isSnapshotFresh).
 */

import { ADVISOR } from "../config.js";
import { sql } from "../db/connection.js";
import { log } from "../lib/logger.js";
import type { CandleInterval, MarketRegime, SignalSide } from "../types.js";
import { aggregateOutcomes } from "./stats.js";
import type { AdvisorSnapshot, OutcomeRow } from "./types.js";

interface OutcomeQueryRow {
  pattern: string;
  regime: string | null;
  side: string;
  timeframe: string | null;
  pnl_r: number | null;
  pnl: number | null;
}

export class AdvisorStatsCache {
  private snapshot: AdvisorSnapshot | null = null;
  private refreshing = false;

  /** Current snapshot — synchronous, may be null before first refresh. */
  getSnapshot(): AdvisorSnapshot | null {
    return this.snapshot;
  }

  /**
   * Rebuild the snapshot from trade_memory. Never throws; on failure the
   * previous snapshot is kept. Concurrent calls collapse into one refresh.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const rows = await sql<OutcomeQueryRow[]>`
        SELECT
          pattern,
          regime,
          side,
          timeframe,
          pnl_r,
          (metadata->>'pnl')::double precision AS pnl
        FROM trade_memory
        WHERE category = 'trade_outcome'
          AND pattern IS NOT NULL
          AND side IS NOT NULL
          AND created_at >= NOW() - INTERVAL '1 day' * ${ADVISOR.statsWindowDays}
      `;

      const outcomes: OutcomeRow[] = rows.map((r) => ({
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

// ─── Singleton ───────────────────────────────────────────────────────────────

let cacheInstance: AdvisorStatsCache | null = null;

/** Get or create the singleton advisor stats cache. */
export function getAdvisorCache(): AdvisorStatsCache {
  if (!cacheInstance) {
    cacheInstance = new AdvisorStatsCache();
  }
  return cacheInstance;
}

/** Reset the cache (tests only). */
export function resetAdvisorCache(): void {
  cacheInstance = null;
}
