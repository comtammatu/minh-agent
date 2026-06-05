/**
 * HLFeed — Hyperliquid implementation of IExchangeFeed.
 * Thin adapter over rest.ts / ws.ts. Zero logic of its own.
 */

import { TIMEFRAMES } from "../config.js";
import type { BackfillResult, Candle, CandleInterval } from "../types.js";
import type { IExchangeFeed } from "./exchange-feed.js";
import { backfillAllCoins } from "./rest.js";
import {
  subscribeCandles,
  checkStaleness as wsCheckStaleness,
  closeAll as wsCloseAll,
} from "./ws.js";

export class HLFeed implements IExchangeFeed {
  readonly exchangeId = "HL" as const;

  async backfill(
    coins: string[],
    onCandles: (
      coin: string,
      interval: CandleInterval,
      candles: Candle[],
    ) => void,
    isLoaded?: (coin: string, interval: CandleInterval) => boolean,
  ): Promise<BackfillResult[]> {
    return backfillAllCoins(coins, onCandles, undefined, isLoaded);
  }

  async subscribe(
    coins: string[],
    onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
  ): Promise<void> {
    for (const coin of coins) {
      for (const tf of TIMEFRAMES) {
        await subscribeCandles(coin, tf, onCandle);
      }
    }
  }

  async closeAll(): Promise<void> {
    await wsCloseAll();
  }

  checkStaleness(): void {
    wsCheckStaleness();
  }
}
