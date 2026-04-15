# Runtime And Feed

The runtime path is split between a thin process entrypoint (`src/index.ts`) and the long-lived orchestration module in `src/runtime/app.ts`. `runRuntime()` chooses the active exchange, builds a coin selector, runs migrations, subscribes feeds before backfill, loads persisted candles, then upgrades the process from bootstrap mode into a live operator loop. This keeps the startup sequence explicit without leaving all lifecycle code in one file.

The feed layer is split between transport-specific adapters and one bounded in-memory store. `feed/rest.ts` owns Hyperliquid REST backfill with retry and rate-limit behavior, while `feed/store.ts` keeps a per-exchange, per-coin, per-timeframe hot window with timestamp upsert semantics and an optional persistence callback. That separation matters because the setup pipeline can stay allocation-aware and storage-agnostic while startup still persists candles to PostgreSQL through a write-through callback.

Bybit support is intentionally thin at the feed abstraction boundary. `BybitFeed` just delegates backfill, candle subscription, staleness checks, and shutdown to `bybit-rest.ts` and `bybit-ws.ts` (`src/feed/bybit/bybit-feed.ts:1`, `src/feed/bybit/bybit-feed.ts:19`, `src/feed/bybit/bybit-feed.ts:27`, `src/feed/bybit/bybit-feed.ts:38`). That keeps the exchange-specific blast radius inside `feed/bybit/` and `execution/` instead of leaking per-exchange branches into every consumer.

## Failure modes and recovery

Startup defends against empty or broken coin universes by failing fast when the selector returns no coins, and by probing Hyperliquid coins before expensive backfill work (`src/runtime/app.ts`). Partial backfill failure is handled more softly: zero-ready coins are unsubscribed, replaced from the ranked list, and retried for a bounded number of rounds (`src/runtime/app.ts`).

REST backfill treats rate limits and server instability as expected operational states. `fetchCandles()` retries 429s with a longer wait budget, backs off 500s, and returns `null` only after bounded failure, leaving the caller to skip or replace a coin instead of crashing the process (`src/feed/rest.ts`). The tradeoff is that coin coverage can degrade silently if too many pairs fail together, so operators need the startup logs and TUI counts to notice readiness gaps (`src/runtime/app.ts`).

The reconnect path is process-local and coarse-grained. `runRuntime()` tears down subscriptions, polling, Telegram, and the TUI before sleeping and restarting the runtime loop. That is operationally safer than trying to surgically revive partial subsystems after an unknown failure, but it makes `src/runtime/` the highest-risk place to introduce lifecycle leaks.

## Blast radius and safe change plan

Changing `feed/store.ts` affects the live setup engine, persistence, paper trading, and backtests because all of them read through the same bounded candle cache (`src/feed/store.ts`, `src/strategy/orchestrator.ts`, `src/backtest/engine.ts`). Safe changes here should preserve timestamp upsert semantics and the hot-window cap.

Changing `src/runtime/app.ts` affects every cross-cutting subsystem because it owns the order in which they become reachable. The code explicitly wires OrderManager callbacks before pipeline subscription so bootstrap actions are not lost. Reordering those lines is a behavioral change, not cleanup.

## Unknowns

- Unknown: whether WS reconnect logic below the feed adapters has any hidden resource leak under repeated long-lived failure. Verification step: run a fault-injection soak test and watch RSS plus subscription counts across multiple reconnect cycles.
- Unknown: whether Bybit ticker-as-price-proxy is acceptable for all paper-mode use cases. Verification step: compare the TUI price proxy with exchange mark-price data during volatile periods (`src/runtime/app.ts`).

<!-- ORACLE-META
Written by codebase-oracle | 2026-04-14
Data: direct source reading + generated import graph
Audience: new engineer, oncall | Confidence: 84%
Unknowns: 2 items pending verification
-->
