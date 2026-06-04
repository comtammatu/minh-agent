import { mock } from "bun:test";
import { EventEmitter } from "node:events";

type AnyRecord = Record<string, unknown>;

const OK = { retCode: 0, retMsg: "OK" } as const;

class MockRestClientV5 {
  async getKline(_params?: AnyRecord): Promise<AnyRecord> {
    return {
      ...OK,
      result: { list: [] },
      retExtInfo: {},
      time: Date.now(),
    };
  }

  async getTickers(_params?: AnyRecord): Promise<AnyRecord> {
    return {
      ...OK,
      result: { list: [] },
      retExtInfo: {},
      time: Date.now(),
    };
  }

  async getInstrumentsInfo(_params?: AnyRecord): Promise<AnyRecord> {
    return {
      ...OK,
      result: { list: [], nextPageCursor: "" },
    };
  }

  async setLeverage(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: {} };
  }

  async submitOrder(_params?: AnyRecord): Promise<AnyRecord> {
    return {
      ...OK,
      result: { orderId: "MOCK_ORDER_ID", orderLinkId: "MOCK_ORDER_LINK_ID" },
    };
  }

  async cancelOrder(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: { orderId: "MOCK_ORDER_ID" } };
  }

  async getPositionInfo(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: { list: [] } };
  }

  async getWalletBalance(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: { list: [] } };
  }

  async getOrderHistory(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: { list: [], nextPageCursor: "" } };
  }

  async getOpenOrders(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: { list: [], nextPageCursor: "" } };
  }

  async setTradingStop(_params?: AnyRecord): Promise<AnyRecord> {
    return { ...OK, result: {} };
  }
}

class MockWebsocketClient extends EventEmitter {
  constructor(_opts?: AnyRecord) {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  subscribeV5(_topic: string | string[], _category?: string): void {}
  unsubscribeV5(_topic: string | string[], _category?: string): void {}
  closeAll(): void {
    this.removeAllListeners();
  }
}

mock.module("bybit-api", () => ({
  RestClientV5: MockRestClientV5,
  WebsocketClient: MockWebsocketClient,
}));
