-- 004_order_indexes.sql
-- Index for active-order queries: getActiveOrdersForCoin() in order-manager.ts
-- Covers WHERE coin = ? AND status IN ('pending', 'submitted', 'partial')

CREATE INDEX IF NOT EXISTS idx_orders_coin_status_active
  ON orders (coin, status, created_at DESC)
  WHERE status IN ('pending', 'submitted', 'partial');
