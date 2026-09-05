import { BybitExchangeService } from "../../../execution/bybit-exchange-service.js";
import type { CrashGuardPort } from "../../../ports/crash-guard.js";
import type { ExchangePort } from "../../../ports/exchange.js";

let singleton: BybitExchangeService | null = null;

function getSvc(): BybitExchangeService {
  if (!singleton) singleton = new BybitExchangeService();
  return singleton;
}

export function createBbExchangePort(): ExchangePort {
  const svc = getSvc();
  const port: ExchangePort = {
    exchange: "BB",
    init: () => svc.init(),
    reloadInstruments: () => svc.reloadSymbols(),
    setLeverage: (coin, leverage, sizeUsd) =>
      svc.setLeverage(coin, leverage, sizeUsd),
    placeOrder: (p) => svc.placeOrder(p),
    placeTrigger: (p) => svc.placeTrigger(p),
    cancelByCloid: (coin, cloid) => svc.cancelByCloid(coin, cloid),
    cancelByOrderId: (coin, orderId) => svc.cancelByOrderId(coin, orderId),
    modifyTrigger: (...args) => svc.modifyTrigger(...args),
    getAccount: () => svc.getAccountState(),
    getCachedAccountValue: () => svc.getCachedAccountValue(),
    getPositions: () => svc.getPositions(),
    getOpenOrders: () => svc.getOpenOrders(),
    getFillAggregateByCloid: (cloid, coin) =>
      svc.getFillAggregateByCloid(cloid, coin),
  };
  if (svc.updatePositionStop) {
    port.updatePositionStop = (params) => svc.updatePositionStop!(params);
  }
  if (svc.cancelAllOpenOrders) {
    port.cancelAllOpenOrders = () => svc.cancelAllOpenOrders!();
  }
  return port;
}

/** BB has no native DMS — arm marks watchdog expected; disarm cancels all. */
export function createBbCrashGuard(): CrashGuardPort {
  let state: "armed" | "disarmed" | "degraded" = "disarmed";
  return {
    async arm() {
      state = "armed";
    },
    async refresh() {},
    async disarm() {
      const svc = getSvc();
      if (svc.cancelAllOpenOrders) await svc.cancelAllOpenOrders();
      state = "disarmed";
    },
    status: () => state,
  };
}
