import type { IExchangeService } from "../../../execution/exchange-service.js";
import { getHLExchangeService } from "../../../execution/hl-exchange-service.js";
import { DMS_DEADLINE_MS } from "../../../config.js";
import type { CrashGuardPort } from "../../../ports/crash-guard.js";
import type { ExchangePort } from "../../../ports/exchange.js";

function wrapExchange(svc: IExchangeService, exchange: "HL"): ExchangePort {
  const port: ExchangePort = {
    exchange,
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

export function createHlExchangePort(): ExchangePort {
  return wrapExchange(getHLExchangeService(), "HL");
}

export function createHlCrashGuard(): CrashGuardPort {
  const svc = getHLExchangeService();
  let state: "armed" | "disarmed" | "degraded" = "disarmed";
  return {
    async arm() {
      if (!svc.scheduleCancel) {
        state = "degraded";
        return;
      }
      const r = await svc.scheduleCancel(Date.now() + DMS_DEADLINE_MS);
      state = r.success ? "armed" : "degraded";
    },
    async refresh() {
      if (state !== "armed" || !svc.scheduleCancel) return;
      const r = await svc.scheduleCancel(Date.now() + DMS_DEADLINE_MS);
      if (!r.success) state = "degraded";
    },
    async disarm() {
      if (svc.scheduleCancel) await svc.scheduleCancel(undefined);
      state = "disarmed";
    },
    status: () => state,
  };
}
