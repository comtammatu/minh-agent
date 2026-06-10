import type {
  ExchangeOpenOrderSnapshot,
  ExchangePositionSnapshot,
} from "../agent/types.js";
import { SIMULATED_ACCOUNT } from "../config.js";
import type { ExchangeId } from "../types.js";
import type {
  AccountState,
  IExchangeService,
  OrderResult,
  PlaceOrderParams,
  PlaceTriggerParams,
  UpdatePositionStopParams,
} from "./exchange-service.js";

type PaperFill = {
  avgPx: number;
  totalSz: number;
  isFilled: true;
};

/**
 * Paper execution adapter: satisfies the private execution interface without
 * touching wallet keys, exchange clients, or order APIs.
 */
export class PaperExchangeService implements IExchangeService {
  readonly exchangeId: ExchangeId;

  private nextOrderId = 1;
  private fillsByCloid = new Map<string, PaperFill>();
  private fillsByOrderId = new Map<string, PaperFill>();

  constructor(exchangeId: ExchangeId) {
    this.exchangeId = exchangeId;
  }

  async init(): Promise<void> {
    return;
  }

  getWalletAddress(): string {
    return "paper";
  }

  getAccountAddress(): string {
    return "paper";
  }

  async reloadSymbols(): Promise<void> {
    return;
  }

  getAssetId(_coin: string): number | undefined {
    return undefined;
  }

  getSzDecimals(_coin: string): number | undefined {
    return undefined;
  }

  getMaxLeverage(_coin: string): number | undefined {
    return undefined;
  }

  async setLeverage(
    _coin: string,
    _leverage: number,
    _sizeUsd?: number,
  ): Promise<void> {
    return;
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const rawOrderId = this.nextPaperOrderId();
    const fill: PaperFill = {
      avgPx: params.price,
      totalSz: params.size,
      isFilled: true,
    };
    this.fillsByOrderId.set(rawOrderId, fill);
    if (params.cloid) this.fillsByCloid.set(params.cloid, fill);
    return {
      success: true,
      oid: null,
      rawOrderId,
      avgPx: params.price,
      totalSz: params.size,
      status: "filled",
      error: null,
    };
  }

  async placeTrigger(_params: PlaceTriggerParams): Promise<OrderResult> {
    return this.success("paper_trigger_noop");
  }

  async cancelByOid(_coin: string, _oid: number): Promise<OrderResult> {
    return this.success("paper_cancel_noop");
  }

  async cancelByCloid(_coin: string, _cloid: string): Promise<OrderResult> {
    return this.success("paper_cancel_noop");
  }

  async cancelByOrderId(_coin: string, _orderId: string): Promise<OrderResult> {
    return this.success("paper_cancel_noop");
  }

  async modifyTrigger(
    _coin: string,
    _oid: number,
    _side: "long" | "short",
    _newTriggerPrice: number,
    _size: number,
    _isMarket: boolean,
    _tpsl: "tp" | "sl",
  ): Promise<OrderResult> {
    return this.success("paper_modify_trigger_noop");
  }

  async updatePositionStop(
    _params: UpdatePositionStopParams,
  ): Promise<OrderResult> {
    return this.success("paper_position_stop_noop");
  }

  async cancelAllOpenOrders(): Promise<OrderResult> {
    return this.success("paper_cancel_all_noop");
  }

  async scheduleCancel(_timestampMs?: number): Promise<OrderResult> {
    return this.success("paper_schedule_cancel_noop");
  }

  async getAccountState(): Promise<AccountState> {
    return {
      accountValue: SIMULATED_ACCOUNT,
      totalNtlPos: 0,
      totalMarginUsed: 0,
      withdrawable: SIMULATED_ACCOUNT,
      spotUsdcBalance: 0,
      effectiveBalance: SIMULATED_ACCOUNT,
    };
  }

  getCachedAccountValue(): number {
    return SIMULATED_ACCOUNT;
  }

  async getPositions(): Promise<ExchangePositionSnapshot[]> {
    return [];
  }

  async getOpenOrders(): Promise<ExchangeOpenOrderSnapshot[]> {
    return [];
  }

  async getFillAggregateByCloid(
    cloid: string,
    _coin: string,
  ): Promise<PaperFill | null> {
    return this.fillsByCloid.get(cloid) ?? null;
  }

  async getFillAggregateByOrderId(
    orderId: string,
    _coin: string,
  ): Promise<PaperFill | null> {
    return this.fillsByOrderId.get(orderId) ?? null;
  }

  private nextPaperOrderId(): string {
    const orderId = `paper:${this.exchangeId}:${this.nextOrderId}`;
    this.nextOrderId += 1;
    return orderId;
  }

  private success(status: string): OrderResult {
    return {
      success: true,
      oid: null,
      avgPx: null,
      totalSz: null,
      status,
      error: null,
    };
  }
}
