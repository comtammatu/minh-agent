-- 002_backtest_results.sql
-- Sprint 3 S3: Backtest results storage — runs, trades, equity curves
-- Tables: backtest_runs, backtest_trades, backtest_equity (hypertable)

-- ============================================================
-- Backtest Runs: metadata + config snapshot + summary metrics
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,                          -- human label: "baseline_v1", "confluence_min_4"
  config JSONB NOT NULL,              -- full BacktestConfig snapshot
  metrics JSONB NOT NULL,             -- full BacktestMetrics snapshot
  total_trades INT NOT NULL DEFAULT 0,
  net_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  win_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_drawdown DOUBLE PRECISION NOT NULL DEFAULT 0,
  sharpe_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  expectancy DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Backtest Trades: individual trade records per run
-- NOT a hypertable — queried by run_id, not by time range
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_trades (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  coin TEXT NOT NULL,
  interval TEXT NOT NULL,
  side TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  confluence_grade TEXT,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION NOT NULL,
  sl_price DOUBLE PRECISION NOT NULL,
  tp_price DOUBLE PRECISION NOT NULL,
  size_usd DOUBLE PRECISION NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ NOT NULL,
  holding_bars INT NOT NULL,
  pnl DOUBLE PRECISION NOT NULL,
  pnl_pct DOUBLE PRECISION NOT NULL,
  exit_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_run_id
  ON backtest_trades(run_id);

-- ============================================================
-- Backtest Equity: time-series equity curve per run
-- Hypertable on ts — efficient range queries for charting
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_equity (
  run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  equity DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (run_id, ts)
);

SELECT create_hypertable('backtest_equity', 'ts', if_not_exists => TRUE);
