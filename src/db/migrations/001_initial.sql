-- 001_initial.sql
-- Sprint 2 S1: Core schema for agent trading
-- Tables: candles (hypertable), orders, positions, trade_journal (hypertable)
-- Continuous aggregate: pnl_hourly

-- ============================================================
-- Candles: TimescaleDB hypertable for time-series candle data
-- ============================================================
CREATE TABLE IF NOT EXISTS candles (
  coin TEXT NOT NULL,
  interval TEXT NOT NULL,
  t TIMESTAMPTZ NOT NULL,
  o DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  l DOUBLE PRECISION NOT NULL,
  c DOUBLE PRECISION NOT NULL,
  v DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (coin, interval, t)
);

SELECT create_hypertable('candles', 't', if_not_exists => TRUE);

-- Compression: ~90% reduction after 7 days
ALTER TABLE candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'coin,interval'
);
SELECT add_compression_policy('candles', INTERVAL '7 days', if_not_exists => TRUE);

-- Retention: drop data older than 1 year
SELECT add_retention_policy('candles', INTERVAL '1 year', if_not_exists => TRUE);

-- ============================================================
-- Orders: ACID transactional order tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  type TEXT NOT NULL CHECK (type IN ('limit', 'market')),
  price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'filled', 'partial', 'cancelled', 'rejected')),
  setup_id TEXT,
  sl_price DOUBLE PRECISION,
  tp_price DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  filled_at TIMESTAMPTZ,
  fill_price DOUBLE PRECISION,
  fill_size DOUBLE PRECISION,
  exchange_order_id TEXT,
  cloid TEXT,
  position_id TEXT,
  exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'))
);

-- ============================================================
-- Positions: current open/closed position state
-- ============================================================
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  sl_price DOUBLE PRECISION,
  tp_price DOUBLE PRECISION,
  unrealized_pnl DOUBLE PRECISION DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'closed')),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_price DOUBLE PRECISION,
  realized_pnl DOUBLE PRECISION,
  exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'))
);

-- ============================================================
-- Trade Journal: audit trail for every agent decision
-- ============================================================
CREATE TABLE IF NOT EXISTS trade_journal (
  id BIGSERIAL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  coin TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  agent_state TEXT,
  exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'))
);

SELECT create_hypertable('trade_journal', 'ts', if_not_exists => TRUE);

-- ============================================================
-- Migration tracking table
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Materialized view: hourly PnL summary
-- (Regular matview — positions is not a hypertable, so continuous aggregate not possible.
--  Refresh manually or via cron: REFRESH MATERIALIZED VIEW pnl_hourly;)
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS pnl_hourly AS
SELECT
  date_trunc('hour', closed_at) AS bucket,
  coin,
  COUNT(*) AS trades,
  SUM(realized_pnl) AS total_pnl,
  AVG(realized_pnl) AS avg_pnl
FROM positions
WHERE status = 'closed' AND closed_at IS NOT NULL
GROUP BY bucket, coin
WITH NO DATA;
