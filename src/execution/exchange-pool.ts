/**
 * Exchange Pool — shared ExchangeService factory for the active runtime.
 *
 * Both HL and Bybit use a single shared wallet/account for the whole process:
 *   HL:  one shared HLExchangeService (Hyperliquid Vault main wallet)
 *   BB:  one shared BybitExchangeService (Bybit main wallet)
 *
 * All requests route to the same shared instance — no per-strategy split.
 *
 * Design decisions:
 *   - S10: activeExchange read once in init(), cached — never per-get()
 */

import { BybitExchangeService } from "./bybit-exchange-service.js";
import type { IExchangeService } from "./exchange-service.js";
import { ExchangeService, getExchangeService } from "./exchange-service.js";

export type { IExchangeService } from "./exchange-service.js";

import { getActiveExchange, SIMULATED_ACCOUNT } from "../config.js";
import { log } from "../lib/logger.js";
import type { ExchangeId } from "../types.js";

export class ExchangePool {
  /** Shared instance for the active runtime. */
  private shared: IExchangeService | null = null;

  /** Active exchange, read once in init() and cached. */
  private activeExchange: ExchangeId = "HL";

  /** Whether init() completed successfully. */
  private initialized = false;

  /** True after {@link init} succeeds. If false, {@link get} must not be called. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize the pool: create and init the shared exchange service instance.
   * Routes to HL or Bybit based on ACTIVE_EXCHANGE env.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.activeExchange = getActiveExchange();
    log.info("exchange-pool", `Active exchange: ${this.activeExchange}`);

    if (this.activeExchange === "BB") {
      log.info("exchange-pool", "Bybit single-wallet mode");
      const svc = new BybitExchangeService();
      await svc.init();
      this.shared = svc;
    } else {
      log.info("exchange-pool", "HL single-wallet mode");
      this.shared = new ExchangeService();
      await this.shared.init();
    }

    this.initialized = true;
    log.info("exchange-pool", "ExchangePool ready (shared wallet)");
  }

  /**
   * Get the exchange service for the active runtime.
   * Always returns the shared instance — the process uses one wallet.
   */
  get(exchange?: ExchangeId): IExchangeService {
    if (!this.initialized) {
      throw new Error("ExchangePool not initialized — call init() first");
    }
    const ex = exchange ?? this.activeExchange;
    if (this.shared) return this.shared;
    return this.getFallback(ex);
  }

  /** Get the shared instance. */
  getShared(): IExchangeService {
    if (!this.initialized) {
      throw new Error("ExchangePool not initialized — call init() first");
    }
    if (!this.shared) {
      throw new Error("ExchangePool shared service unavailable");
    }
    return this.shared;
  }

  /** Always false — the runtime uses one shared wallet. */
  isMultiWallet(): boolean {
    return false;
  }

  /** Active exchange cached at init(). */
  getActiveExchangeId(): ExchangeId {
    return this.activeExchange;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fallback when shared is null (pre-init compat, scripts, tests).
   * HL: returns singleton ExchangeService.
   * BB: throws — BB mode requires explicit init().
   */
  private getFallback(exchange: ExchangeId): IExchangeService {
    if (exchange === "HL") return getExchangeService();
    throw new Error(
      `No BybitExchangeService initialized for exchange=${exchange}. Call ExchangePool.init() first.`,
    );
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let poolInstance: ExchangePool | null = null;

/** Get or create the singleton ExchangePool. */
export function getExchangePool(): ExchangePool {
  if (!poolInstance) {
    poolInstance = new ExchangePool();
  }
  return poolInstance;
}

/** Reset ExchangePool (tests only). */
export function resetExchangePool(): void {
  poolInstance = null;
}

/**
 * Cached effective balance (USD) for the shared runtime wallet.
 * Routes through {@link ExchangePool.get} when the pool is initialized; otherwise
 * falls back to the singleton {@link getExchangeService} (pre-init, tests, scripts).
 */
export function getCachedAccountValue(): number {
  try {
    const svc = getExchangePool().get();
    return svc.getCachedAccountValue() || SIMULATED_ACCOUNT;
  } catch {
    return getExchangeService().getCachedAccountValue() || SIMULATED_ACCOUNT;
  }
}
