import type {
  BackfillResult,
  Candle,
  CandleInterval,
  ExchangeId,
} from "../types.js";

export interface MarketCtx {
  coin: string;
  markPx?: number;
  oraclePx?: number;
  funding?: number;
  openInterest?: number;
  bid?: number;
  ask?: number;
  ts: number;
}

export interface StalenessReport {
  staleCoins: string[];
}

/** Market-data port — HL and BB adapters must satisfy this. */
export interface FeedPort {
  readonly exchange: ExchangeId;
  backfill(
    coins: string[],
    onCandles: (
      coin: string,
      interval: CandleInterval,
      candles: Candle[],
    ) => void,
    isLoaded?: (coin: string, interval: CandleInterval) => boolean,
  ): Promise<BackfillResult[]>;
  subscribeCandles(
    coins: string[],
    onCandle: (coin: string, interval: CandleInterval, candle: Candle) => void,
  ): Promise<void>;
  checkStaleness(): void;
  close(): Promise<void>;
}
