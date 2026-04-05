-- Add position_id to orders table for reliable order-to-position lookup.
-- Previously, findOrderByPositionContext returned the first filled order
-- regardless of position, which could close/modify the wrong position.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS position_id TEXT;

-- Index for fast lookups by position_id
CREATE INDEX IF NOT EXISTS idx_orders_position_id ON orders (position_id) WHERE position_id IS NOT NULL;
