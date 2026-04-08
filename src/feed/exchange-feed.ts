/**
 * Exchange feed interface — implemented by HLFeed and BybitFeed.
 * All feed implementations are exchange-agnostic from the caller's perspective.
 */

import type { Candle, CandleInterval, ExchangeId, BackfillResult } from '../types.js'

export interface IExchangeFeed {
  readonly exchangeId: ExchangeId

  backfill(
    coins: string[],
    onCandles: (coin: string, interval: CandleInterval, candles: Candle[]) => void,
    isLoaded?: (coin: string, interval: CandleInterval) => boolean,
  ): Promise<BackfillResult[]>

  subscribe(
    coins: string[],
    onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
  ): Promise<void>

  closeAll(): Promise<void>
  checkStaleness(): void
}
