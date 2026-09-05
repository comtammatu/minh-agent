import type {
  ExchangeOpenOrderSnapshot,
  ExchangePositionSnapshot,
} from "../agent/types.js";
import type {
  AccountState,
  OrderResult,
  PlaceOrderParams,
  PlaceTriggerParams,
  UpdatePositionStopParams,
} from "../execution/exchange-service.js";
import type { ExchangeId } from "../types.js";

/** Opaque order reference — prefer cloid; else exchange id string. */
export type OrderRef = string;

/**
 * Execution port — domain programs against this, never concrete HL/BB clients.
 * Narrowed from legacy IExchangeService (no public getAssetId).
 */
export interface ExchangePort {
  readonly exchange: ExchangeId;
  init(): Promise<void>;
  reloadInstruments(): Promise<void>;
  setLeverage(coin: string, leverage: number, sizeUsd?: number): Promise<void>;
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  placeTrigger(params: PlaceTriggerParams): Promise<OrderResult>;
  cancelByCloid(coin: string, cloid: string): Promise<OrderResult>;
  cancelByOrderId(coin: string, orderId: string): Promise<OrderResult>;
  modifyTrigger(
    coin: string,
    oid: number,
    side: "long" | "short",
    newTriggerPrice: number,
    size: number,
    isMarket: boolean,
    tpsl: "tp" | "sl",
  ): Promise<OrderResult>;
  updatePositionStop?(params: UpdatePositionStopParams): Promise<OrderResult>;
  cancelAllOpenOrders?(): Promise<OrderResult>;
  getAccount(): Promise<AccountState>;
  getCachedAccountValue(): number;
  getPositions(): Promise<ExchangePositionSnapshot[]>;
  getOpenOrders(): Promise<ExchangeOpenOrderSnapshot[] | null>;
  getFillAggregateByCloid(
    cloid: string,
    coin: string,
  ): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null>;
}
