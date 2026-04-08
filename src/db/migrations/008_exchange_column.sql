-- 008_exchange_column.sql
-- Add exchange column to trade_journal so records can be filtered by exchange origin.
-- Defaults to 'HL' (Hyperliquid) for all existing rows.

-- ============================================================
-- Extend trade_journal: exchange column
-- ============================================================
DO $$ BEGIN
  ALTER TABLE trade_journal
    ADD COLUMN exchange TEXT NOT NULL DEFAULT 'HL'
    CHECK (exchange IN ('HL', 'BB'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Index for filtering by exchange
CREATE INDEX IF NOT EXISTS trade_journal_exchange_idx ON trade_journal (exchange);
