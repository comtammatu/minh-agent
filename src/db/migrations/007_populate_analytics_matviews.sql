-- 007_populate_analytics_matviews.sql
-- Initial REFRESH for analytics matviews (003/001 use WITH NO DATA).
-- PostgreSQL requires a non-CONCURRENTLY refresh before REFRESH CONCURRENTLY can run.
-- Idempotent: safe to run multiple times.

REFRESH MATERIALIZED VIEW daily_performance;
REFRESH MATERIALIZED VIEW pattern_performance;
REFRESH MATERIALIZED VIEW pnl_hourly;
