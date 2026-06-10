-- 013_journal_analytics.sql
-- Analytics matviews re-sourced from trade_journal exit rows.
--
-- The positions table never had a writer (verified 2026-06-11): every matview
-- and closed-trade query built on it returned empty data, and the old
-- pattern_performance JOIN used JSON keys the agent never wrote
-- (position_id/pattern_type/signal_grade vs positionId/pattern/grade).
--
-- Post advisor + EXITING-stranding fixes, every real position close produces
-- exactly ONE trade_journal exit row carrying pnl (estimate-tagged), side,
-- pattern, grade, setupId. That row is the canonical closed-trade record.
--
-- Row convention (matches the advisor's isWin signal-less rule):
--   pnl IS NULL  → audit-only exit row (safety net, crash recovery) — excluded
--   pnl = 0      → signal-less (legacy pre-estimate rows, estimate-fallback
--                  closes) — excluded from trade metrics
--
-- COALESCE keys to 'unknown' so the unique indexes required by
-- REFRESH MATERIALIZED VIEW CONCURRENTLY never contain NULLs.

-- ============================================================
-- daily_performance: daily PnL summary per coin (journal-derived)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS daily_performance;

CREATE MATERIALIZED VIEW daily_performance AS
SELECT
  date_trunc('day', ts)                     AS day,
  coin,
  COUNT(*)                                  AS trades,
  COUNT(*) FILTER (WHERE (details->>'pnl')::double precision > 0)  AS wins,
  COUNT(*) FILTER (WHERE (details->>'pnl')::double precision <= 0) AS losses,
  SUM((details->>'pnl')::double precision)  AS total_pnl,
  AVG((details->>'pnl')::double precision)  AS avg_pnl,
  MAX((details->>'pnl')::double precision)  AS best_trade,
  MIN((details->>'pnl')::double precision)  AS worst_trade
FROM trade_journal
WHERE event_type = 'exit'
  AND coin IS NOT NULL
  AND details->>'pnl' IS NOT NULL
  AND (details->>'pnl')::double precision != 0
GROUP BY day, coin
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_perf_day_coin
  ON daily_performance (day, coin);

-- ============================================================
-- pattern_performance: per-pattern + grade weekly summary (journal-derived)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS pattern_performance;

CREATE MATERIALIZED VIEW pattern_performance AS
SELECT
  date_trunc('week', ts)                    AS week,
  COALESCE(details->>'pattern', 'unknown')  AS pattern_type,
  COALESCE(details->>'grade', 'unknown')    AS signal_grade,
  COUNT(*)                                  AS trades,
  COUNT(*) FILTER (WHERE (details->>'pnl')::double precision > 0) AS wins,
  SUM((details->>'pnl')::double precision)  AS total_pnl,
  AVG((details->>'pnl')::double precision)  AS avg_pnl
FROM trade_journal
WHERE event_type = 'exit'
  AND details->>'pnl' IS NOT NULL
  AND (details->>'pnl')::double precision != 0
GROUP BY week, pattern_type, signal_grade
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_perf_week_type_grade
  ON pattern_performance (week, pattern_type, signal_grade);

-- ============================================================
-- pnl_hourly: hourly PnL summary per coin (journal-derived)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS pnl_hourly;

CREATE MATERIALIZED VIEW pnl_hourly AS
SELECT
  date_trunc('hour', ts)                    AS bucket,
  coin,
  COUNT(*)                                  AS trades,
  SUM((details->>'pnl')::double precision)  AS total_pnl,
  AVG((details->>'pnl')::double precision)  AS avg_pnl
FROM trade_journal
WHERE event_type = 'exit'
  AND coin IS NOT NULL
  AND details->>'pnl' IS NOT NULL
  AND (details->>'pnl')::double precision != 0
GROUP BY bucket, coin
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_hourly_bucket_coin
  ON pnl_hourly (bucket, coin);

-- Index for closed-trade queries straight off the journal
CREATE INDEX IF NOT EXISTS idx_journal_exit_pnl
  ON trade_journal (ts ASC)
  WHERE event_type = 'exit' AND (details->>'pnl') IS NOT NULL;
