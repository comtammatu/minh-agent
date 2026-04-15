-- 005_strategies.sql
-- Canonical single-strategy cleanup.
-- Removes legacy multi-strategy artifacts from older databases while keeping
-- fresh bootstraps on the current branch idempotent.

DROP TABLE IF EXISTS strategies;

DROP INDEX IF EXISTS idx_orders_strategy;
DROP INDEX IF EXISTS idx_positions_strategy;

ALTER TABLE orders DROP COLUMN IF EXISTS strategy_id;
ALTER TABLE positions DROP COLUMN IF EXISTS strategy_id;
ALTER TABLE trade_journal DROP COLUMN IF EXISTS strategy_id;
