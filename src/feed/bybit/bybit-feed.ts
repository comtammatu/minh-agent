/**
 * BybitFeed — Bybit implementation of IExchangeFeed.
 * Thin adapter over bybit-rest.ts / bybit-ws.ts. Zero logic of its own.
 */

import type { IExchangeFeed } from '../exchange-feed.js'
import type { Candle, CandleInterval, BackfillResult } from '../../types.js'
import { backfillBybitCoins } from './bybit-rest.js'
import {
  subscribeBybitCandles,
  closeAllBybit,
  checkBybitStaleness,
} from './bybit-ws.js'
import { TIMEFRAMES } from '../../config.js'

export class BybitFeed implements IExchangeFeed {
  readonly exchangeId = 'BB' as const

  async backfill(
    coins: string[],
    onCandles: (coin: string, interval: CandleInterval, candles: Candle[]) => void,
    isLoaded?: (coin: string, interval: CandleInterval) => boolean,
  ): Promise<BackfillResult[]> {
    return backfillBybitCoins(coins, onCandles, 3, isLoaded)
  }

  async subscribe(
    coins: string[],
    onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
  ): Promise<void> {
    for (const coin of coins) {
      for (const tf of TIMEFRAMES) {
        await subscribeBybitCandles(coin, tf, onCandle)
      }
    }
  }

  async closeAll(): Promise<void> {
    await closeAllBybit()
  }

  checkStaleness(): void {
    checkBybitStaleness()
  }
}
