-- 009_orders_exchange_column.sql
-- Add exchange column to orders and positions tables.
-- Allows filtering/restoring positions by exchange origin (HL vs BB).
-- Without this, restoreOpenPositions() cannot distinguish HL vs BB filled orders
-- when both exchanges have the same coin names (BTC, ETH, etc.).
-- Default 'HL' for existing rows (backward compatible).

-- ============================================================
-- Extend orders: exchange column
-- ============================================================
DO $$ BEGIN
  ALTER TABLE orders
    ADD COLUMN exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_exchange ON orders (exchange);

-- ============================================================
-- Extend positions: exchange column
-- ============================================================
DO $$ BEGIN
  ALTER TABLE positions
    ADD COLUMN exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_positions_exchange ON positions (exchange);
