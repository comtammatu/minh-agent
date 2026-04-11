-- 010: Optimization trials table for parameter optimizer results.
-- Evolution Phase 1 Days 4-5.

CREATE TABLE IF NOT EXISTS optimization_trials (
  id            SERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,              -- UUID grouping all trials in one optimizer run
  trial_index   INTEGER NOT NULL,           -- 0-based trial number within the run
  params        JSONB NOT NULL,             -- StrategyParams used for this trial
  coins         TEXT[] NOT NULL,            -- coins included in this trial
  num_windows   INTEGER NOT NULL DEFAULT 0, -- walk-forward windows
  oos_pf        DOUBLE PRECISION,           -- out-of-sample profit factor
  oos_expectancy DOUBLE PRECISION,          -- out-of-sample expectancy ($)
  max_dd        DOUBLE PRECISION,           -- max drawdown (0-1 fraction)
  win_rate      DOUBLE PRECISION,           -- win rate (0-1)
  trade_count   INTEGER NOT NULL DEFAULT 0, -- total OOS trades
  holdout_pf    DOUBLE PRECISION,           -- holdout validation profit factor
  holdout_max_dd DOUBLE PRECISION,          -- holdout validation max drawdown
  holdout_trades INTEGER,                   -- holdout trade count
  error         TEXT,                       -- error message if trial failed
  duration_ms   INTEGER,                    -- wall-clock time for this trial (ms)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_optimization_trials_run_id ON optimization_trials(run_id);
CREATE INDEX IF NOT EXISTS idx_optimization_trials_oos_pf ON optimization_trials(oos_pf DESC NULLS LAST);
