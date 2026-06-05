/**
 * HL WebSocket candle subscription.
 * Uses SubscriptionClient for per-coin/TF candle streams.
 * Staleness watchdog: setInterval checks lastCandleTime map every 30s.
 * Per-coin tracking: coinSubs Map enables selective unsubscribe on coin drop.
 */

import type { ISubscription } from "@nktkas/hyperliquid";
import { SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { STALENESS_THRESHOLD_MS, WS_MAX_SUBSCRIPTIONS } from "../config.js";
import { log } from "../lib/logger.js";
import type { Candle, CandleInterval } from "../types.js";

// Module-level WS client (one process, one WS connection)
let wsClient: SubscriptionClient | null = null;
const activeSubscriptions: ISubscription[] = [];

// Per-coin subscription tracking for selective unsubscribe
const coinSubs = new Map<string, ISubscription[]>();

// lastCandleTime: key = "BTC|4h", value = Date.now() at last received candle
const lastCandleTime = new Map<string, number>();

function getClient(): SubscriptionClient {
  if (!wsClient) {
    const transport = new WebSocketTransport();
    wsClient = new SubscriptionClient({ transport });
  }
  return wsClient;
}

/** Get shared WS client — used by trades.ts and orderbook.ts feeds. */
export function getWsClient(): SubscriptionClient {
  return getClient();
}

/** Register a subscription for centralized cleanup on closeAll(). Warns near HL 1000 limit. */
export function registerSubscription(sub: ISubscription): void {
  if (activeSubscriptions.length >= WS_MAX_SUBSCRIPTIONS) {
    log.warn(
      "ws",
      `LIMIT — ${activeSubscriptions.length}/${WS_MAX_SUBSCRIPTIONS} subscriptions, cannot add more`,
    );
    return;
  }
  activeSubscriptions.push(sub);
  if (activeSubscriptions.length >= WS_MAX_SUBSCRIPTIONS * 0.8) {
    log.warn(
      "ws",
      `${activeSubscriptions.length}/${WS_MAX_SUBSCRIPTIONS} subscriptions (80%+ capacity)`,
    );
  }
}

/** Get total active WS subscription count. */
export function getSubscriptionCount(): number {
  return activeSubscriptions.length;
}

/** Remove a subscription from the global activeSubscriptions array. */
export function removeSubscription(sub: ISubscription): void {
  const idx = activeSubscriptions.indexOf(sub);
  if (idx !== -1) activeSubscriptions.splice(idx, 1);
}

function parseCandle(raw: {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}): Candle {
  return {
    t: raw.t,
    o: parseFloat(raw.o),
    h: parseFloat(raw.h),
    l: parseFloat(raw.l),
    c: parseFloat(raw.c),
    v: parseFloat(raw.v),
  };
}

/**
 * Subscribe to candle stream for coin/interval.
 * Calls onCandle on every tick. Stores subscription for shutdown cleanup.
 */
export async function subscribeCandles(
  coin: string,
  interval: CandleInterval,
  onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
): Promise<void> {
  const client = getClient();
  const k = `${coin}|${interval}`;

  const sub = await client.candle({ coin, interval }, (event) => {
    try {
      const candle = parseCandle(event);
      lastCandleTime.set(k, Date.now());
      onCandle(coin, interval, candle);
    } catch (err) {
      log.error(
        "ws",
        `${k}: parse error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  registerSubscription(sub);
  lastCandleTime.set(k, Date.now());

  // Track per-coin for selective unsubscribe
  const existing = coinSubs.get(coin) ?? [];
  existing.push(sub);
  coinSubs.set(coin, existing);
}

/** Unsubscribe all candle streams for a specific coin. */
export async function unsubscribeCandles(coin: string): Promise<void> {
  const subs = coinSubs.get(coin);
  if (!subs) return;

  for (const sub of subs) {
    try {
      await sub.unsubscribe();
    } catch {
      /* ignore */
    }
    removeSubscription(sub);
  }
  coinSubs.delete(coin);

  // Clear staleness entries for this coin
  for (const k of lastCandleTime.keys()) {
    if (k.startsWith(`${coin}|`)) lastCandleTime.delete(k);
  }
}

/** Close all active WS subscriptions (call on SIGINT). */
export async function closeAll(): Promise<void> {
  for (const sub of activeSubscriptions) {
    try {
      await sub.unsubscribe();
    } catch {
      /* ignore */
    }
  }
  activeSubscriptions.length = 0;
  coinSubs.clear();
  lastCandleTime.clear();
  if (wsClient) {
    try {
      (wsClient as unknown as { close?: () => void }).close?.();
    } catch {
      /* ignore */
    }
    wsClient = null;
  }
}

/**
 * Check all subscriptions for staleness.
 * Logs WARNING for any coin/tf silent for > STALENESS_THRESHOLD_MS.
 * Called by setInterval in index.ts.
 */
export function checkStaleness(): void {
  const now = Date.now();
  for (const [k, lastTime] of lastCandleTime) {
    const silent = now - lastTime;
    if (silent > STALENESS_THRESHOLD_MS) {
      log.warn(
        "ws",
        `${k}: stale ${Math.round(silent / 1000)}s — no candle update`,
      );
    }
  }
}
