/**
 * Order Lifecycle Manager (Sprint 2 S6).
 *
 * Responsibilities:
 *   - Place entry orders (market/limit) with idempotency (cloid)
 *   - Track order status: pending → submitted → filled/rejected/cancelled
 *   - R9: After entry fill → place SL (trigger-market) + TP (trigger-limit) on exchange
 *   - Cancel unfilled orders (timeout, invalidation)
 *   - Persist all state transitions to `orders` table
 *   - Bidirectional bridge: listens to TradingAgent actions, dispatches events back
 *
 * Design:
 *   - 1 position per coin (confirmed constraint — multi-position DCA deferred)
 *   - Exchange calls stubbed as `submitToExchange()` / `cancelOnExchange()` (wired S10)
 *   - cloid = 128-bit hex string, generated per order, prevents double-submit
 *   - DB is source of truth for order state; exchange is queried for reconciliation
 *
 * I/O boundary — this module talks to DB and (future) exchange.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_RISK_PERCENT,
  getActiveExchange,
  HL_MIN_ORDER_NOTIONAL_USD,
  isPaperMode,
  MARKET_ORDER_SLIPPAGE_PCT,
  MAX_ORDERS_PER_COIN,
  ORDER_FILL_TIMEOUT_MS,
  ORDER_RECONCILE_ALERT_THRESHOLD,
  ORDER_RECONCILE_INTERVAL_MS,
  RETRY,
  SIMULATED_ACCOUNT,
  SL_IS_MARKET,
  TARGET_MARGIN_PCT,
  TP_IS_MARKET,
  tryGetActiveExchange,
} from "../config.js";
import { sql } from "../db/connection.js";
import type {
  ExchangePool,
  IExchangeService,
} from "../execution/exchange-pool.js";
import {
  getExchangeService,
  type OrderResult,
  type UpdatePositionStopParams,
} from "../execution/exchange-service.js";
import { getLatestBook } from "../feed/orderbook.js";
import { log } from "../lib/logger.js";
import { isRetryableExchangeError, withRetry } from "../lib/retry.js";
import type { ActiveSetup, ExchangeId } from "../types.js";
import {
  computeEntryLeverageForTargetMargin,
  computePositionSize,
} from "./exits.js";
import { logJournalEntry } from "./journal.js";
import {
  type OrderReconcileAction,
  planOrderReconciliation,
} from "./order-reconciler.js";
import type {
  AgentAction,
  AgentEvent,
  ExchangeOrderResult,
  ExchangePositionSnapshot,
  Order,
  OrderStatus,
  TriggerOrder,
} from "./types.js";

/** `orders.id` is UUID — reject malformed strings before querying to avoid PostgreSQL ERROR logs. */
function isValidOrderUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function clampPositiveFinite(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isBybitLiveMode(): boolean {
  return tryGetActiveExchange() === "BB";
}

type PositionStopUpdateExchange = IExchangeService & {
  updatePositionStop: (
    params: UpdatePositionStopParams,
  ) => Promise<OrderResult>;
};

function supportsPositionStopUpdate(
  svc: IExchangeService,
): svc is PositionStopUpdateExchange {
  return (
    typeof (svc as Partial<PositionStopUpdateExchange>).updatePositionStop ===
    "function"
  );
}

/**
 * HL "market" is an IOC-like aggressive limit that requires a reference price.
 * Use latest L2 mid when available to avoid stale-candle price rejects.
 */
function computeMarketRefPrice(
  coin: string,
  side: "long" | "short",
  fallbackPrice: number,
): number {
  const book = getLatestBook(coin);
  const bestBid = book?.bids?.[0]?.[0];
  const bestAsk = book?.asks?.[0]?.[0];
  const mid =
    typeof bestBid === "number" &&
    typeof bestAsk === "number" &&
    bestBid > 0 &&
    bestAsk > 0
      ? (bestBid + bestAsk) / 2
      : null;
  const base = clampPositiveFinite(mid ?? fallbackPrice, fallbackPrice);
  const slip = MARKET_ORDER_SLIPPAGE_PCT;
  return side === "long" ? base * (1 + slip) : base * (1 - slip);
}

// ─── Cloid Generation ───────────────────────────────────────────────────────

/** Generate a 128-bit hex client order ID for HL idempotency. */
export function generateCloid(): string {
  // UUID v4 → strip dashes → prefix 0x
  return `0x${randomUUID().replace(/-/g, "")}`;
}

// ─── Exchange Wrappers (S10: real HL calls via ExchangeService) ────────────

/**
 * Submit order to exchange via ExchangeService.
 * Returns ExchangeOrderResult with exchangeOrderId = HL oid (as string).
 */
export async function submitToExchange(
  coin: string,
  side: "long" | "short",
  type: "limit" | "market",
  price: number,
  size: number,
  cloid: string,
  svc?: IExchangeService,
  slPrice?: number,
  tpPrice?: number,
): Promise<ExchangeOrderResult> {
  try {
    const exchange = svc ?? getExchangeService();
    const result = await exchange.placeOrder({
      coin,
      side,
      type,
      price,
      size,
      reduceOnly: false,
      cloid,
      ...(slPrice !== undefined ? { slPrice } : {}),
      ...(tpPrice !== undefined ? { tpPrice } : {}),
    });
    if (result.success) {
      // Prefer rawOrderId (Bybit UUID) > oid (HL numeric) > status fallback
      const exchangeId =
        result.rawOrderId ??
        (result.oid !== null ? String(result.oid) : result.status);
      const out: ExchangeOrderResult = {
        success: true,
        exchangeOrderId: exchangeId,
        error: null,
      };
      // Some entries may return `filled` inline — required so live mode runs onOrderFilled → SL/TP (R9).
      if (
        result.status === "filled" &&
        result.avgPx !== null &&
        result.totalSz !== null
      ) {
        out.fillPrice = result.avgPx;
        out.fillSize = result.totalSz;
      }
      return out;
    }
    return { success: false, exchangeOrderId: null, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, exchangeOrderId: null, error: msg };
  }
}

/**
 * Cancel order on exchange via ExchangeService.
 * exchangeOrderId is the HL oid (stored as string, parsed to number).
 */
export async function cancelOnExchange(
  exchangeOrderId: string,
  coin?: string,
  svc?: IExchangeService,
): Promise<ExchangeOrderResult> {
  try {
    const exchange = svc ?? getExchangeService();

    // Cloid path first — parseInt("0x…", 10) === 0 would mis-route HL cloids to oid 0.
    if (exchangeOrderId.startsWith("0x") && coin) {
      const result = await exchange.cancelByCloid(coin, exchangeOrderId);
      return {
        success: result.success,
        exchangeOrderId: null,
        error: result.error,
      };
    }

    const oid = parseInt(exchangeOrderId, 10);

    // If we have a valid oid and coin, cancel by oid (preferred)
    if (!Number.isNaN(oid) && coin) {
      const result = await exchange.cancelByOid(coin, oid);
      return {
        success: result.success,
        exchangeOrderId: null,
        error: result.error,
      };
    }

    // Bybit path: orderId is UUID-format string (e.g. "be411c88-...") returned by submitOrder.
    // Route through cancelByOrderId which dispatches correctly per exchange type.
    if (coin) {
      const result = await exchange.cancelByOrderId(coin, exchangeOrderId);
      return {
        success: result.success,
        exchangeOrderId: null,
        error: result.error,
      };
    }

    log.warn(
      "order-manager",
      `cancelOnExchange: cannot cancel without valid oid or cloid+coin (id=${exchangeOrderId})`,
    );
    return {
      success: false,
      exchangeOrderId: null,
      error: "Missing coin for cancel",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, exchangeOrderId: null, error: msg };
  }
}

/**
 * Place trigger order (SL/TP) on exchange via ExchangeService.
 * R9: SL = trigger-market (isMarket=true), TP = trigger-market (isMarket=true).
 */
export async function placeTriggerOnExchange(
  trigger: TriggerOrder,
  svc?: IExchangeService,
): Promise<ExchangeOrderResult> {
  try {
    const exchange = svc ?? getExchangeService();
    const result = await exchange.placeTrigger({
      coin: trigger.coin,
      side: trigger.side,
      triggerPrice: trigger.triggerPrice,
      size: trigger.size,
      isMarket: trigger.isMarket,
      tpsl: trigger.type,
      cloid: trigger.cloid,
    });
    if (result.success) {
      const exchangeId =
        result.oid !== null ? String(result.oid) : result.status;
      return { success: true, exchangeOrderId: exchangeId, error: null };
    }
    return { success: false, exchangeOrderId: null, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, exchangeOrderId: null, error: msg };
  }
}

// ─── DB Operations ──────────────────────────────────────────────────────────

/** Insert a new order into the database. */
async function insertOrder(order: Order): Promise<void> {
  await sql`
    INSERT INTO orders (id, coin, side, type, price, size, status, setup_id, sl_price, tp_price, cloid, exchange_order_id, created_at, updated_at, fill_price, fill_size, filled_at, position_id, exchange)
    VALUES (
      ${order.id}, ${order.coin}, ${order.side}, ${order.type}, ${order.price},
      ${order.size}, ${order.status}, ${order.setupId}, ${order.slPrice}, ${order.tpPrice}, ${order.cloid},
      ${order.exchangeOrderId}, ${new Date(order.createdAt)}, ${new Date(order.updatedAt)},
      ${order.fillPrice}, ${order.fillSize}, ${order.filledAt ? new Date(order.filledAt) : null},
      ${order.positionId}, ${order.exchange}
    )
  `;
}

/** Update order status + metadata in DB. */
async function updateOrderInDb(order: Order): Promise<void> {
  await sql`
    UPDATE orders SET
      status = ${order.status},
      cloid = ${order.cloid},
      exchange_order_id = ${order.exchangeOrderId},
      fill_price = ${order.fillPrice},
      fill_size = ${order.fillSize},
      filled_at = ${order.filledAt ? new Date(order.filledAt) : null},
      updated_at = ${new Date(order.updatedAt)},
      position_id = ${order.positionId}
    WHERE id = ${order.id}
  `;
}

/** Pending/submitted orders for a coin. */
async function getActiveOrdersForCoin(coin: string): Promise<Order[]> {
  const rows = await sql`
    SELECT * FROM orders
    WHERE coin = ${coin}
      AND status IN ('pending', 'submitted', 'partial')
    ORDER BY created_at DESC
  `;
  return rows.map(rowToOrder);
}

/** Get order by ID. */
async function getOrderById(orderId: string): Promise<Order | null> {
  if (!isValidOrderUuid(orderId)) {
    return null;
  }
  const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
  const first = rows[0];
  return first ? rowToOrder(first as Record<string, unknown>) : null;
}

/** Map DB row to Order type. */
function rowToOrder(row: Record<string, unknown>): Order {
  const exchange = (row.exchange as string) ?? "HL";
  const exchangeOrderId = (row.exchange_order_id as string) ?? null;
  const persistedCloid = typeof row.cloid === "string" ? row.cloid.trim() : "";
  // Legacy fallback: before `cloid` persistence, some HL rows stored cloid-like IDs in exchange_order_id.
  // Never apply this fallback to Bybit rows (orderId UUID must not be treated as cloid).
  const fallbackCloid =
    exchange === "HL" &&
    typeof exchangeOrderId === "string" &&
    exchangeOrderId.startsWith("0x")
      ? exchangeOrderId
      : null;
  const cloid =
    persistedCloid.length > 0 ? persistedCloid : (fallbackCloid ?? "");

  return {
    id: row.id as string,
    coin: row.coin as string,
    side: row.side as "long" | "short",
    type: row.type as "limit" | "market",
    price: row.price as number,
    size: row.size as number,
    status: row.status as OrderStatus,
    setupId: (row.setup_id as string) ?? null,
    slPrice: (row.sl_price as number) ?? null,
    tpPrice: (row.tp_price as number) ?? null,
    cloid,
    exchangeOrderId,
    createdAt: row.created_at
      ? new Date(row.created_at as string).getTime()
      : Date.now(),
    updatedAt: row.updated_at
      ? new Date(row.updated_at as string).getTime()
      : Date.now(),
    filledAt: row.filled_at
      ? new Date(row.filled_at as string).getTime()
      : null,
    fillPrice: (row.fill_price as number) ?? null,
    fillSize: (row.fill_size as number) ?? 0,
    positionId: (row.position_id as string) ?? null,
    exchange,
  };
}

// ─── OrderManager Class ─────────────────────────────────────────────────────

export class OrderManager {
  /** In-memory order cache — keyed by order ID. DB is source of truth. */
  private orders: Map<string, Order> = new Map();
  /** In-memory trigger orders — keyed by parent order ID. */
  private triggerOrders: Map<string, TriggerOrder[]> = new Map();
  /** Callback to dispatch events back to TradingAgent. */
  private dispatchToAgent: ((coin: string, event: AgentEvent) => void) | null =
    null;
  /** Callback to register position with PositionMonitor on fill. */
  private onPositionOpen:
    | ((params: {
        positionId: string;
        coin: string;
        side: "long" | "short";
        entryPrice: number;
        size: number;
        slPrice: number;
        tpPrice: number;
        entryOrderId: string;
        leverage: number;
        entryInterval?: import("../types.js").CandleInterval;
      }) => void)
    | null = null;
  /** Tracks entry interval per order (for thesis capture at fill time). */
  private orderIntervals: Map<string, import("../types.js").CandleInterval> =
    new Map();
  /** Shared exchange routing pool for the active runtime. */
  private exchangePool: ExchangePool | null = null;
  /** Guard concurrent reconciliation sweeps. */
  private reconcileInProgress = false;
  /** Last successful reconciliation timestamp (ms). */
  private lastReconcileAt = 0;
  /** Consecutive failed cancel retries keyed by order id. */
  private reconcileDriftCounts = new Map<string, number>();
  /** Orphan exchange alerts already emitted this session (dedupe). */
  private orphanAlertsSeen = new Set<string>();

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent) => void): void {
    this.dispatchToAgent = fn;
  }

  /** Set callback to register positions with PositionMonitor on order fill. */
  setPositionOpenCallback(
    fn: (params: {
      positionId: string;
      coin: string;
      side: "long" | "short";
      entryPrice: number;
      size: number;
      slPrice: number;
      tpPrice: number;
      entryOrderId: string;
      leverage: number;
      entryInterval?: import("../types.js").CandleInterval;
    }) => void,
  ): void {
    this.onPositionOpen = fn;
  }

  /** Set the shared exchange pool used by the runtime. */
  setExchangePool(pool: ExchangePool): void {
    this.exchangePool = pool;
  }

  /**
   * Get the active exchange service for the runtime.
   * Fallback to HL singleton is allowed only for HL/paper paths.
   * BB live mode must never silently route to HL singleton.
   */
  private getExchange(exchange?: ExchangeId): IExchangeService {
    if (this.exchangePool?.isInitialized()) {
      return this.exchangePool.get(exchange);
    }
    if (isBybitLiveMode()) {
      throw new Error(
        "OrderManager: ExchangePool must be initialized in BB live mode (HL fallback blocked)",
      );
    }
    return getExchangeService();
  }

  // ── Place Order ─────────────────────────────────────────────────────────

  /**
   * Place an entry order from an ActiveSetup.
   * 1. Check idempotency (no active order for this coin)
   * 2. Generate cloid
   * 3. Persist to DB as 'pending'
   * 4. Submit to exchange (stub)
   * 5. Update status to 'submitted' or 'rejected'
   */
  async placeOrder(setup: ActiveSetup): Promise<Order | null> {
    const { coin, side, entryPrice, slPrice, tpPrice } = setup;

    // Idempotency: 1 active entry order per coin
    const active = await getActiveOrdersForCoin(coin);
    if (active.length >= MAX_ORDERS_PER_COIN) {
      log.warn(
        "order-manager",
        `Blocked duplicate order for ${coin} — active order exists: ${active[0]?.id}`,
      );
      return null;
    }

    const svc = this.getExchange(setup.exchange);

    // Build order - compute position size if the setup did not specify one.
    let size = (setup.patternData.positionSizeCoins as number) ?? 0;
    if (size <= 0 && entryPrice > 0 && slPrice > 0) {
      const accountValue = svc.getCachedAccountValue?.() || SIMULATED_ACCOUNT;
      size = computePositionSize(
        accountValue,
        DEFAULT_RISK_PERCENT,
        entryPrice,
        slPrice,
      );
    }

    // HL minimum notional only — no notional cap vs margin×maxLeverage (real-money + paper).
    if (entryPrice > 0 && size > 0) {
      const notional = size * entryPrice;
      if (notional < HL_MIN_ORDER_NOTIONAL_USD) {
        size = HL_MIN_ORDER_NOTIONAL_USD / entryPrice;
        log.info(
          "order-manager",
          `Bumped ${coin} entry to HL min notional $${HL_MIN_ORDER_NOTIONAL_USD} (risk-sized notional was $${notional.toFixed(2)})`,
        );
      }
    }

    if (size <= 0 || entryPrice <= 0) {
      log.warn(
        "order-manager",
        `Skip ${coin}: invalid entry/size (size=${size} entry=${entryPrice} sl=${slPrice})`,
      );
      return null;
    }

    const now = Date.now();
    const cloid = generateCloid();
    const order: Order = {
      id: randomUUID(),
      coin,
      side,
      type: "limit", // default to limit for entry (GTC)
      price: entryPrice,
      size,
      status: "pending",
      setupId: setup.id,
      slPrice,
      tpPrice,
      cloid,
      exchangeOrderId: null,
      createdAt: now,
      updatedAt: now,
      filledAt: null,
      fillPrice: null,
      fillSize: 0,
      positionId: null,
      exchange: setup.exchange ?? "HL",
    };

    // Persist pending
    await insertOrder(order);
    this.orders.set(order.id, order);
    // Track entry interval for thesis capture at fill time
    this.orderIntervals.set(order.id, setup.interval);
    log.info(
      "order-manager",
      `Order created: ${order.id} ${coin} ${side} @ ${entryPrice} [cloid=${cloid.slice(0, 10)}...]`,
    );

    // Submit to exchange (or simulate in paper mode) — route to strategy-specific wallet

    // Set leverage before entry.
    // BB (Cross Margin): always use max leverage — entire account acts as collateral,
    //   setLeverage internally caps to the risk-tier max for the position size.
    // HL (Isolated Margin): compute from TARGET_MARGIN_PCT to bound per-position margin.
    if (svc && entryPrice > 0) {
      const sizeUsd = order.size * entryPrice;
      if (svc.exchangeId === "BB") {
        // Max leverage for cross margin — service caps at tier limit automatically
        const maxLev = svc.getMaxLeverage(coin) ?? 100;
        await svc.setLeverage(coin, maxLev, sizeUsd);
      } else {
        const accountValue = svc.getCachedAccountValue() || SIMULATED_ACCOUNT;
        const targetMarginUsd = accountValue * TARGET_MARGIN_PCT;
        const requiredLeverage = sizeUsd / targetMarginUsd;
        await svc.setLeverage(coin, requiredLeverage, sizeUsd);
      }
    }

    // Entry orders are limit by default (GTC). Market-style IoC entries are supported but not used by default.
    const submitPrice =
      order.type === "market"
        ? computeMarketRefPrice(coin, side, entryPrice)
        : entryPrice;

    // BB: attach SL/TP inline at order submission — position is protected from first fill tick,
    // eliminating the race window between fill detection and setTradingStop.
    // HL: SL/TP are separate trigger orders placed after fill (see placeSLTP).
    const inlineSlTp = svc?.exchangeId === "BB";
    const result = await submitToExchange(
      coin,
      side,
      order.type,
      submitPrice,
      order.size,
      cloid,
      svc,
      inlineSlTp ? (order.slPrice ?? undefined) : undefined,
      inlineSlTp ? (order.tpPrice ?? undefined) : undefined,
    );

    if (result.success) {
      order.status = "submitted";
      order.exchangeOrderId = result.exchangeOrderId;
      order.updatedAt = Date.now();
      await updateOrderInDb(order);
      this.orders.set(order.id, order);
      log.info(
        "order-manager",
        `Order submitted: ${order.id} exchangeId=${result.exchangeOrderId}`,
      );

      if (
        result.fillPrice !== undefined &&
        result.fillSize !== undefined &&
        result.fillSize > 0
      ) {
        // HL often returns immediate fill for market entry — same tick must place SL/TP (R9).
        await this.onOrderFilled(order.id, result.fillPrice, result.fillSize);
      }
    } else {
      order.status = "rejected";
      order.updatedAt = Date.now();
      await updateOrderInDb(order);
      this.orders.set(order.id, order);
      log.error("order-manager", `Order rejected by exchange: ${result.error}`);
      this.dispatchToAgent?.(coin, {
        type: "order_rejected",
        orderId: order.id,
        reason: result.error ?? "exchange_rejection",
      });
    }

    return order;
  }

  // ── Order Fill ──────────────────────────────────────────────────────────

  /**
   * Handle order fill notification (from exchange WS or poll).
   * Transitions order to 'filled', places SL/TP triggers (R9).
   */
  async onOrderFilled(
    orderId: string,
    fillPrice: number,
    fillSize: number,
  ): Promise<void> {
    const order = this.orders.get(orderId) ?? (await getOrderById(orderId));
    if (!order) {
      log.error("order-manager", `Fill for unknown order: ${orderId}`);
      return;
    }

    // Guard: skip if already filled (prevents double-dispatch in paper mode / WS race)
    if (order.status === "filled") {
      log.warn(
        "order-manager",
        `onOrderFilled skipped — order ${orderId} already filled`,
      );
      return;
    }

    const now = Date.now();
    order.status = "filled";
    order.fillPrice = fillPrice;
    order.filledAt = now;
    order.fillSize = fillSize;
    order.updatedAt = now;

    // Create position ID and store on order for reliable lookup
    const positionId = randomUUID();
    order.positionId = positionId;

    await updateOrderInDb(order);
    this.orders.set(order.id, order);

    log.info(
      "order-manager",
      `Order filled: ${order.id} ${order.coin} @ ${fillPrice} positionId=${positionId}`,
    );

    // R9: Place SL + TP trigger orders on exchange
    await this.placeSLTP(order);

    const svcForLev = this.getExchange();
    const accountValueForLev =
      svcForLev?.getCachedAccountValue() || SIMULATED_ACCOUNT;
    const sizeUsd = fillPrice * fillSize;
    const maxLev = svcForLev?.getMaxLeverage?.(order.coin);
    const leverage = computeEntryLeverageForTargetMargin(
      sizeUsd,
      accountValueForLev,
      TARGET_MARGIN_PCT,
      maxLev,
    );

    // Register position with PositionMonitor for tracking (trail stop, partial close, TUI display)
    if (order.slPrice !== null && order.tpPrice !== null) {
      const entryInterval = this.orderIntervals.get(order.id);
      this.onPositionOpen?.({
        positionId,
        coin: order.coin,
        side: order.side,
        entryPrice: fillPrice,
        size: fillSize,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        entryOrderId: order.id,
        leverage,
        ...(entryInterval != null && { entryInterval }),
      });
      // Clean up interval tracking
      this.orderIntervals.delete(order.id);
    }

    // Dispatch the fill event back to the agent state machine.
    this.dispatchToAgent?.(order.coin, {
      type: "order_filled",
      orderId: order.id,
      fillPrice,
      positionId,
    });
  }

  /**
   * Handle partial fill. Updates fill size but stays in ENTERING.
   * Full transition only on complete fill.
   * @param fillPrice Actual fill price from exchange (not the original order price).
   */
  async onPartialFill(
    orderId: string,
    filledSize: number,
    fillPrice?: number,
  ): Promise<void> {
    const order = this.orders.get(orderId) ?? (await getOrderById(orderId));
    if (!order) {
      log.error("order-manager", `Partial fill for unknown order: ${orderId}`);
      return;
    }

    if (
      order.status === "filled" ||
      order.status === "cancelled" ||
      order.status === "rejected"
    ) {
      return;
    }

    order.fillSize = filledSize;
    order.status = "partial";
    order.updatedAt = Date.now();
    await updateOrderInDb(order);
    this.orders.set(order.id, order);

    log.info(
      "order-manager",
      `Partial fill: ${order.id} ${order.coin} filled=${filledSize}/${order.size}`,
    );

    // If filled enough (>= requested), treat as full fill — use actual fill price
    if (filledSize >= order.size) {
      const actualPrice = fillPrice ?? order.fillPrice ?? order.price;
      await this.onOrderFilled(orderId, actualPrice, filledSize);
    }
  }

  // ── SL/TP Trigger Orders (R9) ──────────────────────────────────────────

  /**
   * R9: After entry fill, place SL (trigger-market) + TP (trigger-market) on HL.
   * Exchange-managed safety — protected even if agent dies.
   *
   * BB: SL/TP were already attached inline at order submission — skip to avoid
   * overriding the exchange-level protection with a redundant setTradingStop.
   */
  private async placeSLTP(entryOrder: Order): Promise<void> {
    if (!entryOrder.slPrice || !entryOrder.tpPrice) {
      log.warn(
        "order-manager",
        `No SL/TP prices for order ${entryOrder.id} — skipping trigger placement`,
      );
      return;
    }

    const svc = this.getExchange();
    if (svc?.exchangeId === "BB") {
      log.info(
        "order-manager",
        `SL/TP already set inline (BB): ${entryOrder.coin} sl=${entryOrder.slPrice} tp=${entryOrder.tpPrice}`,
      );
      return;
    }

    const closeSide: "long" | "short" =
      entryOrder.side === "long" ? "short" : "long";
    const triggers: TriggerOrder[] = [];

    // SL: trigger-market (guaranteed fill on stop hit)
    const slTrigger: TriggerOrder = {
      type: "sl",
      coin: entryOrder.coin,
      side: closeSide,
      triggerPrice: entryOrder.slPrice,
      size: entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size,
      isMarket: SL_IS_MARKET,
      cloid: generateCloid(),
      exchangeOrderId: null,
      parentOrderId: entryOrder.id,
    };
    const slResult = await this.placeTriggerWithRetry(
      slTrigger,
      "SL",
      entryOrder.coin,
      svc,
    );
    if (slResult.success) {
      slTrigger.exchangeOrderId = slResult.exchangeOrderId;
      log.info(
        "order-manager",
        `SL trigger placed: ${entryOrder.coin} @ ${entryOrder.slPrice} [${slResult.exchangeOrderId}]`,
      );
    } else {
      log.error(
        "order-manager",
        `SL trigger FAILED for ${entryOrder.coin} after retries: ${slResult.error}`,
      );
    }
    triggers.push(slTrigger);

    // TP: trigger-market (guaranteed fill on target hit)
    const tpTrigger: TriggerOrder = {
      type: "tp",
      coin: entryOrder.coin,
      side: closeSide,
      triggerPrice: entryOrder.tpPrice,
      size: entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size,
      isMarket: TP_IS_MARKET,
      cloid: generateCloid(),
      exchangeOrderId: null,
      parentOrderId: entryOrder.id,
    };
    const tpResult = await this.placeTriggerWithRetry(
      tpTrigger,
      "TP",
      entryOrder.coin,
      svc,
    );
    if (tpResult.success) {
      tpTrigger.exchangeOrderId = tpResult.exchangeOrderId;
      log.info(
        "order-manager",
        `TP trigger placed: ${entryOrder.coin} @ ${entryOrder.tpPrice} [${tpResult.exchangeOrderId}]`,
      );
    } else {
      log.error(
        "order-manager",
        `TP trigger FAILED for ${entryOrder.coin} after retries: ${tpResult.error}`,
      );
    }
    triggers.push(tpTrigger);

    this.triggerOrders.set(entryOrder.id, triggers);
  }

  /**
   * Place a trigger order with retry (S13: Self-Healing).
   * Retries up to RETRY.slTpMaxAttempts on transient errors, then gives up.
   */
  private async placeTriggerWithRetry(
    trigger: TriggerOrder,
    label: string,
    coin: string,
    exchangeSvc?: IExchangeService,
  ): Promise<ExchangeOrderResult> {
    const retryResult = await withRetry(
      async () => {
        const result = await placeTriggerOnExchange(trigger, exchangeSvc);
        if (!result.success) {
          // Check if the error is retryable — if not, throw non-retryable to break out
          const errMsg = result.error ?? "unknown error";
          if (!isRetryableExchangeError(new Error(errMsg))) {
            // Return the failed result directly (don't retry validation errors)
            return result;
          }
          throw new Error(errMsg);
        }
        return result;
      },
      {
        maxAttempts: RETRY.slTpMaxAttempts,
        initialDelayMs: RETRY.initialDelayMs,
        jitterFraction: RETRY.jitterFraction,
        shouldRetry: (err) => isRetryableExchangeError(err),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            "order-manager",
            `${label} trigger retry ${attempt} for ${coin}: ${msg} (backoff ${delayMs}ms)`,
          );
        },
      },
    );

    if (retryResult.success && retryResult.value) {
      return retryResult.value;
    }
    const msg =
      retryResult.lastError instanceof Error
        ? retryResult.lastError.message
        : String(retryResult.lastError);
    return { success: false, exchangeOrderId: null, error: msg };
  }

  // ── Cancel Order ───────────────────────────────────────────────────────

  /**
   * Cancel an unfilled order (timeout, invalidation, pause).
   * Idempotent — no-op if already cancelled/filled.
   */
  async cancelOrder(orderId: string, reason: string): Promise<void> {
    const order = this.orders.get(orderId) ?? (await getOrderById(orderId));
    if (!order) {
      log.warn("order-manager", `Cancel for unknown order: ${orderId}`);
      return;
    }

    // Already terminal — idempotent
    if (
      order.status === "filled" ||
      order.status === "cancelled" ||
      order.status === "rejected"
    ) {
      log.debug(
        "order-manager",
        `Cancel no-op: ${orderId} already ${order.status}`,
      );
      return;
    }

    // Cancel on exchange — route to the shared runtime wallet
    if (order.exchangeOrderId) {
      const svc = this.getExchange();
      let cancelResult = await cancelOnExchange(
        order.exchangeOrderId,
        order.coin,
        svc,
      );
      // Fallback: cancel by cloid when exchangeOrderId is invalid (e.g. Bybit stored "submitted")
      if (!cancelResult.success && order.cloid) {
        log.info("order-manager", `Retrying cancel by cloid for ${orderId}`);
        const retryResult = await svc.cancelByCloid(order.coin, order.cloid);
        cancelResult = {
          success: retryResult.success,
          exchangeOrderId: null,
          error: retryResult.error,
        };
      }
      if (!cancelResult.success) {
        // Exchange still holds the order — must NOT mark it cancelled locally,
        // otherwise reconciliation trusts a phantom state and the order ghosts.
        // checkTimeouts() will re-attempt on the next sweep for stale orders.
        log.error(
          "order-manager",
          `Exchange cancel failed for ${orderId} (will retry on next timeout sweep): ${cancelResult.error}`,
        );
        return;
      }
    }

    order.status = "cancelled";
    order.updatedAt = Date.now();
    await updateOrderInDb(order);
    this.orders.set(order.id, order);

    log.info("order-manager", `Order cancelled: ${orderId} reason=${reason}`);
  }

  // ── Modify SL/TP (for trailing stop) ──────────────────────────────────

  /**
   * Modify SL trigger order on exchange (used by PositionMonitor for trail stop).
   * S10: HL uses ExchangeService.modifyTrigger (or cancel+replace fallback).
   * BB uses position-level updatePositionStop (no trigger-order dependency).
   */
  async modifySLPrice(
    parentOrderId: string,
    newSlPrice: number,
  ): Promise<void> {
    const parentOrder = this.orders.get(parentOrderId);
    const svc = this.getExchange();

    if (svc.exchangeId === "BB") {
      if (!parentOrder) {
        log.warn(
          "order-manager",
          `No parent order for BB stop update ${parentOrderId}`,
        );
        return;
      }
      if (!supportsPositionStopUpdate(svc)) {
        log.error(
          "order-manager",
          "BB exchange service missing updatePositionStop()",
        );
        return;
      }

      const oldPrice = parentOrder.slPrice;
      try {
        const result = await svc.updatePositionStop({
          coin: parentOrder.coin,
          positionSide: parentOrder.side,
          triggerPrice: newSlPrice,
          tpsl: "sl",
        });
        if (result.success) {
          parentOrder.slPrice = newSlPrice;
          parentOrder.updatedAt = Date.now();
          this.orders.set(parentOrder.id, parentOrder);
          log.info(
            "order-manager",
            `BB position SL updated: ${parentOrder.coin} ${oldPrice ?? "-"} → ${newSlPrice}`,
          );
        } else {
          log.error(
            "order-manager",
            `BB position SL update failed: ${result.error}`,
          );
        }
      } catch (err) {
        log.error(
          "order-manager",
          `BB position SL update error: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    const triggers = this.triggerOrders.get(parentOrderId);
    if (!triggers) {
      log.warn("order-manager", `No triggers for order ${parentOrderId}`);
      return;
    }

    const slTrigger = triggers.find((t) => t.type === "sl");
    if (!slTrigger) {
      log.warn("order-manager", `No SL trigger for order ${parentOrderId}`);
      return;
    }

    const oldPrice = slTrigger.triggerPrice;
    slTrigger.triggerPrice = newSlPrice;

    // Try to modify on exchange if we have an oid
    if (slTrigger.exchangeOrderId) {
      const oid = parseInt(slTrigger.exchangeOrderId, 10);
      if (!Number.isNaN(oid)) {
        try {
          const result = await svc.modifyTrigger(
            slTrigger.coin,
            oid,
            slTrigger.side,
            newSlPrice,
            slTrigger.size,
            slTrigger.isMarket,
            "sl",
          );
          if (result.success) {
            log.info(
              "order-manager",
              `SL modified on exchange: ${slTrigger.coin} ${oldPrice} → ${newSlPrice}`,
            );
            return;
          }
          log.warn(
            "order-manager",
            `SL modify failed, trying cancel+replace: ${result.error}`,
          );
        } catch (err) {
          log.warn(
            "order-manager",
            `SL modify error, trying cancel+replace: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Fallback: cancel old + place new — route to the shared runtime wallet
      await cancelOnExchange(slTrigger.exchangeOrderId, slTrigger.coin, svc);
      const newResult = await placeTriggerOnExchange(slTrigger, svc);
      if (newResult.success) {
        slTrigger.exchangeOrderId = newResult.exchangeOrderId;
        log.info(
          "order-manager",
          `SL replaced on exchange: ${slTrigger.coin} ${oldPrice} → ${newSlPrice}`,
        );
      } else {
        log.error("order-manager", `SL replace failed: ${newResult.error}`);
      }
    } else {
      log.info(
        "order-manager",
        `SL updated in-memory: ${slTrigger.coin} ${oldPrice} → ${newSlPrice} (no exchange oid)`,
      );
    }
  }

  // ── Timeout Check ─────────────────────────────────────────────────────

  /**
   * Check all pending/submitted orders for timeout.
   * Called periodically by agent tick.
   */
  /**
   * Live: discover fills for entry orders that did not return inline `filled` (e.g. limit resting).
   * Called from PositionMonitor exchange sync (~10s). Immediate market fills are handled in {@link placeOrder}.
   */
  async syncSubmittedEntryFills(): Promise<void> {
    for (const [, order] of this.orders) {
      if (order.status !== "submitted" && order.status !== "partial") continue;
      const svc = this.getExchange();
      const hasCloid = order.cloid.trim().length > 0;
      let fill = hasCloid
        ? await svc.getFillAggregateByCloid(order.cloid, order.coin)
        : null;

      if (
        !fill &&
        order.exchangeOrderId &&
        typeof svc.getFillAggregateByOrderId === "function"
      ) {
        fill = await svc.getFillAggregateByOrderId(
          order.exchangeOrderId,
          order.coin,
        );
      }
      if (!fill || fill.totalSz <= 0) continue;

      // isFilled=true means the exchange confirms the order is fully done (e.g. Bybit
      // orderStatus='Filled'). Use it to avoid a false-partial when Bybit rounds the
      // submitted qty down to szDecimals and fills that smaller-but-exact amount.
      const eps = 1e-12;
      if (!fill.isFilled && fill.totalSz + eps < order.size) {
        await this.onPartialFill(order.id, fill.totalSz, fill.avgPx);
      } else {
        const sz = Math.min(fill.totalSz, order.size);
        await this.onOrderFilled(order.id, fill.avgPx, sz);
      }
    }
  }

  async checkTimeouts(): Promise<void> {
    const now = Date.now();
    for (const [, order] of this.orders) {
      if (order.status !== "pending" && order.status !== "submitted") continue;
      const age = now - order.createdAt;
      if (age > ORDER_FILL_TIMEOUT_MS) {
        log.info(
          "order-manager",
          `Order timeout: ${order.id} ${order.coin} age=${Math.round(age / 1000)}s`,
        );
        await this.cancelOrder(order.id, "timeout");
        this.dispatchToAgent?.(order.coin, {
          type: "order_timeout",
          orderId: order.id,
        });
      }
    }
  }

  // ── Order Reconciliation (P0 ghost-order loop) ─────────────────────────

  /** Load DB orders relevant for exchange reconciliation (active + recent cancelled). */
  private async fetchOrdersForReconciliation(): Promise<Order[]> {
    const exchange = getActiveExchange();
    const rows = await sql`
      SELECT * FROM orders
      WHERE exchange = ${exchange}
        AND (
          status IN ('pending', 'submitted', 'partial')
          OR (
            status = 'cancelled'
            AND exchange_order_id IS NOT NULL
            AND updated_at > NOW() - INTERVAL '24 hours'
          )
        )
    `;
    return rows.map((row) => rowToOrder(row as Record<string, unknown>));
  }

  /**
   * Periodic reconciliation: diff exchange open orders vs DB, retry failed cancels,
   * cancel exchange ghosts, alert on persistent drift / orphan orders.
   */
  async reconcileWithExchange(
    pendingByCoin: Map<string, string | null>,
  ): Promise<void> {
    if (this.reconcileInProgress) return;
    if (isPaperMode()) return;

    const now = Date.now();
    if (now - this.lastReconcileAt < ORDER_RECONCILE_INTERVAL_MS) return;

    this.reconcileInProgress = true;
    try {
      const svc = this.getExchange();
      const exchangeOrders = await svc.getOpenOrders();
      if (exchangeOrders === null) {
        log.warn(
          "order-manager",
          "getOpenOrders failed — skipping order reconciliation this cycle",
        );
        return;
      }

      const dbOrders = await this.fetchOrdersForReconciliation();
      const plan = planOrderReconciliation({
        dbOrders,
        exchangeOrders,
        pendingByCoin,
      });

      if (plan.length === 0) {
        this.lastReconcileAt = now;
        return;
      }

      log.info(
        "order-manager",
        `Order reconciliation plan: ${plan.length} action(s) (${exchangeOrders.length} exchange open, ${dbOrders.length} db rows)`,
      );

      for (const action of plan) {
        await this.executeReconcileAction(action);
      }

      this.lastReconcileAt = now;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("order-manager", `Order reconciliation failed: ${msg}`);
    } finally {
      this.reconcileInProgress = false;
    }
  }

  private async executeReconcileAction(
    action: OrderReconcileAction,
  ): Promise<void> {
    if (action.type === "retry_cancel") {
      const before = this.orders.get(action.orderId)?.status;
      await this.cancelOrder(action.orderId, action.reason);
      const after = this.orders.get(action.orderId)?.status;
      const succeeded = after === "cancelled";
      if (succeeded) {
        this.reconcileDriftCounts.delete(action.orderId);
        return;
      }
      const attempts = (this.reconcileDriftCounts.get(action.orderId) ?? 0) + 1;
      this.reconcileDriftCounts.set(action.orderId, attempts);
      if (attempts >= ORDER_RECONCILE_ALERT_THRESHOLD) {
        await this.alertOrderDrift({
          kind: "retry_cancel_failed",
          orderId: action.orderId,
          attempts,
          previousStatus: before ?? "unknown",
          currentStatus: after ?? "unknown",
        });
      }
      return;
    }

    if (action.type === "cancel_exchange") {
      const svc = this.getExchange();
      let cancelResult = await cancelOnExchange(
        action.exchangeOrderId,
        action.coin,
        svc,
      );
      if (!cancelResult.success && action.cloid) {
        const retry = await svc.cancelByCloid(action.coin, action.cloid);
        cancelResult = {
          success: retry.success,
          exchangeOrderId: null,
          error: retry.error,
        };
      }
      if (cancelResult.success) {
        log.warn(
          "order-manager",
          `Reconcile cancelled exchange ghost ${action.coin} oid=${action.exchangeOrderId}`,
        );
        this.reconcileDriftCounts.delete(
          `${action.coin}|${action.exchangeOrderId}`,
        );
        return;
      }
      const driftKey = `${action.coin}|${action.exchangeOrderId}`;
      const attempts = (this.reconcileDriftCounts.get(driftKey) ?? 0) + 1;
      this.reconcileDriftCounts.set(driftKey, attempts);
      if (attempts >= ORDER_RECONCILE_ALERT_THRESHOLD) {
        await this.alertOrderDrift({
          kind: "exchange_ghost_cancel_failed",
          coin: action.coin,
          exchangeOrderId: action.exchangeOrderId,
          attempts,
          error: cancelResult.error,
        });
      }
      return;
    }

    if (action.type === "alert") {
      const alertKey = `${action.coin ?? "unknown"}|${action.message}`;
      if (this.orphanAlertsSeen.has(alertKey)) return;
      this.orphanAlertsSeen.add(alertKey);
      log.warn("order-manager", `ORDER RECONCILE ALERT: ${action.message}`);
      await logJournalEntry("error", action.coin ?? null, {
        kind: "order_reconcile_orphan",
        message: action.message,
      });
    }
  }

  private async alertOrderDrift(
    details: Record<string, unknown>,
  ): Promise<void> {
    const orderId =
      typeof details.orderId === "string" ? details.orderId : undefined;
    const coin = typeof details.coin === "string" ? details.coin : null;
    const driftKey =
      orderId ?? `${String(details.coin)}|${String(details.exchangeOrderId)}`;
    if (this.orphanAlertsSeen.has(`drift|${driftKey}`)) return;
    this.orphanAlertsSeen.add(`drift|${driftKey}`);

    log.error(
      "order-manager",
      `ORDER RECONCILE DRIFT: ${JSON.stringify(details)}`,
    );
    await logJournalEntry("error", coin, {
      kind: "order_reconcile_drift",
      ...details,
    });
  }

  // ── Action Listener (from TradingAgent) ────────────────────────────────

  /**
   * Handle actions emitted by TradingAgent.
   * Wired via `agent.onAction(om.handleAction.bind(om))`.
   */
  async handleAction(action: AgentAction): Promise<void> {
    switch (action.type) {
      case "place_order": {
        const setup = action.setup;
        const order = await this.placeOrder(setup);
        if (order === null) {
          // placeOrder can skip (duplicate, min notional, sizing) — must unblock agent ENTERING
          this.dispatchToAgent?.(setup.coin, {
            type: "order_rejected",
            orderId: "",
            reason: "place_order_skipped",
          });
        } else if (order.status === "submitted" || order.status === "partial") {
          // Notify agent of submitted (resting limit) order so it can track pendingOrderId
          // for cancel on timeout/invalidation. Skip for filled (paper/immediate live fill —
          // agent already received order_filled) and rejected (agent already got order_rejected
          // from inside placeOrder — dispatching order_submitted would corrupt pendingOrderId).
          this.dispatchToAgent?.(setup.coin, {
            type: "order_submitted",
            orderId: order.id,
          });
        }
        break;
      }
      case "cancel_order":
        await this.cancelOrder(action.orderId, action.reason);
        break;
      case "close_position":
        // S7 (PositionMonitor) handles close. OrderManager places the close order.
        await this.closePosition(action.positionId, action.reason);
        break;
      case "update_stop":
        // Find the entry order for this position, update its SL trigger
        await this.updateStopForPosition(
          action.positionId,
          action.newStopPrice,
        );
        break;
      default:
        // Other actions (watch, log_journal, partial_close, none) not handled here
        break;
    }
  }

  // ── Close Position ────────────────────────────────────────────────────

  /**
   * Close a position by placing a market order in the opposite direction.
   * Also cancels any active SL/TP trigger orders.
   */
  private async closePosition(
    positionId: string,
    reason: string,
  ): Promise<void> {
    // Find the order that opened this position
    const entryOrder = this.findOrderByPositionContext(positionId);
    if (!entryOrder) {
      log.warn(
        "order-manager",
        `No entry order found for position ${positionId} — close deferred to S10 exchange sync`,
      );
      return;
    }

    // Route to strategy-specific exchange wallet
    const svc = this.getExchange();

    // Cancel SL/TP triggers
    const triggers = this.triggerOrders.get(entryOrder.id);
    if (triggers) {
      for (const trigger of triggers) {
        if (trigger.exchangeOrderId) {
          await cancelOnExchange(trigger.exchangeOrderId, trigger.coin, svc);
        }
      }
      this.triggerOrders.delete(entryOrder.id);
    }

    // Place close order (opposite side) — use entry fillPrice as reference (HL needs a valid price even for market orders)
    const closeSide: "long" | "short" =
      entryOrder.side === "long" ? "short" : "long";
    const closeSize =
      entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size;
    const refPrice = entryOrder.fillPrice ?? entryOrder.price;
    const cloid = generateCloid();
    const closeRef = computeMarketRefPrice(
      entryOrder.coin,
      closeSide,
      refPrice,
    );
    await submitToExchange(
      entryOrder.coin,
      closeSide,
      "market",
      closeRef,
      closeSize,
      cloid,
      svc,
    );

    log.info(
      "order-manager",
      `Position close submitted: ${entryOrder.coin} reason=${reason}`,
    );
  }

  /** Update SL trigger for a position (trail stop). */
  private async updateStopForPosition(
    positionId: string,
    newStopPrice: number,
  ): Promise<void> {
    const entryOrder = this.findOrderByPositionContext(positionId);
    if (!entryOrder) return;
    await this.modifySLPrice(entryOrder.id, newStopPrice);
  }

  /**
   * Find the filled entry order associated with a position.
   * Matches by positionId (stored on order at fill time).
   * Falls back to coin match for backward compatibility.
   */
  private findOrderByPositionContext(positionId: string): Order | null {
    // Primary: match by positionId stored on the order at fill time
    for (const [, order] of this.orders) {
      if (order.status === "filled" && order.positionId === positionId) {
        return order;
      }
    }
    // No match — position not found
    log.warn(
      "order-manager",
      `findOrderByPositionContext: no filled order with positionId=${positionId}`,
    );
    return null;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /** Get an order by ID (from cache or DB). */
  async getOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? (await getOrderById(orderId));
  }

  /** Get all cached orders. */
  getOrders(): Map<string, Order> {
    return new Map(this.orders);
  }

  /** Get trigger orders for a parent entry order. */
  getTriggerOrders(parentOrderId: string): TriggerOrder[] {
    return this.triggerOrders.get(parentOrderId) ?? [];
  }

  /** Load active orders from DB into cache (startup recovery). */
  async loadActiveOrders(): Promise<void> {
    const exchange = getActiveExchange();
    const rows = await sql`
      SELECT * FROM orders
      WHERE status IN ('pending', 'submitted', 'partial', 'filled')
        AND exchange = ${exchange}
    `;
    for (const row of rows) {
      const order = rowToOrder(row);
      this.orders.set(order.id, order);
    }
    log.info(
      "order-manager",
      `Loaded ${rows.length} active orders from DB [exchange=${exchange}]`,
    );

    // Reconcile: cancel stale pending/submitted orders from previous runs.
    // These are phantom orders that never completed — the bot crashed or was
    // restarted before the order lifecycle finished.  Without this, the
    // idempotency guard blocks all new entries for the affected coin.
    await this.reconcileStaleOrders();
  }

  /**
   * Cancel pending/submitted orders older than ORDER_FILL_TIMEOUT_MS.
   * Called once at startup after loadActiveOrders().
   *
   * - pending with no exchange_order_id: never made it to exchange (crash mid-submit)
   * - submitted older than timeout: exchange likely expired/cancelled it already
   *
   * Filled orders are NOT touched — restoreOpenPositions handles those separately.
   */
  private async reconcileStaleOrders(): Promise<void> {
    const now = Date.now();
    let cancelled = 0;
    for (const [, order] of this.orders) {
      if (order.status !== "pending" && order.status !== "submitted") continue;
      const age = now - order.createdAt;
      // Pending with no exchange ID → never submitted (crash). Cancel immediately.
      // Submitted but older than timeout → stale. Cancel.
      if (
        (order.status === "pending" && !order.exchangeOrderId) ||
        age > ORDER_FILL_TIMEOUT_MS
      ) {
        order.status = "cancelled";
        order.updatedAt = now;
        await updateOrderInDb(order);
        this.orders.set(order.id, order);
        log.info(
          "order-manager",
          `Reconciled stale order: ${order.id} ${order.coin} age=${Math.round(age / 1000)}s → cancelled`,
        );
        cancelled++;
      }
    }
    if (cancelled > 0) {
      log.info(
        "order-manager",
        `Reconciled ${cancelled} stale order(s) at startup`,
      );
    }
  }

  /**
   * Restore open position tracking after restart (crash recovery).
   *
   * PositionMonitor state is in-memory and lost on restart. Without this, positions
   * placed before restart appear as "ext" (no strategy) in the TUI because there is
   * no tracked entry to match against the exchange snapshot.
   *
   * For each coin that still has an open position on the exchange, finds the most
   * recent filled order in the DB and re-registers it with PositionMonitor via the
   * onPositionOpen callback. Leverage is set to 0 so the TUI merge falls back to
   * the exchange-reported leverage (match.leverage > 0 check in tui-positions.ts).
   *
   * Called once at startup, after setPositionOpenCallback is wired.
   */
  restoreOpenPositions(exchangeSnaps: ExchangePositionSnapshot[]): void {
    // Build set of coins currently open on exchange
    const openCoins = new Set<string>();
    for (const snap of exchangeSnaps) {
      if (snap.size !== 0) openCoins.add(snap.coin);
    }
    if (openCoins.size === 0) return;

    // For each open coin, find the most recent filled order in our cache
    const latestByCoin = new Map<string, Order>();
    for (const [, order] of this.orders) {
      if (order.status !== "filled") continue;
      if (!order.positionId || !order.fillPrice) continue;
      if (!openCoins.has(order.coin)) continue;
      const existing = latestByCoin.get(order.coin);
      const orderTs = order.filledAt ?? order.updatedAt;
      const existingTs = existing
        ? (existing.filledAt ?? existing.updatedAt)
        : 0;
      if (!existing || orderTs > existingTs)
        latestByCoin.set(order.coin, order);
    }

    let restored = 0;
    for (const [, order] of latestByCoin) {
      this.onPositionOpen?.({
        // biome-ignore lint/style/noNonNullAssertion: recovery path; orders from journal have ids when relevant
        positionId: order.positionId!,
        coin: order.coin,
        side: order.side,
        // biome-ignore lint/style/noNonNullAssertion: recovery (see above)
        entryPrice: order.fillPrice!,
        size: order.size, // fillSize not persisted; original size is close enough for trail/TUI
        slPrice: order.slPrice ?? 0,
        tpPrice: order.tpPrice ?? 0,
        entryOrderId: order.id,
        leverage: 0, // unknown at restore time; TUI merge uses exchange value as fallback
      });
      restored++;
    }

    if (restored > 0) {
      log.info(
        "order-manager",
        `Restored ${restored} open position(s) into PositionMonitor after restart`,
      );
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: OrderManager | null = null;

/** Get or create the singleton OrderManager. */
export function getOrderManager(): OrderManager {
  if (!instance) {
    instance = new OrderManager();
  }
  return instance;
}

/** Reset OrderManager (tests only). */
export function resetOrderManager(): void {
  instance = null;
}
