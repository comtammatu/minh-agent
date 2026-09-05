import { HLFeed } from "../../../feed/hl/hl-feed.js";
import type { FeedPort } from "../../../ports/feed.js";

/** HL FeedPort adapter over legacy HLFeed. */
export function createHlFeedPort(): FeedPort {
  const feed = new HLFeed();
  return {
    exchange: "HL",
    backfill: (coins, onCandles, isLoaded) =>
      feed.backfill(coins, onCandles, isLoaded),
    subscribeCandles: (coins, onCandle) => feed.subscribe(coins, onCandle),
    checkStaleness: () => feed.checkStaleness(),
    close: () => feed.closeAll(),
  };
}
