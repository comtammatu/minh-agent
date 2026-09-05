import { PaperExchangeService } from "../../../execution/paper-exchange-service.js";
import type { ExchangePort } from "../../../ports/exchange.js";
import type { ExchangeId } from "../../../types.js";

export function createPaperExchangePort(
  exchange: ExchangeId = "HL",
): ExchangePort {
  const svc = new PaperExchangeService(exchange);
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
