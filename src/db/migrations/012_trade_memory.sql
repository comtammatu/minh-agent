-- Trade memory: structured storage for advisor context
-- Sprint 6 Session 1: plain PG, no pgvector, no embeddings

CREATE TABLE trade_memory (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,          -- trade_outcome | pattern_insight | strategy_insight | error_lesson | regime_transition
  coin TEXT,
  timeframe TEXT,
  pattern TEXT,
  regime TEXT,
  side TEXT,
  pnl_r REAL,
  confidence REAL,
  content TEXT NOT NULL,           -- human-readable summary
  metadata JSONB NOT NULL DEFAULT '{}',
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vec TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', content)
  ) STORED
);

-- Structured lookups (the primary retrieval path for trading data)
CREATE INDEX idx_tmem_category ON trade_memory (category);
CREATE INDEX idx_tmem_coin ON trade_memory (coin);
CREATE INDEX idx_tmem_coin_pattern ON trade_memory (coin, pattern);
CREATE INDEX idx_tmem_regime_side ON trade_memory (regime, side);
CREATE INDEX idx_tmem_created ON trade_memory (created_at DESC);

-- Full-text search for free-form queries
CREATE INDEX idx_tmem_fts ON trade_memory USING GIN (search_vec);
