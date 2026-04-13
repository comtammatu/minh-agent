-- 011_orders_cloid_recovery.sql
-- Patch 3 (Bybit): persist cloid/orderLinkId separately from exchange_order_id
-- and add recovery index for fill lookup paths.

-- Ensure cloid column exists on older databases that skipped 005.
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN cloid TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Legacy backfill for HL only:
-- historical HL rows may have stored cloid-like values in exchange_order_id.
-- Never copy Bybit orderId UUIDs into cloid.
UPDATE orders
SET cloid = exchange_order_id
WHERE (cloid IS NULL OR cloid = '')
  AND exchange = 'HL'
  AND exchange_order_id ~ '^0x[0-9a-fA-F]{32}$';

-- Speed up recovery lookups by exchange + coin + cloid.
CREATE INDEX IF NOT EXISTS idx_orders_exchange_coin_cloid
  ON orders (exchange, coin, cloid)
  WHERE cloid IS NOT NULL AND cloid <> '';
