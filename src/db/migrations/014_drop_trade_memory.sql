-- 014_drop_trade_memory.sql
-- Greenfield: trade outcomes live in trade_journal; remove trade_memory store.

DROP TABLE IF EXISTS trade_memory;
