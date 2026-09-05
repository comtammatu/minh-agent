/**
 * Process-wide execution service — single wallet, one exchange.
 */
import {
  getActiveExchange,
  getExecutionMode,
  isPaperMode,
  SIMULATED_ACCOUNT,
} from "../config.js";
import { BybitExchangeService } from "../execution/bybit-exchange-service.js";
import type { IExchangeService } from "../execution/exchange-service.js";
import {
  ExchangeService,
  getExchangeService,
} from "../execution/exchange-service.js";
import { PaperExchangeService } from "../execution/paper-exchange-service.js";
import { log } from "../lib/logger.js";
import type { ExchangeId } from "../types.js";

let service: IExchangeService | null = null;
let initialized = false;
let activeExchange: ExchangeId = "HL";

export function isExecutionInitialized(): boolean {
  return initialized;
}

export async function initExecution(): Promise<IExchangeService> {
  if (initialized && service) return service;

  activeExchange = getActiveExchange();
  log.info("execution", `Active exchange: ${activeExchange}`);

  const executionMode = getExecutionMode();
  if (executionMode === "paper") {
    log.info("execution", "Paper execution mode");
    const paper = new PaperExchangeService(activeExchange);
    await paper.init();
    service = paper;
  } else if (activeExchange === "BB") {
    log.info("execution", "Bybit single-wallet mode");
    const bb = new BybitExchangeService();
    await bb.init();
    service = bb;
  } else {
    log.info("execution", "HL single-wallet mode");
    service = new ExchangeService();
    await service.init();
  }

  initialized = true;
  log.info("execution", "Execution service ready");
  return service;
}

export function getExecution(): IExchangeService {
  if (!initialized || !service) {
    throw new Error("Execution not initialized — call initExecution() first");
  }
  return service;
}

export function getCachedAccountValue(): number {
  try {
    return getExecution().getCachedAccountValue() || SIMULATED_ACCOUNT;
  } catch {
    if (isPaperMode()) return SIMULATED_ACCOUNT;
    return getExchangeService().getCachedAccountValue() || SIMULATED_ACCOUNT;
  }
}

/** Reset execution singleton (tests only). */
export function resetExecution(): void {
  service = null;
  initialized = false;
}
