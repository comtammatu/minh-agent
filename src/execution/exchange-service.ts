/**
 * Exchange Service Interface — S8: multi-exchange refactor.
 *
 * IExchangeService is the public API all execution callers program against.
 * Concrete implementations: HLExchangeService (Hyperliquid), future BybitExchangeService, etc.
 *
 * This file re-exports HLExchangeService and its helpers so import paths
 * that already point here continue to work during migration.
 */

import type { ExchangePositionSnapshot } from "../agent/types.js";
import type {
  AccountState,
  OrderResult,
  PlaceOrderParams,
  PlaceTriggerParams,
} from "./hl-exchange-service.js";

// Re-export param/result types so callers don't need separate imports
export type { AccountState, OrderResult, PlaceOrderParams, PlaceTriggerParams };

/** Position-level stop update (e.g. Bybit setTradingStop). */
export interface UpdatePositionStopParams {
  coin: string;
  positionSide: "long" | "short";
  triggerPrice: number;
  tpsl: "tp" | "sl";
}

// ─── Interface ──────────────────────────────────────────────────────────────

/**
 * Exchange service interface — implemented by HLExchangeService, BybitExchangeService, etc.
 * All execution callers program against this interface, never concrete classes.
 */
export interface IExchangeService {
  readonly exchangeId: string;

  /** Initialize wallet + client. Idempotent. */
  init(): Promise<void>;

  /** Get signing wallet address. */
  getWalletAddress(): string;

  /** Get main account address (for info queries). */
  getAccountAddress(): string;

  /** Reload symbol mappings (call after coin-selector refresh). */
  reloadSymbols(): Promise<void>;

  /** Get HL asset ID for a coin. Returns undefined if unknown. */
  getAssetId(coin: string): number | undefined;

  /** Get szDecimals for a coin. Returns undefined if unknown. */
  getSzDecimals(coin: string): number | undefined;

  /** Get max leverage for a coin. Returns undefined if unknown. */
  getMaxLeverage(coin: string): number | undefined;

  /** Set cross leverage for a coin before placing an entry order.
   *  sizeUsd: notional value of the position — used to select the correct risk tier on exchanges
   *  that have tiered leverage limits (e.g. Bybit). HL ignores this parameter. */
  setLeverage(coin: string, leverage: number, sizeUsd?: number): Promise<void>;

  /** Place a single entry order (market or limit). */
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;

  /** Place a trigger order (SL or TP). */
  placeTrigger(params: PlaceTriggerParams): Promise<OrderResult>;

  /** Cancel order by exchange oid. */
  cancelByOid(coin: string, oid: number): Promise<OrderResult>;

  /** Cancel order by cloid. */
  cancelByCloid(coin: string, cloid: string): Promise<OrderResult>;

  /** Cancel order by exchange order ID string (Bybit UUID or HL oid as string). */
  cancelByOrderId(coin: string, orderId: string): Promise<OrderResult>;

  /** Modify an existing trigger order (trail stop SL update). */
  modifyTrigger(
    coin: string,
    oid: number,
    side: "long" | "short",
    newTriggerPrice: number,
    size: number,
    isMarket: boolean,
    tpsl: "tp" | "sl",
  ): Promise<OrderResult>;

  /**
   * Update SL/TP directly on an open position (exchange-specific, optional).
   * Used by exchanges that manage protection at position level (e.g. Bybit).
   */
  updatePositionStop?(params: UpdatePositionStopParams): Promise<OrderResult>;

  /**
   * Cancel all currently open orders on the active account (exchange-specific, optional).
   * Used on live shutdown paths when the exchange has no native dead man's switch.
   */
  cancelAllOpenOrders?(): Promise<OrderResult>;

  /**
   * Schedule an exchange-native dead-man-switch cancel-all at `timestampMs`.
   * If the bot freezes/crashes, the exchange auto-cancels all open orders at that time.
   * Caller refreshes periodically before the deadline. Pass `undefined` to clear schedule.
   *
   * - HL: native scheduleCancel. Time must be ≥5s in future; max 10 ops/day per address.
   * - BB: not supported natively → returns failure; rely on cancelAllOpenOrders() at shutdown.
   */
  scheduleCancel?(timestampMs?: number): Promise<OrderResult>;

  /** Query account summary. Updates cached accountValue. */
  getAccountState(): Promise<AccountState>;

  /** Get cached account value (from last getAccountState call). */
  getCachedAccountValue(): number;

  /** Query open positions. */
  getPositions(): Promise<ExchangePositionSnapshot[]>;

  /** Aggregate fill size + VWAP for an entry order by cloid.
   * `isFilled` is true when the exchange confirms the order is fully filled
   * (e.g. Bybit orderStatus='Filled'). When absent/false, caller falls back to
   * size comparison (suitable for HL which aggregates individual fill events). */
  getFillAggregateByCloid(
    cloid: string,
    coin: string,
  ): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null>;

  /** Optional fallback for exchanges where submitted/resting recovery can query by exchange order ID (e.g. Bybit orderId). */
  getFillAggregateByOrderId?(
    orderId: string,
    coin: string,
  ): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null>;
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { BybitExchangeService } from "./bybit-exchange-service.js";
export {
  getHLExchangeService,
  getHLExchangeService as getExchangeService,
  HLExchangeService,
  HLExchangeService as ExchangeService,
  resetHLExchangeService,
  resetHLExchangeService as resetExchangeService,
} from "./hl-exchange-service.js";
