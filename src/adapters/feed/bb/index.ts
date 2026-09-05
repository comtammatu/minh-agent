import { BybitFeed } from "../../../feed/bb/bybit-feed.js";
import type { FeedPort } from "../../../ports/feed.js";

/** BB FeedPort adapter over legacy BybitFeed. */
export function createBbFeedPort(): FeedPort {
  const feed = new BybitFeed();
  return {
    exchange: "BB",
    backfill: (coins, onCandles, isLoaded) =>
      feed.backfill(coins, onCandles, isLoaded),
    subscribeCandles: (coins, onCandle) => feed.subscribe(coins, onCandle),
    checkStaleness: () => feed.checkStaleness(),
    close: () => feed.closeAll(),
  };
}
