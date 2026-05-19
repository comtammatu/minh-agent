# 02 — Database Schema

PostgreSQL + TimescaleDB. Schema is owned by migrations under [src/db/migrations/](../../src/db/migrations/). This document is the **canonical reference** for tables, column types, indexes, materialized views, and JSONB contracts. Update this file in the same PR as any migration.

---

## Conventions

- **Naming**: `snake_case` for tables and columns. Plural table names (`orders`, `positions`).
- **Primary keys**:
  - UUID (`gen_random_uuid()`) for entities with no natural key (orders, positions, backtest_runs).
  - Composite `(coin, interval, t)` for `candles` (timestamp-keyed hot data).
  - `BIGSERIAL` or `SERIAL` for append-only logs (trade_journal, optimization_trials, trade_memory).
- **Timestamps**: always `TIMESTAMPTZ`. Never `TIMESTAMP` (no timezone). Default `NOW()`.
- **Booleans not used.** Use `TEXT` with `CHECK` constraint for state enums (`'open' | 'closing' | 'closed'`).
- **Money / prices**: `DOUBLE PRECISION`. No `NUMERIC` — performance over financial precision is acceptable because exchange-reported values are also floats.
- **Indexes**: `idx_<table>_<columns>` naming. Filtered indexes preferred over full when status filter is common.
- **Hypertables**: time-keyed tables get `create_hypertable('table', 'ts_col', if_not_exists => TRUE)`. Default chunk interval. Compression after 7 days, retention after 1 year (candles only).

---

## Table inventory

| Table | Type | Primary key | Hypertable? | Notes |
|---|---|---|---|---|
| `candles` | hot OHLCV | `(coin, interval, t)` | ✅ on `t` | Compressed @ 7d, retained 1y |
| `orders` | execution audit | UUID | ❌ | Active-order lookup via `idx_orders_coin_status_active` |
| `positions` | open/closed state | UUID | ❌ | Source for `daily_performance` matview |
| `trade_journal` | event log | `BIGSERIAL` | ✅ on `ts` | JSONB `details` |
| `backtest_runs` | run header | UUID | ❌ | JSONB `config` + `metrics` |
| `backtest_trades` | per-run trades | `BIGSERIAL` | ❌ | FK → `backtest_runs.id` cascade |
| `backtest_equity` | equity curve | `(run_id, ts)` | ✅ on `ts` | FK cascade |
| `optimization_trials` | optimizer results | `SERIAL` | ❌ | JSONB `params`, TEXT[] `coins` |
| `trade_memory` | structured memory | `SERIAL` | ❌ | TSVECTOR `search_vec` with GIN index |
| `schema_migrations` | migration ledger | `version TEXT` | ❌ | Set by `src/db/migrate.ts` |

### Materialized views

| View | Source | Refresh | Unique index |
|---|---|---|---|
| `pnl_hourly` | `positions` closed by hour+coin | manual / cron | none |
| `daily_performance` | `positions` closed by day+coin | `MetricsRepo.refreshViews()` on trade close + hourly fallback | `(day, coin)` |
| `pattern_performance` | `trade_journal` JOIN `positions` via `details->>'position_id'` | same | `(week, pattern_type, signal_grade)` |

All three matviews are **regular** (not continuous aggregates) because `positions` is not a hypertable. `REFRESH MATERIALIZED VIEW CONCURRENTLY` is available after the first non-concurrent refresh (handled by migration `007`).

---

## Schema detail

### `candles` (migration 001)

```sql
CREATE TABLE candles (
  coin     TEXT NOT NULL,
  interval TEXT NOT NULL,
  t        TIMESTAMPTZ NOT NULL,
  o        DOUBLE PRECISION NOT NULL,
  h        DOUBLE PRECISION NOT NULL,
  l        DOUBLE PRECISION NOT NULL,
  c        DOUBLE PRECISION NOT NULL,
  v        DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (coin, interval, t)
);

SELECT create_hypertable('candles', 't', if_not_exists => TRUE);
ALTER TABLE candles SET (timescaledb.compress, timescaledb.compress_segmentby = 'coin,interval');
SELECT add_compression_policy('candles', INTERVAL '7 days');
SELECT add_retention_policy('candles', INTERVAL '1 year');
```

Notes:
- `interval` is the timeframe label (`'1m' | '5m' | '15m' | '1h' | '4h' | '1d'`).
- `t` is the candle **open** timestamp.
- Hot window (≤ 7 days) is uncompressed for fast read. Older chunks compressed ~10× by Timescale.
- Upserts on `(coin, interval, t)` — the WS may resend the same timestamp as REST bootstrap.

### `orders` (migrations 001, 005, 006, 009, 011)

```sql
CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin              TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('long', 'short')),
  type              TEXT NOT NULL CHECK (type IN ('limit', 'market')),
  price             DOUBLE PRECISION NOT NULL,
  size              DOUBLE PRECISION NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','submitted','filled','partial','cancelled','rejected')),
  setup_id          TEXT,
  sl_price          DOUBLE PRECISION,
  tp_price          DOUBLE PRECISION,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  filled_at         TIMESTAMPTZ,
  fill_price        DOUBLE PRECISION,
  fill_size         DOUBLE PRECISION,
  exchange_order_id TEXT,
  cloid             TEXT,
  position_id       TEXT,
  exchange          TEXT NOT NULL DEFAULT 'HL' CHECK (exchange IN ('HL','BB'))
);
```

Indexes:
- `idx_orders_coin_status_active` — partial, covers `WHERE status IN ('pending','submitted','partial')`.
- `idx_orders_position_id` — partial, covers `position_id IS NOT NULL`.
- `idx_orders_exchange` — full.
- `idx_orders_exchange_coin_cloid` — partial, covers `cloid IS NOT NULL AND cloid <> ''`.

**Cloid vs exchange_order_id (important):**
- `cloid`: client-side ID (HL `cloid` or BB `orderLinkId`). Generated before submit. Used for idempotent recovery.
- `exchange_order_id`: server-assigned ID returned after submit. Used for cancel/modify calls.
- Never copy a Bybit `orderId` UUID into `cloid` (migration 011 legacy backfill explicitly excludes BB).

### `positions` (migrations 001, 005, 009)

```sql
CREATE TABLE positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin            TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price     DOUBLE PRECISION NOT NULL,
  size            DOUBLE PRECISION NOT NULL,
  sl_price        DOUBLE PRECISION,
  tp_price        DOUBLE PRECISION,
  unrealized_pnl  DOUBLE PRECISION DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closing', 'closed')),
  opened_at       TIMESTAMPTZ DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  close_price     DOUBLE PRECISION,
  realized_pnl    DOUBLE PRECISION,
  exchange        TEXT NOT NULL DEFAULT 'HL' CHECK (exchange IN ('HL','BB'))
);
```

Indexes:
- `idx_positions_closed_at` — partial, covers `status='closed' AND closed_at IS NOT NULL`. Powers metrics queries.
- `idx_positions_coin_status` — full.
- `idx_positions_exchange` — full.

### `trade_journal` (migrations 001, 003, 008)

```sql
CREATE TABLE trade_journal (
  id          BIGSERIAL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type  TEXT NOT NULL,
  coin        TEXT,
  details     JSONB NOT NULL DEFAULT '{}',
  agent_state TEXT,
  exchange    TEXT NOT NULL DEFAULT 'HL' CHECK (exchange IN ('HL','BB'))
);

SELECT create_hypertable('trade_journal', 'ts', if_not_exists => TRUE);
```

Indexes:
- `idx_journal_event_type` — `(event_type, ts DESC)`.
- `trade_journal_exchange_idx` — full on `exchange`.

**`event_type` vocabulary** (extend with care — used in indexes and matview JOIN):
- `setup_detected` — strategy emitted a setup
- `setup_rejected` — agent rejected (regime / risk / cooldown)
- `order_placed` — order submitted to exchange
- `order_filled` — fill confirmed
- `order_cancelled` — cancel confirmed
- `order_reject` — exchange rejected
- `enter` — position opened (used by `pattern_performance` JOIN)
- `exit` — position closed
- `sl_hit`, `tp_hit`, `manual_close`, `invalidation_close` — exit reasons
- `cb_open`, `cb_close` — circuit breaker transitions

### `backtest_runs` / `backtest_trades` / `backtest_equity` (migration 002)

Standard FK cascade. `backtest_equity` is a hypertable keyed by `ts` for efficient range queries when rendering equity curves.

### `optimization_trials` (migration 010)

`coins TEXT[]` is the Postgres array type — query with `ANY(coins) = 'BTC'`. `oos_*` columns are the out-of-sample metrics; `holdout_*` are the held-out validation set.

### `trade_memory` (migration 012)

Plain PG. **No `pgvector`, no embeddings.** Retrieval uses structured filters (`category`, `coin`, `pattern`, `regime`) plus FTS via `search_vec` GIN index. See [project_dashboard_design_2026_05.md](../../.claude) and [src/memory/](../../src/memory/) for the foundation library.

---

## JSONB shape contracts

**Rule**: JSONB fields MUST conform to a documented shape. Adding or removing keys = schema change = update this doc.

### `trade_journal.details`

Variable shape keyed by `event_type`. The most-used keys:

| Key | Type | Used by | Notes |
|---|---|---|---|
| `position_id` | UUID string | `pattern_performance` JOIN | Required for `enter` events |
| `pattern_type` | string | `pattern_performance` | e.g. `'spring'`, `'fvg'`, `'order_block'` |
| `signal_grade` | string | `pattern_performance` | e.g. `'A'`, `'B'`, `'C'` |
| `setup_id` | string | trace | Links journal to setup record |
| `reason` | string | reject events | Human-readable rejection reason |
| `confluence_score` | number | analytics | 0-1 |
| `regime` | string | analytics | e.g. `'trend'`, `'range'`, `'transition'` |
| `exit_reason` | string | exit events | `'sl' | 'tp' | 'manual' | 'invalidation'` |

### `backtest_runs.config`

Snapshot of `BacktestConfig` from `src/types.ts`. Includes `coins`, `intervals`, `start`, `end`, `slippage_bps`, `fee_bps`, `strategy_params`. Verbatim snapshot for reproducibility.

### `backtest_runs.metrics`

Snapshot of `BacktestMetrics`. Includes the top-level numeric metrics (denormalized to columns: `total_trades`, `net_pnl`, `win_rate`, `max_drawdown`, `sharpe_ratio`, `expectancy`) plus detailed breakdown (per-pattern, per-coin, holding times, distribution).

### `optimization_trials.params`

`StrategyParams` shape — the actual parameter vector under test. Adding a param to the optimizer means adding a key here; old rows lack the key, queries must `COALESCE`.

### `trade_memory.metadata`

Open shape — varies by `category`. Conventions:
- `trade_outcome`: `{ entry_price, exit_price, holding_bars, exit_reason }`
- `pattern_insight`: `{ pattern, regime, sample_size }`
- `error_lesson`: `{ error_class, mitigation }`

---

## Retention & compression policy

| Table | Compression | Retention | Backup |
|---|---|---|---|
| `candles` | After 7 days, segmentby `(coin, interval)`, ~10× ratio | 1 year | `pg_dump` weekly |
| `trade_journal` | None (low volume) | None — keep full history | `pg_dump` weekly |
| `positions` | N/A (not hypertable) | None | `pg_dump` weekly |
| `orders` | N/A | None | `pg_dump` weekly |
| `backtest_equity` | None currently — consider after 30 days if size grows | None | Skip in nightly, full only |
| Matviews | N/A — regenerable | N/A | Skip — refresh after restore |

Backup discipline:
- Local: `pg_dump` to `data/backups/YYYY-MM-DD.sql.gz` weekly. Keep last 4.
- Offsite: rsync to backup server / S3 / Backblaze. Configure separately.
- Restore drill: quarterly. Time the restore. Document in retro.

---

## Migration discipline

- **One purpose per file.** Don't bundle unrelated changes.
- **Idempotent.** `CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$;`
- **Numbered**: `NNN_short_purpose.sql`. Next: `013`.
- **Migration runner**: `src/db/migrate.ts` runs all in order, tracks in `schema_migrations`.
- **Never edit applied migrations.** Add a new one to correct.
- **Update this doc.** Migration PR must update [02-database-schema.md](02-database-schema.md) sections.

---

## Open questions / gaps

These are known to be unspecified. Resolve before they bite.

- **`backtest_equity` retention.** No retention policy. May grow unboundedly across many optimizer runs. Add a TTL or scope to recent runs only.
- **`trade_journal` `details` schema enforcement.** Currently free-form JSONB. Consider per-`event_type` validators in TypeScript (Zod schema mapped to event type) — not a DB constraint.
- **Materialized view refresh contention.** All three matviews refresh on every trade close — fine at current volume, could become a bottleneck if trade frequency increases 10×. Switch to concurrent + debounce if so.
- **Audit columns.** No `created_by` / `updated_by` — single-user system means it's implied, but if multi-viewer auth lets viewers trigger actions, add columns then.
