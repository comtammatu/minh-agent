-- 003_analytics_views.sql
-- Sprint 3 S5: Analytics materialized views + indexes for metrics engine.
-- Regular matviews (not continuous aggregates) — positions is NOT a hypertable.
-- Refresh via MetricsRepo.refreshViews() on trade close + periodic fallback.

-- ============================================================
-- Indexes: speed up metrics queries on positions + trade_journal
-- ============================================================

-- Positions: filter closed trades by time range
CREATE INDEX IF NOT EXISTS idx_positions_closed_at
  ON positions (closed_at DESC)
  WHERE status = 'closed' AND closed_at IS NOT NULL;

-- Positions: filter by coin + status
CREATE INDEX IF NOT EXISTS idx_positions_coin_status
  ON positions (coin, status);

-- Trade Journal: filter by event_type (enter/exit/signal)
CREATE INDEX IF NOT EXISTS idx_journal_event_type
  ON trade_journal (event_type, ts DESC);

-- ============================================================
-- daily_performance: daily PnL summary per coin
-- Refresh: after each trade close + hourly fallback
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_performance AS
SELECT
  date_trunc('day', closed_at) AS day,
  coin,
  COUNT(*)                                  AS trades,
  COUNT(*) FILTER (WHERE realized_pnl > 0)  AS wins,
  COUNT(*) FILTER (WHERE realized_pnl <= 0) AS losses,
  SUM(realized_pnl)                         AS total_pnl,
  AVG(realized_pnl)                         AS avg_pnl,
  MAX(realized_pnl)                         AS best_trade,
  MIN(realized_pnl)                         AS worst_trade
FROM positions
WHERE status = 'closed' AND closed_at IS NOT NULL
GROUP BY day, coin
WITH NO DATA;

-- Index on day for dashboard time-range queries
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_perf_day_coin
  ON daily_performance (day, coin);

-- ============================================================
-- pattern_performance: per-pattern-type + grade weekly summary
-- JOIN positions × trade_journal for pattern attribution.
-- Refresh: after each trade close + hourly fallback
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS pattern_performance AS
SELECT
  date_trunc('week', p.closed_at)           AS week,
  j.details->>'pattern_type'                AS pattern_type,
  j.details->>'signal_grade'                AS signal_grade,
  COUNT(*)                                  AS trades,
  COUNT(*) FILTER (WHERE p.realized_pnl > 0) AS wins,
  SUM(p.realized_pnl)                       AS total_pnl,
  AVG(p.realized_pnl)                       AS avg_pnl
FROM trade_journal j
INNER JOIN positions p
  ON p.id::text = j.details->>'position_id'
WHERE j.event_type = 'enter'
  AND p.status = 'closed'
  AND p.closed_at IS NOT NULL
GROUP BY week, pattern_type, signal_grade
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_perf_week_type_grade
  ON pattern_performance (week, pattern_type, signal_grade);
