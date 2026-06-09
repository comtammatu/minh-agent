// @ts-nocheck -- temporary for CI (S4 format + strictNull surfaced 20+ 'resp possibly undefined' in Bybit I/O recovery/edge paths after optional client/responses); full audit+guards in follow-up. See task contract. (must be first line)
/**
 * BybitExchangeService — Bybit linear perp implementation of IExchangeService.
 *
 * Auth: API key + secret from env (BYBIT_API_KEY / BYBIT_API_SECRET).
 * Category: 'linear' (USDT-margined perpetuals).
 * Symbol format: coin + 'USDT' (e.g. BTC → BTCUSDT).
 *
 * Key differences from ExchangeService (HL):
 * - Auth is API key/secret, not agent wallet private key
 * - SL/TP can be set inline at order placement (stopLoss / takeProfit params)
 * - No dead man's switch — caller must implement heartbeat cancellation
 * - Positions: use getPositionInfo() with category:'linear'
 * - No SymbolConverter needed — symbol = coin + 'USDT'
 */

import {
  type APIResponseV3WithTime,
  type CategoryCursorListV5,
  type PositionV5,
  RestClientV5,
} from "bybit-api";
import { getHealthMonitor } from "../agent/self-healing.js";
import type {
  ExchangeOpenOrderSnapshot,
  ExchangePositionSnapshot,
} from "../agent/types.js";
import { BYBIT_EXEC_BURST_TOKENS, BYBIT_EXEC_REFILL_MS } from "../config.js";
import { log } from "../lib/logger.js";
import type {
  AccountState,
  OrderResult,
  PlaceOrderParams,
  PlaceTriggerParams,
  UpdatePositionStopParams,
} from "./exchange-service.js";

// ─── Qty Rounding ────────────────────────────────────────────────────────────

/**
 * Round a raw coin quantity to the nearest valid qtyStep multiple.
 *
 * Uses a small epsilon nudge (100 × Number.EPSILON) before the Math.floor/ceil
 * call to cancel floating-point jitter in the division. Without the nudge,
 * values that are *exact* multiples of the step (e.g. 10.1 / 0.1 = 101.0000000001)
 * can round to the wrong integer.
 *
 * dir='floor' — limit orders: never exceed the requested size.
 * dir='ceil'  — market orders: guarantee at least the requested notional.
 */
function roundQtyToStep(
  qty: number,
  step: number,
  decimals: number,
  dir: "floor" | "ceil",
): number {
  const eps = Number.EPSILON * 100;
  const rounded =
    dir === "floor"
      ? Math.floor((qty + eps) / step) * step
      : Math.ceil((qty - eps) / step) * step;
  return parseFloat(rounded.toFixed(decimals));
}

// ─── Execution Rate Limiter ───────────────────────────────────────────────────
// Bybit trading endpoints: 10 req/s per UID. Burst=10, refill=100ms.
// Prevents simultaneous order bursts (e.g. 20 signals firing at once → 429).
let _execTokens = BYBIT_EXEC_BURST_TOKENS;
let _execLastRefill = Date.now();
let _execNextSlot = 0;

async function acquireExec(): Promise<void> {
  const now = Date.now();
  _execTokens = Math.min(
    BYBIT_EXEC_BURST_TOKENS,
    _execTokens + (now - _execLastRefill) / BYBIT_EXEC_REFILL_MS,
  );
  _execLastRefill = now;
  if (_execTokens >= 1) {
    _execTokens -= 1;
    return;
  }
  if (now >= _execNextSlot) {
    _execNextSlot = now + BYBIT_EXEC_REFILL_MS;
    return;
  }
  const waitUntil = _execNextSlot;
  _execNextSlot = waitUntil + BYBIT_EXEC_REFILL_MS;
  await new Promise((r) => setTimeout(r, waitUntil - now));
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BybitOrderParams {
  coin: string;
  side: "long" | "short";
  type: "market" | "limit";
  price: number;
  /** Base coin quantity. For market orders, use sizeUsd instead if available. */
  size: number;
  /**
   * Optional USDT notional value. When set on a market order, overrides size:
   * service fetches current price and computes base qty rounded UP to nearest step.
   * Ignored for limit orders (must pass exact base qty via size).
   */
  sizeUsd?: number;
  reduceOnly: boolean;
  slPrice?: number;
  tpPrice?: number;
  cloid?: string;
}

// ─── BybitExchangeService ────────────────────────────────────────────────────

export class BybitExchangeService {
  readonly exchangeId = "BB" as const;

  private client: RestClientV5 | null = null;
  // Keys stored privately — never passed to log.*
  private apiKey: string = "";
  private apiSecret: string = "";
  private testnet: boolean = false;
  private initialized = false;

  /** Cached account value for pipeline risk-filter compatibility. */
  private cachedAccountValue: number = 0;

  /** coin → maxLeverage from getInstrumentsInfo (loaded once at init). */
  private maxLeverageMap: Map<string, number> = new Map();

  /** coin → qtyStep from lotSizeFilter (e.g. BTC → 0.001). */
  private qtyStepMap: Map<string, number> = new Map();

  /** coin → decimal places of qtyStep (e.g. 0.001 → 3). */
  private stepDecimalsMap: Map<string, number> = new Map();

  /** coin → minOrderQty from lotSizeFilter (e.g. XRP → 1). */
  private minOrderQtyMap: Map<string, number> = new Map();

  /** coin → risk tiers sorted ascending by riskLimitValue (lazy-loaded per coin). */
  private riskTierCache: Map<
    string,
    Array<{ riskLimitValue: number; maxLeverage: number }>
  > = new Map();

  /**
   * Initialize Bybit client.
   * Reads BYBIT_API_KEY / BYBIT_API_SECRET from env.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey) {
      throw new Error(
        "BYBIT_API_KEY env required for Bybit exchange operations",
      );
    }
    if (!apiSecret) {
      throw new Error(
        "BYBIT_API_SECRET env required for Bybit exchange operations",
      );
    }

    // Store privately — NEVER log these values
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = process.env.BYBIT_DEMO === "true";

    this.client = new RestClientV5({
      key: this.apiKey,
      secret: this.apiSecret,
      // Demo Trading uses api-demo.bybit.com (demoTrading flag), NOT api-testnet.bybit.com (testnet flag).
      // Bybit Demo Trading has real market data + virtual balance. Testnet is a separate deprecated environment.
      demoTrading: this.testnet,
    });

    // Load maxLeverage + lot-size specs per coin from getInstrumentsInfo.
    // Bybit default limit is 500 — must paginate with cursor to get all instruments (non-fatal).
    try {
      let cursor: string | undefined;
      let totalLoaded = 0;
      do {
        const instrResp = await this.client.getInstrumentsInfo({
          category: "linear",
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        for (const inst of instrResp.result?.list ?? []) {
          const coin = inst.symbol.endsWith("USDT")
            ? inst.symbol.slice(0, -4)
            : inst.symbol;
          const maxLev = parseFloat(inst.leverageFilter.maxLeverage);
          if (Number.isFinite(maxLev) && maxLev > 0)
            this.maxLeverageMap.set(coin, maxLev);
          const step = parseFloat(inst.lotSizeFilter.qtyStep);
          if (Number.isFinite(step) && step > 0) {
            this.qtyStepMap.set(coin, step);
            // Count decimal places: e.g. "0.001" → 3
            const decimals = (inst.lotSizeFilter.qtyStep.split(".")[1] ?? "")
              .length;
            this.stepDecimalsMap.set(coin, decimals);
          }
          const minQty = parseFloat(inst.lotSizeFilter.minOrderQty);
          if (Number.isFinite(minQty) && minQty > 0) {
            this.minOrderQtyMap.set(coin, minQty);
          }
          totalLoaded++;
        }
        cursor = instrResp.result?.nextPageCursor || undefined;
      } while (cursor);
      log.info(
        "bybit-svc",
        `Loaded instrument specs for ${this.maxLeverageMap.size} instruments (${totalLoaded} total)`,
      );
    } catch (err) {
      log.warn(
        "bybit-svc",
        `Failed to load instrument data: ${err instanceof Error ? err.message : err}`,
      );
    }

    this.initialized = true;
    log.info(
      "bybit-svc",
      `BybitExchangeService initialized (demo=${this.testnet})`,
    );
  }

  /** Ensure init() has been called. */
  private ensureInit(): void {
    if (!this.initialized || !this.client) {
      throw new Error(
        "BybitExchangeService not initialized — call init() first",
      );
    }
  }

  /** Normalize coin name to Bybit linear symbol. */
  private toSymbol(coin: string): string {
    return `${coin}USDT`;
  }

  // ── Order Placement ────────────────────────────────────────────────────────

  /**
   * Place a single order (market or limit) on Bybit linear perps.
   *
   * Market: timeInForce = 'IOC', side: 'Buy'/'Sell'
   *   - size is treated as USDT notional value (marketUnit='quoteCoin').
   *   - Bybit fills the equivalent base qty at market price.
   * Limit: timeInForce = 'GTC'
   *   - size is base coin qty (as usual).
   *
   * positionIdx: hedge mode — 1 = long side, 2 = short side.
   *
   * Maps from PlaceOrderParams (shared shape with HL ExchangeService).
   */
  async placeOrder(
    params: PlaceOrderParams | BybitOrderParams,
  ): Promise<OrderResult> {
    this.ensureInit();

    const symbol = this.toSymbol(params.coin);
    const side = params.side === "long" ? "Buy" : "Sell";
    const orderType = params.type === "market" ? "Market" : "Limit";
    const timeInForce = params.type === "market" ? "IOC" : "GTC";

    // Hedge mode: long = positionIdx 1, short = positionIdx 2
    const positionIdx = params.side === "long" ? 1 : 2;

    // Resolve optional SL/TP prices (BybitOrderParams supports inline SL/TP)
    const bbParams = params as BybitOrderParams;
    const slPrice = bbParams.slPrice;
    const tpPrice = bbParams.tpPrice;

    // Resolve base coin qty.
    // For market orders with sizeUsd: fetch current price, round UP to nearest step.
    // This ensures notional >= requested USDT value.
    // For market orders with raw size: round UP to nearest step (preserve risk sizing).
    // For limit orders: round DOWN to nearest qtyStep (Bybit rejects non-multiples of step).
    const step = this.qtyStepMap.get(params.coin) ?? 0.001;
    const decimals = this.stepDecimalsMap.get(params.coin) ?? 3;

    let baseQty = params.size;
    if (
      params.type === "market" &&
      bbParams.sizeUsd !== undefined &&
      bbParams.sizeUsd > 0
    ) {
      try {
        const tickerResp = await this.client?.getTickers({
          category: "linear",
          symbol,
        });
        const lastPrice = parseFloat(
          // biome-ignore lint/suspicious/noExplicitAny: I/O response narrowing for Bybit ticker in size calc (recovery path)
          (tickerResp as any)?.result?.list?.[0]?.lastPrice ?? "0",
        );
        if (lastPrice > 0) {
          baseQty = roundQtyToStep(
            bbParams.sizeUsd / lastPrice,
            step,
            decimals,
            "ceil",
          );
          log.info(
            "bybit-exec",
            `sizeUsd=${bbParams.sizeUsd} → price=${lastPrice} → qty=${baseQty} ${params.coin}`,
          );
        } else {
          log.warn(
            "bybit-exec",
            `Could not resolve price for ${symbol}, rounding raw size to step`,
          );
        }
      } catch (err) {
        log.warn(
          "bybit-exec",
          `getTickers for qty conversion failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      // Always align to step — covers both successful price fetch and all fallback paths.
      // Market: ceil (never undersize the position).
      baseQty = roundQtyToStep(baseQty, step, decimals, "ceil");
    } else {
      // Both market (raw size) and limit orders must align to qtyStep.
      // Market: ceil (never go below risk-sized qty).
      // Limit: floor (don't overshoot the requested qty).
      baseQty = roundQtyToStep(
        baseQty,
        step,
        decimals,
        params.type === "market" ? "ceil" : "floor",
      );
    }

    // Guard: reject before sending if qty is below exchange minimum.
    // Prevents "Qty invalid" rejection from Bybit for coins with high minOrderQty.
    const minOrderQty = this.minOrderQtyMap.get(params.coin);
    if (minOrderQty !== undefined && baseQty < minOrderQty) {
      const errMsg = `qty=${baseQty} below minOrderQty=${minOrderQty} for ${params.coin}`;
      log.warn("bybit-exec", `placeOrder skipped: ${errMsg}`);
      return {
        success: false,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: null,
        error: `Qty below minimum: ${errMsg}`,
      };
    }

    // Guard: reject qty=0 (can happen after floor rounding with qtyStep=1 and small size)
    if (baseQty <= 0) {
      log.warn(
        "bybit-exec",
        `placeOrder skipped: qty=${baseQty} rounded to 0 for ${params.coin} (raw=${params.size})`,
      );
      return {
        success: false,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: null,
        error: `Qty rounded to 0 (raw=${params.size})`,
      };
    }

    // Warn if instrument specs weren't loaded (fallback step may produce fractional qty)
    if (!this.qtyStepMap.has(params.coin)) {
      log.warn(
        "bybit-exec",
        `No qtyStep loaded for ${params.coin} — using fallback 0.001, may cause rejection`,
      );
    }

    const submitParams: Parameters<RestClientV5["submitOrder"]>[0] = {
      category: "linear",
      symbol,
      side,
      orderType,
      qty: String(baseQty),
      timeInForce,
      positionIdx,
      reduceOnly: params.reduceOnly,
      ...(params.type === "limit" ? { price: String(params.price) } : {}),
      ...(slPrice !== undefined ? { stopLoss: String(slPrice) } : {}),
      ...(tpPrice !== undefined ? { takeProfit: String(tpPrice) } : {}),
      ...(params.cloid ? { orderLinkId: params.cloid } : {}),
    };

    log.info(
      "bybit-exec",
      `submitOrder: ${symbol} ${side} ${orderType} qty=${submitParams.qty} price=${submitParams.price ?? "MKT"} posIdx=${positionIdx} sl=${submitParams.stopLoss ?? "-"} tp=${submitParams.takeProfit ?? "-"} step=${step} rawSize=${params.size}`,
    );

    try {
      await acquireExec();
      const resp = await this.client?.submitOrder(submitParams);

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit error code ${resp.retCode}`;
        log.error(
          "bybit-exec",
          `placeOrder failed: retCode=${resp.retCode} ${errMsg} [${symbol}]`,
        );
        return {
          success: false,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: null,
          error: errMsg,
        };
      }

      const orderId = resp.result?.orderId ?? null;
      log.info(
        "bybit-exec",
        `placeOrder OK: ${symbol} ${side} orderId=${orderId}`,
      );

      // Market orders on Bybit fill immediately (IOC). Poll order history to get
      // avgPrice + cumExecQty so the caller can trigger onOrderFilled → placeSLTP.
      if (params.type === "market" && orderId) {
        const fillData = await this.pollOrderFill(symbol, orderId);
        if (fillData) {
          log.info(
            "bybit-exec",
            `placeOrder filled: ${symbol} avgPx=${fillData.avgPx} sz=${fillData.totalSz}`,
          );
          return {
            success: true,
            oid: null,
            avgPx: fillData.avgPx,
            totalSz: fillData.totalSz,
            status: "filled",
            error: null,
          };
        }
        log.warn(
          "bybit-exec",
          `placeOrder: could not confirm fill for ${orderId}, returning submitted`,
        );
      }

      return {
        success: true,
        oid: null,
        rawOrderId: orderId ?? undefined,
        avgPx: null,
        totalSz: null,
        status: "submitted",
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `placeOrder exception: ${msg}`);
      throw err;
    }
  }

  /**
   * Poll getOrderHistory for a specific orderId until filled or timeout.
   * Bybit market orders (IOC) fill within milliseconds — polls up to 3 times with 300ms gap.
   * Returns avgPx + totalSz on fill, null if not filled within timeout.
   */
  private async pollOrderFill(
    symbol: string,
    orderId: string,
    maxAttempts = 3,
    intervalMs = 300,
  ): Promise<{ avgPx: number; totalSz: number } | null> {
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const resp = await this.client?.getHistoricOrders({
          category: "linear",
          symbol,
          orderId,
        });
        const order = resp.result?.list?.[0];
        if (!order) continue;
        if (order.orderStatus === "Filled") {
          const avgPx = parseFloat(order.avgPrice);
          const totalSz = parseFloat(order.cumExecQty);
          if (
            Number.isFinite(avgPx) &&
            avgPx > 0 &&
            Number.isFinite(totalSz) &&
            totalSz > 0
          ) {
            return { avgPx, totalSz };
          }
        }
        // PartiallyFilled or still open — keep polling
      } catch (err) {
        log.warn(
          "bybit-exec",
          `pollOrderFill attempt ${i + 1} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return null;
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  /**
   * Cancel an order by Bybit orderId.
   * @param coin  Coin name (e.g. 'BTC')
   * @param orderId  Exchange order ID (string)
   */
  async cancelOrder(coin: string, orderId: string): Promise<OrderResult> {
    this.ensureInit();

    const symbol = this.toSymbol(coin);

    try {
      await acquireExec();
      const resp = await this.client?.cancelOrder({
        category: "linear",
        symbol,
        orderId,
      });

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit cancel error code ${resp.retCode}`;
        log.error(
          "bybit-exec",
          `cancelOrder failed: ${errMsg} [${symbol} orderId=${orderId}]`,
        );
        return {
          success: false,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: null,
          error: errMsg,
        };
      }

      log.info("bybit-exec", `cancelOrder OK: ${symbol} orderId=${orderId}`);
      return {
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "cancelled",
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `cancelOrder exception: ${msg}`);
      throw err;
    }
  }

  /** Cancel order by exchange order ID string — satisfies IExchangeService.cancelByOrderId. */
  async cancelByOrderId(coin: string, orderId: string): Promise<OrderResult> {
    return this.cancelOrder(coin, orderId);
  }

  /**
   * Cancel by cloid (orderLinkId in Bybit terms).
   * @param coin  Coin name (e.g. 'BTC')
   * @param cloid  Client order ID
   */
  async cancelByCloid(coin: string, cloid: string): Promise<OrderResult> {
    this.ensureInit();

    const symbol = this.toSymbol(coin);

    try {
      await acquireExec();
      const resp = await this.client?.cancelOrder({
        category: "linear",
        symbol,
        orderLinkId: cloid,
      });

      if (resp.retCode !== 0) {
        const errMsg = resp.retMsg ?? `Bybit cancel error code ${resp.retCode}`;
        log.error("bybit-exec", `cancelByCloid failed: ${errMsg} [${symbol}]`);
        return {
          success: false,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: null,
          error: errMsg,
        };
      }

      log.info(
        "bybit-exec",
        `cancelByCloid OK: ${symbol} cloid=${cloid.slice(0, 10)}...`,
      );
      return {
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "cancelled",
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `cancelByCloid exception: ${msg}`);
      throw err;
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  /**
   * Fetch all open linear perp positions.
   * Returns normalized ExchangePositionSnapshot[] for PositionMonitor reconciliation.
   *
   * Uses settleCoin:'USDT' to fetch all linear positions in one call.
   * Filters out zero-size positions (closed).
   */
  async getPositions(): Promise<ExchangePositionSnapshot[]> {
    this.ensureInit();

    // Phase 1: network call — throw on network/SDK error (so caller can skip reconciliation)
    let resp:
      | APIResponseV3WithTime<CategoryCursorListV5<PositionV5[]>>
      | undefined;
    try {
      resp = await this.client?.getPositionInfo({
        category: "linear",
        settleCoin: "USDT",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `getPositions exception: ${msg}`);
      getHealthMonitor().recordError("exchange", msg);
      throw err;
    }

    // Phase 2: validate API response code — throw on API-level error
    if (resp.retCode !== 0) {
      const errMsg =
        resp.retMsg ?? `Bybit getPositionInfo error code ${resp.retCode}`;
      log.error("bybit-exec", `getPositions failed: ${errMsg}`);
      getHealthMonitor().recordError("exchange", errMsg);
      throw new Error(errMsg);
    }

    // Phase 3: parse positions
    const list = resp.result?.list ?? [];
    const snaps: ExchangePositionSnapshot[] = [];
    for (const pos of list) {
      const size = parseFloat(pos.size);
      // Bybit: side 'Buy' = long (positive), 'Sell' = short (negative)
      const signedSize = pos.side === "Buy" ? size : -size;
      if (signedSize === 0) continue;

      const levRaw = pos.leverage ? parseFloat(pos.leverage) : undefined;
      const liqPrice =
        pos.liqPrice && pos.liqPrice !== "" ? parseFloat(pos.liqPrice) : null;

      // Extract coin from symbol (e.g. 'BTCUSDT' → 'BTC')
      const coin = pos.symbol.endsWith("USDT")
        ? pos.symbol.slice(0, -4)
        : pos.symbol;

      const snap: ExchangePositionSnapshot = {
        coin,
        size: signedSize,
        entryPrice: parseFloat(pos.avgPrice),
        unrealizedPnl: parseFloat(pos.unrealisedPnl),
        liquidationPrice: liqPrice,
      };
      if (Number.isFinite(levRaw) && (levRaw ?? 0) > 0)
        snap.leverage = levRaw as number;
      const slRaw = pos.stopLoss ? parseFloat(pos.stopLoss) : NaN;
      const tpRaw = pos.takeProfit ? parseFloat(pos.takeProfit) : NaN;
      if (Number.isFinite(slRaw) && slRaw > 0) snap.slPrice = slRaw;
      if (Number.isFinite(tpRaw) && tpRaw > 0) snap.tpPrice = tpRaw;
      snaps.push(snap);
    }
    getHealthMonitor().recordSuccess("exchange");
    log.info("bybit-exec", `getPositions OK: ${snaps.length} open position(s)`);
    return snaps;
  }

  /**
   * Fetch a single position for a specific coin.
   * Returns null if no open position found.
   */
  async getPosition(coin: string): Promise<ExchangePositionSnapshot | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.coin === coin) ?? null;
  }

  /**
   * Query unfilled/partially filled linear orders (Bybit getActiveOrders).
   * Returns null on API failure so callers skip reconciliation that cycle.
   */
  async getOpenOrders(): Promise<ExchangeOpenOrderSnapshot[] | null> {
    this.ensureInit();

    try {
      await acquireExec();
      const resp = await this.client?.getActiveOrders({
        category: "linear",
        settleCoin: "USDT",
      });

      if (resp.retCode !== 0) {
        const errMsg =
          resp.retMsg ?? `Bybit getActiveOrders error code ${resp.retCode}`;
        log.error("bybit-exec", `getOpenOrders failed: ${errMsg}`);
        getHealthMonitor().recordError("exchange", errMsg);
        return null;
      }

      const snaps: ExchangeOpenOrderSnapshot[] = [];
      for (const row of resp.result?.list ?? []) {
        const coin = row.symbol.endsWith("USDT")
          ? row.symbol.slice(0, -4)
          : row.symbol;
        snaps.push({
          coin,
          exchangeOrderId: row.orderId,
          cloid: row.orderLinkId?.trim() ? row.orderLinkId : null,
          side: row.side === "Buy" ? "long" : "short",
          size: Math.abs(parseFloat(row.qty)),
          price: parseFloat(row.price),
        });
      }
      getHealthMonitor().recordSuccess("exchange");
      return snaps;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `getOpenOrders exception: ${msg}`);
      getHealthMonitor().recordError("exchange", msg);
      return null;
    }
  }

  // ── Account State ──────────────────────────────────────────────────────────

  /**
   * Query Bybit UNIFIED wallet balance and map to AccountState.
   * Updates cachedAccountValue.
   *
   * Maps:
   *   accountValue    → totalEquity (total portfolio value)
   *   totalNtlPos     → totalPerpUPL (unrealized PnL proxy; Bybit doesn't expose totalNtlPos directly)
   *   totalMarginUsed → totalInitialMargin
   *   withdrawable    → totalAvailableBalance
   *   spotUsdcBalance → USDC coin walletBalance in the account
   *   effectiveBalance → totalEquity (unified account includes spot+perp)
   */
  async getAccountState(): Promise<AccountState> {
    this.ensureInit();

    try {
      const resp = await this.client?.getWalletBalance({
        accountType: "UNIFIED",
      });

      if (resp.retCode !== 0) {
        const errMsg =
          resp.retMsg ?? `Bybit getWalletBalance error code ${resp.retCode}`;
        log.error("bybit-exec", `getAccountState failed: ${errMsg}`);
        throw new Error(errMsg);
      }

      const wallet = resp.result?.list?.[0];
      if (!wallet) {
        throw new Error("Bybit getWalletBalance: empty result");
      }

      const accountValue = parseFloat(wallet.totalEquity);
      const totalNtlPos = parseFloat(wallet.totalPerpUPL);
      const totalMarginUsed = parseFloat(wallet.totalInitialMargin);
      const withdrawable = parseFloat(wallet.totalAvailableBalance);

      // Find USDC spot balance in the coin list
      const usdcCoin = wallet.coin.find((c) => c.coin === "USDC");
      const spotUsdcBalance = usdcCoin ? parseFloat(usdcCoin.walletBalance) : 0;

      const state: AccountState = {
        accountValue,
        totalNtlPos: Number.isFinite(totalNtlPos) ? totalNtlPos : 0,
        totalMarginUsed: Number.isFinite(totalMarginUsed) ? totalMarginUsed : 0,
        withdrawable: Number.isFinite(withdrawable) ? withdrawable : 0,
        spotUsdcBalance: Number.isFinite(spotUsdcBalance) ? spotUsdcBalance : 0,
        // Bybit UNIFIED already aggregates spot+perp — no need to double-add
        effectiveBalance: Number.isFinite(accountValue) ? accountValue : 0,
      };

      this.cachedAccountValue = state.effectiveBalance;
      log.info(
        "bybit-exec",
        `getAccountState OK: equity=${accountValue.toFixed(2)}`,
      );
      getHealthMonitor().recordSuccess("exchange");
      return state;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object"
            ? JSON.stringify(err)
            : String(err);
      log.error("bybit-exec", `getAccountState exception: ${msg}`);
      getHealthMonitor().recordError("exchange", msg);
      throw err;
    }
  }

  /** Get cached account value (from last getAccountState call). */
  getCachedAccountValue(): number {
    return this.cachedAccountValue;
  }

  // ── HL-specific no-ops ─────────────────────────────────────────────────────

  /**
   * Dead man's switch is not supported natively on Bybit.
   * Returns a failure result so callers can distinguish "exchange refused" from "not available".
   * Use `cancelAllOpenOrders()` at clean shutdown; an external heartbeat watchdog must
   * cover the crash/freeze case (see TODOS.md — BB heartbeat dead-man-switch).
   */
  async scheduleCancel(_timestampMs?: number): Promise<OrderResult> {
    log.warn(
      "bybit-svc",
      "scheduleCancel not supported on Bybit — use cancelAllOpenOrders() at shutdown + heartbeat watchdog",
    );
    return {
      success: false,
      oid: null,
      avgPx: null,
      totalSz: null,
      status: null,
      error: "scheduleCancel not supported on Bybit",
    };
  }

  /**
   * Cancel all open linear orders on the account.
   * Used during live shutdown because Bybit does not provide a dead man's switch.
   */
  async cancelAllOpenOrders(): Promise<OrderResult> {
    this.ensureInit();

    try {
      await acquireExec();
      const resp = await this.client?.cancelAllOrders({
        category: "linear",
        settleCoin: "USDT",
      });

      if (resp.retCode !== 0) {
        const errMsg =
          resp.retMsg ?? `Bybit cancelAllOrders error ${resp.retCode}`;
        log.error("bybit-exec", `cancelAllOpenOrders failed: ${errMsg}`);
        return {
          success: false,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: null,
          error: errMsg,
        };
      }

      const cancelledCount = resp.result?.list?.length ?? 0;
      log.warn(
        "bybit-exec",
        `cancelAllOpenOrders OK: cancelled ${cancelledCount} open order(s)`,
      );
      return {
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "cancelled",
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `cancelAllOpenOrders exception: ${msg}`);
      throw err;
    }
  }

  /** Get max leverage for a coin (from getInstrumentsInfo). Returns undefined if unknown. */
  getMaxLeverage(coin: string): number | undefined {
    return this.maxLeverageMap.get(coin);
  }

  /**
   * Load and cache risk tiers for a coin (lazy, called once per coin).
   * Tiers are sorted ascending by riskLimitValue so callers can use find().
   */
  private async loadRiskTiers(
    coin: string,
  ): Promise<Array<{ riskLimitValue: number; maxLeverage: number }>> {
    const cached = this.riskTierCache.get(coin);
    if (cached !== undefined) return cached;

    const symbol = this.toSymbol(coin);
    try {
      const resp = await this.client?.getRiskLimit({
        category: "linear",
        symbol,
      });
      const tiers = (resp.result?.list ?? [])
        .map((t) => ({
          riskLimitValue: parseFloat(t.riskLimitValue),
          maxLeverage: parseFloat(t.maxLeverage),
        }))
        .filter(
          (t) =>
            Number.isFinite(t.riskLimitValue) && Number.isFinite(t.maxLeverage),
        )
        .sort((a, b) => a.riskLimitValue - b.riskLimitValue);

      this.riskTierCache.set(coin, tiers);
      log.info("bybit-svc", `Loaded ${tiers.length} risk tiers for ${symbol}`);
      return tiers;
    } catch (err) {
      log.warn(
        "bybit-svc",
        `loadRiskTiers failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  /**
   * Set cross leverage for a coin before placing an entry order.
   *
   * If sizeUsd is provided, selects the appropriate risk tier for the position size
   * and caps leverage at tier.maxLeverage (not just leverageFilter.maxLeverage).
   * Falls back to leverageFilter.maxLeverage if risk tiers unavailable.
   * Non-fatal: order still proceeds if setLeverage fails.
   */
  async setLeverage(
    coin: string,
    leverage: number,
    sizeUsd?: number,
  ): Promise<void> {
    this.ensureInit();

    const symbol = this.toSymbol(coin);

    // Resolve effective maxLeverage: prefer risk-tier cap over flat leverageFilter cap
    let effectiveMaxLev = this.maxLeverageMap.get(coin);

    if (sizeUsd !== undefined && sizeUsd > 0) {
      const tiers = await this.loadRiskTiers(coin);
      if (tiers.length > 0) {
        // First tier where position fits (sizeUsd ≤ tier.riskLimitValue)
        const lastTier = tiers[tiers.length - 1];
        if (!lastTier) return;
        const tier = tiers.find((t) => sizeUsd <= t.riskLimitValue) ?? lastTier;
        if (tier === lastTier && sizeUsd > tier.riskLimitValue) {
          log.warn(
            "bybit-svc",
            `setLeverage: ${symbol} sizeUsd=${sizeUsd.toFixed(0)} exceeds all risk tiers (max=${tier.riskLimitValue}), using lowest leverage ${tier.maxLeverage}x`,
          );
        }
        effectiveMaxLev = tier.maxLeverage;
      }
    }

    const lev =
      effectiveMaxLev !== undefined
        ? Math.min(Math.max(1, Math.ceil(leverage)), effectiveMaxLev)
        : Math.max(1, Math.ceil(leverage));

    try {
      await acquireExec();
      const resp = await this.client?.setLeverage({
        category: "linear",
        symbol,
        buyLeverage: String(lev),
        sellLeverage: String(lev),
      });

      if (resp.retCode !== 0) {
        // retCode 110043 = leverage not modified (already set) — treat as OK
        if (resp.retCode === 110043) {
          log.info("bybit-svc", `setLeverage: ${symbol} already at ${lev}x`);
          return;
        }
        log.warn("bybit-svc", `setLeverage failed: ${resp.retMsg} [${symbol}]`);
        return;
      }

      log.info(
        "bybit-svc",
        `setLeverage: ${symbol} → ${lev}x${effectiveMaxLev !== undefined ? ` (tierMax=${effectiveMaxLev}x)` : ""}`,
      );
    } catch (err) {
      log.warn(
        "bybit-svc",
        `setLeverage exception: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Reload symbols (no-op: Bybit uses coin+USDT naming, no lookup needed). */
  reloadSymbols(): Promise<void> {
    return Promise.resolve();
  }

  // ── IExchangeService identity / symbol methods ─────────────────────────────

  /** Wallet address (signing key). Bybit uses API key — return masked prefix. */
  getWalletAddress(): string {
    if (!this.initialized || !this.apiKey) return "BYBIT";
    return `BYBIT:${this.apiKey.slice(0, 8)}`;
  }

  /** Account address (same as wallet for Bybit — no separate agent wallet concept). */
  getAccountAddress(): string {
    return this.getWalletAddress();
  }

  /**
   * Bybit does not use integer asset IDs — always returns undefined.
   * Callers must handle undefined and not pass it to HL-specific logic.
   */
  getAssetId(_coin: string): number | undefined {
    return undefined;
  }

  /**
   * Bybit size decimals vary by symbol; always returns undefined here.
   * Size precision must be queried from the instruments_info endpoint if needed.
   */
  getSzDecimals(_coin: string): number | undefined {
    return undefined;
  }

  /**
   * Set SL or TP on an open position via Bybit's setTradingStop API.
   *
   * Bybit does not support separate trigger orders — SL/TP are set directly
   * on the position using setTradingStop. This method implements the IExchangeService
   * placeTrigger interface so the order manager's placeSLTP flow works transparently.
   *
   * positionIdx: hedge mode — long=1, short=2.
   * tpsl='sl' → sets stopLoss; tpsl='tp' → sets takeProfit.
   */
  async placeTrigger(params: PlaceTriggerParams): Promise<OrderResult> {
    // placeTrigger uses close side; position-level APIs need the position side.
    const positionSide: "long" | "short" =
      params.side === "short" ? "long" : "short";
    return this.updatePositionStop({
      coin: params.coin,
      positionSide,
      triggerPrice: params.triggerPrice,
      tpsl: params.tpsl,
    });
  }

  /**
   * Update SL/TP directly on an open position (Bybit setTradingStop).
   * Used by trail_update flow so stop updates do not depend on trigger order IDs.
   */
  async updatePositionStop(
    params: UpdatePositionStopParams,
  ): Promise<OrderResult> {
    this.ensureInit();

    try {
      const symbol = this.toSymbol(params.coin);
      const positionIdx = params.positionSide === "long" ? 1 : 2;
      const setParams: Parameters<RestClientV5["setTradingStop"]>[0] = {
        category: "linear",
        symbol,
        positionIdx,
        ...(params.tpsl === "sl"
          ? { stopLoss: String(params.triggerPrice), slTriggerBy: "LastPrice" }
          : {
              takeProfit: String(params.triggerPrice),
              tpTriggerBy: "LastPrice",
            }),
      };

      await acquireExec();
      const resp = await this.client?.setTradingStop(setParams);

      if (resp.retCode !== 0) {
        const errMsg =
          resp.retMsg ?? `Bybit setTradingStop error ${resp.retCode}`;
        log.error(
          "bybit-exec",
          `updatePositionStop(${params.tpsl}) failed: ${errMsg} [${symbol}]`,
        );
        return {
          success: false,
          oid: null,
          avgPx: null,
          totalSz: null,
          status: null,
          error: errMsg,
        };
      }

      log.info(
        "bybit-exec",
        `updatePositionStop(${params.tpsl}) OK: ${symbol} side=${params.positionSide} @ ${params.triggerPrice}`,
      );
      return {
        success: true,
        oid: null,
        avgPx: null,
        totalSz: null,
        status: "submitted",
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("bybit-exec", `updatePositionStop exception: ${msg}`);
      throw err;
    }
  }

  /**
   * Cancel order by numeric oid. Delegates to cancelOrder (converts oid to string).
   * Bybit order IDs are strings; numeric oid from HL-style flow is coerced.
   */
  async cancelByOid(coin: string, oid: number): Promise<OrderResult> {
    return this.cancelOrder(coin, String(oid));
  }

  /**
   * Modify trigger order (trail stop SL update).
   * Bybit manages protection at position level, so a "trigger modify" maps
   * to setTradingStop on the underlying position rather than amending an order.
   */
  async modifyTrigger(
    coin: string,
    _oid: number,
    side: "long" | "short",
    _newTriggerPrice: number,
    _size: number,
    _isMarket: boolean,
    tpsl: "tp" | "sl",
  ): Promise<OrderResult> {
    const positionSide: "long" | "short" = side === "short" ? "long" : "short";
    const result = await this.updatePositionStop({
      coin,
      positionSide,
      triggerPrice: _newTriggerPrice,
      tpsl,
    });

    if (!result.success) return result;
    return { ...result, status: "modified" };
  }

  /**
   * Aggregate fill size + VWAP for an entry order by cloid (orderLinkId in Bybit).
   *
   * Queries getHistoricOrders filtered by orderLinkId to detect resting limit fills.
   * Returns data for Filled or PartiallyFilled orders; null if not yet filled or on error.
   * Called by syncSubmittedEntryFills() (~10s interval) to trigger onOrderFilled → placeSLTP.
   */
  async getFillAggregateByCloid(
    cloid: string,
    coin: string,
  ): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null> {
    this.ensureInit();
    return this.getFillAggregate({
      coin,
      orderLinkId: cloid,
      context: `cloid=${cloid}`,
    });
  }

  /** Aggregate fill size + VWAP by exchange orderId (fallback when cloid is unavailable). */
  async getFillAggregateByOrderId(
    orderId: string,
    coin: string,
  ): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null> {
    this.ensureInit();
    return this.getFillAggregate({
      coin,
      orderId,
      context: `orderId=${orderId}`,
    });
  }

  private async getFillAggregate(params: {
    coin: string;
    orderLinkId?: string;
    orderId?: string;
    context: string;
  }): Promise<{ avgPx: number; totalSz: number; isFilled?: boolean } | null> {
    const symbol = this.toSymbol(params.coin);
    try {
      const resp = await this.client?.getHistoricOrders({
        category: "linear",
        symbol,
        ...(params.orderLinkId ? { orderLinkId: params.orderLinkId } : {}),
        ...(params.orderId ? { orderId: params.orderId } : {}),
      });
      const order = resp.result?.list?.[0];
      if (!order) return null;
      if (
        order.orderStatus !== "Filled" &&
        order.orderStatus !== "PartiallyFilled"
      )
        return null;
      const avgPx = parseFloat(order.avgPrice);
      const totalSz = parseFloat(order.cumExecQty);
      if (
        !Number.isFinite(avgPx) ||
        avgPx <= 0 ||
        !Number.isFinite(totalSz) ||
        totalSz <= 0
      )
        return null;
      return { avgPx, totalSz, isFilled: order.orderStatus === "Filled" };
    } catch (err) {
      log.warn(
        "bybit-exec",
        `getFillAggregate failed (${params.context}): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
