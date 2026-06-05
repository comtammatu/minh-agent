/**
 * Bybit trade stream feed — WS `publicTrade.{symbol}` aggregated into delta per bar.
 *
 * Side mapping (Bybit convention → internal):
 *   "Buy"  = buyer aggressor → buy volume  (maps to HL "B")
 *   "Sell" = seller aggressor → sell volume (maps to HL "A")
 *
 * Writes into the shared delta store (feed/trades.ts) so pipeline.ts
 * getLatestDelta() works transparently for both HL and BB.
 */

import { WebsocketClient } from "bybit-api";
import { log } from "../../lib/logger.js";
import { applyDeltaUpdate, initDelta, removeDelta } from "../trades.js";

let wsClient: WebsocketClient | null = null;

// coin → symbol mapping for unsubscribe
const activeSubs = new Map<string, string>();

function toSymbol(coin: string): string {
  return `${coin}USDT`;
}

function getClient(): WebsocketClient {
  if (!wsClient) {
    wsClient = new WebsocketClient({ market: "v5", testnet: false });

    wsClient.on("update", (data: { topic?: string; data?: unknown[] }) => {
      const topic = data.topic;
      if (!topic?.startsWith("publicTrade.")) return;

      const symbol = topic.slice("publicTrade.".length); // e.g. BTCUSDT
      const coin = symbol.replace("USDT", "");

      if (!activeSubs.has(coin)) return;

      try {
        const trades = data.data as Array<{ S: string; v: string }> | undefined;
        if (!trades || trades.length === 0) return;

        let buyVol = 0;
        let sellVol = 0;
        for (const t of trades) {
          const size = parseFloat(t.v);
          if (!Number.isFinite(size) || size <= 0) continue;
          if (t.S === "Buy") buyVol += size;
          else sellVol += size;
        }

        if (buyVol > 0 || sellVol > 0) {
          applyDeltaUpdate(coin, buyVol, sellVol);
        }
      } catch (err) {
        log.error(
          "bybit-trades",
          `${coin}: parse error — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    wsClient.on("exception", (err: unknown) => {
      log.warn(
        "bybit-trades",
        `WS exception: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return wsClient;
}

/**
 * Subscribe to trade stream for a coin.
 * Initialises delta state and starts accumulating on every trade batch.
 */
export function subscribeBybitTrades(coin: string): void {
  if (activeSubs.has(coin)) return;

  const symbol = toSymbol(coin);
  activeSubs.set(coin, symbol);
  initDelta(coin);

  const client = getClient();
  client.subscribeV5([`publicTrade.${symbol}`], "linear");
  log.info("bybit-trades", `${coin}: subscribed publicTrade.${symbol}`);
}

/**
 * Unsubscribe trade stream for a coin and clear its delta state.
 */
export function unsubscribeBybitTrades(coin: string): void {
  const symbol = activeSubs.get(coin);
  if (!symbol) return;

  wsClient?.unsubscribeV5([`publicTrade.${symbol}`], "linear");
  activeSubs.delete(coin);
  removeDelta(coin);
  log.info("bybit-trades", `${coin}: unsubscribed`);
}

/** Close all Bybit trade subscriptions (call on SIGINT). */
export function closeAllBybitTrades(): void {
  if (wsClient) {
    try {
      wsClient.closeAll();
    } catch {
      /* ignore */
    }
    wsClient = null;
  }
  activeSubs.clear();
}
