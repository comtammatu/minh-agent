-- 005_strategies.sql
-- Sprint 4.5 S3: Multi-strategy support + schema debt fix (E29)
-- New: strategies table, strategy_id on orders/positions/trade_journal
-- Fix: cloid + fill_size columns on orders (previously missing)

-- ============================================================
-- Strategies: registered strategy definitions
-- ============================================================
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}',
  wallet_address TEXT,
  capital_allocation DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Seed default strategy (so existing data references are valid)
-- ============================================================
INSERT INTO strategies (id, name, enabled, config, capital_allocation)
VALUES ('layered', 'Layered (5-layer Wyckoff)', TRUE, '{}', 1.0)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Extend orders: strategy_id + schema debt fix (E29)
-- ============================================================
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN strategy_id TEXT DEFAULT 'layered';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN cloid TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN fill_size DOUBLE PRECISION;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ============================================================
-- Extend positions: strategy_id
-- ============================================================
DO $$ BEGIN
  ALTER TABLE positions ADD COLUMN strategy_id TEXT DEFAULT 'layered';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ============================================================
-- Extend trade_journal: strategy_id (no default — legacy entries skip)
-- ============================================================
DO $$ BEGIN
  ALTER TABLE trade_journal ADD COLUMN strategy_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders (strategy_id);
CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions (strategy_id);
