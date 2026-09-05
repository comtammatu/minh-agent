/**
 * BybitFeed — Bybit implementation of IExchangeFeed.
 * Thin adapter over bybit-rest.ts / bybit-ws.ts. Zero logic of its own.
 */

import { TIMEFRAMES } from "../../config.js";
import type { BackfillResult, Candle, CandleInterval } from "../../types.js";
import type { IExchangeFeed } from "../exchange-feed.js";
import { backfillBybitCoins } from "./bybit-rest.js";
import {
  checkBybitStaleness,
  closeAllBybit,
  subscribeBybitCandles,
} from "./bybit-ws.js";

export class BybitFeed implements IExchangeFeed {
  readonly exchangeId = "BB" as const;

  async backfill(
    coins: string[],
    onCandles: (
      coin: string,
      interval: CandleInterval,
      candles: Candle[],
    ) => void,
    isLoaded?: (coin: string, interval: CandleInterval) => boolean,
  ): Promise<BackfillResult[]> {
    return backfillBybitCoins(coins, onCandles, 3, isLoaded);
  }

  async subscribe(
    coins: string[],
    onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
  ): Promise<void> {
    for (const coin of coins) {
      for (const tf of TIMEFRAMES) {
        await subscribeBybitCandles(coin, tf, onCandle);
      }
    }
  }

  async closeAll(): Promise<void> {
    await closeAllBybit();
  }

  checkStaleness(): void {
    checkBybitStaleness();
  }
}
