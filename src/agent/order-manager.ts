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

import { randomUUID } from 'crypto'
import type { ActiveSetup, ExchangeId } from '../types.js'
import type {
  Order,
  OrderStatus,
  TriggerOrder,
  ExchangeOrderResult,
  AgentAction,
  AgentEvent,
  ExchangePositionSnapshot,
} from './types.js'
import { sql } from '../db/connection.js'
import {
  ORDER_FILL_TIMEOUT_MS,
  MAX_ORDERS_PER_COIN,
  SL_IS_MARKET,
  TP_IS_MARKET,
  RETRY,
  getEffectivePaperTrade,
  PAPER_SLIPPAGE_PCT,
  HL_MIN_ORDER_NOTIONAL_USD,
  MARKET_ORDER_SLIPPAGE_PCT,
} from '../config.js'
import { getExchangeService, type ExchangeService } from '../execution/exchange-service.js'
import type { ExchangePool, IExchangeService } from '../execution/exchange-pool.js'
import { getLatestBook } from '../feed/orderbook.js'
import { log } from '../lib/logger.js'
import { withRetry, isRetryableExchangeError } from '../lib/retry.js'
import { getPaperTracker } from './paper-tracker.js'
import {
  computeEntryLeverageForTargetMargin,
  computePositionSize,
} from './exits.js'
import { DEFAULT_RISK_PERCENT, SIMULATED_ACCOUNT, TARGET_MARGIN_PCT, getActiveExchange, ATR_TRAIL_MULTIPLIER } from '../config.js'

/** Default strategy ID for backward compatibility (single-strategy mode). */
const DEFAULT_STRATEGY = 'smc-sd'

/** `orders.id` is UUID — reject malformed strings before querying to avoid PostgreSQL ERROR logs. */
function isValidOrderUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function clampPositiveFinite(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isBybitLiveMode(): boolean {
  if (getEffectivePaperTrade()) return false
  try {
    return getActiveExchange() === 'BB'
  } catch {
    // Backward-compat for tests/scripts that don't set ACTIVE_EXCHANGE.
    return false
  }
}

/**
 * HL "market" is an IOC-like aggressive limit that requires a reference price.
 * Use latest L2 mid when available to avoid stale-candle price rejects.
 */
function computeMarketRefPrice(coin: string, side: 'long' | 'short', fallbackPrice: number): number {
  const book = getLatestBook(coin)
  const bestBid = book?.bids?.[0]?.[0]
  const bestAsk = book?.asks?.[0]?.[0]
  const mid = (typeof bestBid === 'number' && typeof bestAsk === 'number' && bestBid > 0 && bestAsk > 0)
    ? (bestBid + bestAsk) / 2
    : null
  const base = clampPositiveFinite(mid ?? fallbackPrice, fallbackPrice)
  const slip = MARKET_ORDER_SLIPPAGE_PCT
  return side === 'long' ? base * (1 + slip) : base * (1 - slip)
}

// ─── Cloid Generation ───────────────────────────────────────────────────────

/** Generate a 128-bit hex client order ID for HL idempotency. */
export function generateCloid(): string {
  // UUID v4 → strip dashes → prefix 0x
  return '0x' + randomUUID().replace(/-/g, '')
}

// ─── Exchange Wrappers (S10: real HL calls via ExchangeService) ────────────

/**
 * Submit order to exchange via ExchangeService.
 * Returns ExchangeOrderResult with exchangeOrderId = HL oid (as string).
 */
export async function submitToExchange(
  coin: string,
  side: 'long' | 'short',
  type: 'limit' | 'market',
  price: number,
  size: number,
  cloid: string,
  svc?: IExchangeService,
  slPrice?: number,
  tpPrice?: number,
): Promise<ExchangeOrderResult> {
  try {
    const exchange = svc ?? getExchangeService()
    const result = await exchange.placeOrder({
      coin,
      side,
      type,
      price,
      size,
      reduceOnly: false,
      cloid,
      slPrice,
      tpPrice,
    })
    if (result.success) {
      // Prefer rawOrderId (Bybit UUID) > oid (HL numeric) > status fallback
      const exchangeId = result.rawOrderId ?? (result.oid !== null ? String(result.oid) : result.status)
      const out: ExchangeOrderResult = { success: true, exchangeOrderId: exchangeId, error: null }
      // Some entries may return `filled` inline — required so live mode runs onOrderFilled → SL/TP (R9).
      if (result.status === 'filled' && result.avgPx !== null && result.totalSz !== null) {
        out.fillPrice = result.avgPx
        out.fillSize = result.totalSz
      }
      return out
    }
    return { success: false, exchangeOrderId: null, error: result.error }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, exchangeOrderId: null, error: msg }
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
    const exchange = svc ?? getExchangeService()
    const oid = parseInt(exchangeOrderId, 10)

    // If we have a valid oid and coin, cancel by oid (preferred)
    if (!isNaN(oid) && coin) {
      const result = await exchange.cancelByOid(coin, oid)
      return { success: result.success, exchangeOrderId: null, error: result.error }
    }

    // Fallback: if exchangeOrderId looks like a cloid (0x...) and coin is available
    if (exchangeOrderId.startsWith('0x') && coin) {
      const result = await exchange.cancelByCloid(coin, exchangeOrderId)
      return { success: result.success, exchangeOrderId: null, error: result.error }
    }

    // Bybit path: orderId is UUID-format string (e.g. "be411c88-...") returned by submitOrder.
    // Route through cancelByOrderId which dispatches correctly per exchange type.
    if (coin) {
      const result = await exchange.cancelByOrderId(coin, exchangeOrderId)
      return { success: result.success, exchangeOrderId: null, error: result.error }
    }

    log.warn('order-manager', `cancelOnExchange: cannot cancel without valid oid or cloid+coin (id=${exchangeOrderId})`)
    return { success: false, exchangeOrderId: null, error: 'Missing coin for cancel' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, exchangeOrderId: null, error: msg }
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
    const exchange = svc ?? getExchangeService()
    const result = await exchange.placeTrigger({
      coin: trigger.coin,
      side: trigger.side,
      triggerPrice: trigger.triggerPrice,
      size: trigger.size,
      isMarket: trigger.isMarket,
      tpsl: trigger.type,
      cloid: trigger.cloid,
    })
    if (result.success) {
      const exchangeId = result.oid !== null ? String(result.oid) : result.status
      return { success: true, exchangeOrderId: exchangeId, error: null }
    }
    return { success: false, exchangeOrderId: null, error: result.error }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, exchangeOrderId: null, error: msg }
  }
}

// ─── Paper Trade Simulation ─────────────────────────────────────────────────

/**
 * Simulate a fill for paper trade mode.
 * Applies slippage: longs fill slightly higher, shorts fill slightly lower.
 * @internal Exported for testing.
 */
export function paperSimulateFill(
  coin: string,
  side: 'long' | 'short',
  price: number,
  size: number,
  cloid: string,
): ExchangeOrderResult {
  const slippageDir = side === 'long' ? 1 : -1
  const fillPrice = price * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
  log.info('order-manager', `[PAPER] Simulated fill: ${coin} ${side} ${size} @ ${fillPrice.toFixed(2)} (slippage ${(PAPER_SLIPPAGE_PCT * 100).toFixed(3)}%)`)
  return { success: true, exchangeOrderId: `paper_${cloid.slice(0, 16)}`, error: null }
}

/** Simulate cancel for paper trade mode. Always succeeds. @internal */
export function paperSimulateCancel(exchangeOrderId: string, coin?: string): ExchangeOrderResult {
  log.info('order-manager', `[PAPER] Simulated cancel: ${coin ?? 'unknown'} orderId=${exchangeOrderId}`)
  return { success: true, exchangeOrderId: null, error: null }
}

/** Simulate trigger placement for paper trade mode. Always succeeds. @internal */
export function paperSimulateTrigger(trigger: TriggerOrder): ExchangeOrderResult {
  log.info('order-manager', `[PAPER] Simulated ${trigger.type.toUpperCase()} trigger: ${trigger.coin} @ ${trigger.triggerPrice}`)
  return { success: true, exchangeOrderId: `paper_trigger_${generateCloid().slice(0, 12)}`, error: null }
}

// ─── DB Operations ──────────────────────────────────────────────────────────

/** Insert a new order into the database. */
async function insertOrder(order: Order): Promise<void> {
  await sql`
    INSERT INTO orders (id, coin, side, type, price, size, status, setup_id, sl_price, tp_price, exchange_order_id, created_at, updated_at, fill_price, filled_at, strategy_id, position_id, exchange)
    VALUES (
      ${order.id}, ${order.coin}, ${order.side}, ${order.type}, ${order.price},
      ${order.size}, ${order.status}, ${order.setupId}, ${order.slPrice}, ${order.tpPrice},
      ${order.exchangeOrderId}, ${new Date(order.createdAt)}, ${new Date(order.updatedAt)},
      ${order.fillPrice}, ${order.filledAt ? new Date(order.filledAt) : null},
      ${order.strategyId}, ${order.positionId}, ${order.exchange}
    )
  `
}

/** Update order status + metadata in DB. */
async function updateOrderInDb(order: Order): Promise<void> {
  await sql`
    UPDATE orders SET
      status = ${order.status},
      exchange_order_id = ${order.exchangeOrderId},
      fill_price = ${order.fillPrice},
      filled_at = ${order.filledAt ? new Date(order.filledAt) : null},
      updated_at = ${new Date(order.updatedAt)},
      position_id = ${order.positionId}
    WHERE id = ${order.id}
  `
}

/**
 * Pending/submitted orders for a coin **and** strategy.
 * Multi-wallet / multi-strategy: same coin may have one active entry per strategyId (V7).
 */
async function getActiveOrdersForCoinAndStrategy(
  coin: string,
  strategyId: string,
): Promise<Order[]> {
  const rows = await sql`
    SELECT * FROM orders
    WHERE coin = ${coin}
      AND strategy_id = ${strategyId}
      AND status IN ('pending', 'submitted', 'partial')
    ORDER BY created_at DESC
  `
  return rows.map(rowToOrder)
}

/** Get order by ID. */
async function getOrderById(orderId: string): Promise<Order | null> {
  if (!isValidOrderUuid(orderId)) {
    return null
  }
  const rows = await sql`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`
  const first = rows[0]
  return first ? rowToOrder(first as Record<string, unknown>) : null
}

/** Map DB row to Order type. */
function rowToOrder(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    coin: row.coin as string,
    side: row.side as 'long' | 'short',
    type: row.type as 'limit' | 'market',
    price: row.price as number,
    size: row.size as number,
    status: row.status as OrderStatus,
    setupId: (row.setup_id as string) ?? null,
    slPrice: (row.sl_price as number) ?? null,
    tpPrice: (row.tp_price as number) ?? null,
    cloid: (row.exchange_order_id as string) ?? '',  // temporary until cloid column exists
    exchangeOrderId: (row.exchange_order_id as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at as string).getTime() : Date.now(),
    filledAt: row.filled_at ? new Date(row.filled_at as string).getTime() : null,
    fillPrice: (row.fill_price as number) ?? null,
    fillSize: 0,  // TODO: add fill_size column in S10 migration
    strategyId: (row.strategy_id as string) ?? DEFAULT_STRATEGY,
    positionId: (row.position_id as string) ?? null,
    exchange: (row.exchange as string) ?? 'HL',
  }
}

// ─── OrderManager Class ─────────────────────────────────────────────────────

export class OrderManager {
  /** In-memory order cache — keyed by order ID. DB is source of truth. */
  private orders: Map<string, Order> = new Map()
  /** In-memory trigger orders — keyed by parent order ID. */
  private triggerOrders: Map<string, TriggerOrder[]> = new Map()
  /** Callback to dispatch events back to TradingAgent (with strategyId). */
  private dispatchToAgent: ((coin: string, event: AgentEvent, strategyId?: string) => void) | null = null
  /** Callback to register position with PositionMonitor on fill. */
  private onPositionOpen: ((params: { positionId: string; coin: string; side: 'long' | 'short'; entryPrice: number; size: number; slPrice: number; tpPrice: number; entryOrderId: string; leverage: number; strategyId?: string }) => void) | null = null
  /** ExchangePool for per-strategy exchange routing (Sprint 4.5). */
  private exchangePool: ExchangePool | null = null

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent, strategyId?: string) => void): void {
    this.dispatchToAgent = fn
  }

  /** Set callback to register positions with PositionMonitor on order fill. */
  setPositionOpenCallback(fn: (params: { positionId: string; coin: string; side: 'long' | 'short'; entryPrice: number; size: number; slPrice: number; tpPrice: number; entryOrderId: string; leverage: number; strategyId?: string }) => void): void {
    this.onPositionOpen = fn
  }

  /** Set the ExchangePool for per-strategy exchange routing (Sprint 4.5). */
  setExchangePool(pool: ExchangePool): void {
    this.exchangePool = pool
  }

  /**
   * Get exchange service for a strategy.
   * Fallback to HL singleton is allowed only for HL/paper paths.
   * BB live mode must never silently route to HL singleton.
   */
  private getExchangeForStrategy(strategyId: string, exchange?: ExchangeId): IExchangeService {
    if (this.exchangePool?.isInitialized()) {
      return this.exchangePool.get(strategyId, exchange)
    }
    if (isBybitLiveMode()) {
      throw new Error('OrderManager: ExchangePool must be initialized in BB live mode (HL fallback blocked)')
    }
    return getExchangeService()
  }

  // ── Place Order ─────────────────────────────────────────────────────────

  /**
   * Place an entry order from an ActiveSetup.
   * 1. Check idempotency (no active order for this coin + strategyId)
   * 2. Generate cloid
   * 3. Persist to DB as 'pending'
   * 4. Submit to exchange (stub)
   * 5. Update status to 'submitted' or 'rejected'
   */
  async placeOrder(setup: ActiveSetup): Promise<Order | null> {
    const { coin, side, entryPrice, slPrice, tpPrice } = setup
    const strategyId = setup.strategyId ?? DEFAULT_STRATEGY

    // Idempotency: 1 active entry order per (coin, strategyId)
    const active = await getActiveOrdersForCoinAndStrategy(coin, strategyId)
    if (active.length >= MAX_ORDERS_PER_COIN) {
      log.warn(
        'order-manager',
        `Blocked duplicate order for ${coin} [${strategyId}] — active order exists: ${active[0]?.id}`,
      )
      return null
    }

    const svc = this.getExchangeForStrategy(strategyId, setup.exchange)

    // Build order — compute position size if not provided (quant/smc-sd don't set it)
    let size = setup.patternData.positionSizeCoins as number ?? 0
    if (size <= 0 && entryPrice > 0 && slPrice > 0) {
      const accountValue = getEffectivePaperTrade()
        ? getPaperTracker(strategyId).getBalance()
        : (svc.getCachedAccountValue?.() || SIMULATED_ACCOUNT)
      size = computePositionSize(accountValue, DEFAULT_RISK_PERCENT, entryPrice, slPrice)
    }

    // HL minimum notional only — no notional cap vs margin×maxLeverage (real-money + paper).
    if (entryPrice > 0 && size > 0) {
      const notional = size * entryPrice
      if (notional < HL_MIN_ORDER_NOTIONAL_USD) {
        size = HL_MIN_ORDER_NOTIONAL_USD / entryPrice
        log.info(
          'order-manager',
          `Bumped ${coin} entry to HL min notional $${HL_MIN_ORDER_NOTIONAL_USD} (risk-sized notional was $${notional.toFixed(2)})`,
        )
      }
    }

    if (size <= 0 || entryPrice <= 0) {
      log.warn(
        'order-manager',
        `Skip ${coin} [${strategyId}]: invalid entry/size (size=${size} entry=${entryPrice} sl=${slPrice})`,
      )
      return null
    }

    const now = Date.now()
    const cloid = generateCloid()
    const order: Order = {
      id: randomUUID(),
      coin,
      side,
      type: 'limit',  // default to limit for entry (GTC)
      price: entryPrice,
      size,
      status: 'pending',
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
      strategyId,
      positionId: null,
      exchange: setup.exchange ?? 'HL',
    }

    // Persist pending
    await insertOrder(order)
    this.orders.set(order.id, order)
    log.info('order-manager', `Order created: ${order.id} ${coin} ${side} @ ${entryPrice} strategy=${strategyId} [cloid=${cloid.slice(0, 10)}...]`)

    // Submit to exchange (or simulate in paper mode) — route to strategy-specific wallet

    // Set leverage before entry.
    // BB (Cross Margin): always use max leverage — entire account acts as collateral,
    //   setLeverage internally caps to the risk-tier max for the position size.
    // HL (Isolated Margin): compute from TARGET_MARGIN_PCT to bound per-position margin.
    if (!getEffectivePaperTrade() && svc && entryPrice > 0) {
      const sizeUsd = order.size * entryPrice
      if (svc.exchangeId === 'BB') {
        // Max leverage for cross margin — service caps at tier limit automatically
        const maxLev = svc.getMaxLeverage(coin) ?? 100
        await svc.setLeverage(coin, maxLev, sizeUsd)
      } else {
        const accountValue = svc.getCachedAccountValue() || SIMULATED_ACCOUNT
        const targetMarginUsd = accountValue * TARGET_MARGIN_PCT
        const requiredLeverage = sizeUsd / targetMarginUsd
        await svc.setLeverage(coin, requiredLeverage, sizeUsd)
      }
    }

    // Entry orders are limit by default (GTC). Market-style IoC entries are supported but not used by default.
    const submitPrice = order.type === 'market'
      ? computeMarketRefPrice(coin, side, entryPrice)
      : entryPrice

    // BB: attach SL/TP inline at order submission — position is protected from first fill tick,
    // eliminating the race window between fill detection and setTradingStop.
    // HL: SL/TP are separate trigger orders placed after fill (see placeSLTP).
    const inlineSlTp = !getEffectivePaperTrade() && svc?.exchangeId === 'BB'
    const result = getEffectivePaperTrade()
      ? paperSimulateFill(coin, side, entryPrice, order.size, cloid)
      : await submitToExchange(
          coin, side, order.type, submitPrice, order.size, cloid, svc,
          inlineSlTp ? order.slPrice ?? undefined : undefined,
          inlineSlTp ? order.tpPrice ?? undefined : undefined,
        )

    if (result.success) {
      order.status = 'submitted'
      order.exchangeOrderId = result.exchangeOrderId
      order.updatedAt = Date.now()
      await updateOrderInDb(order)
      this.orders.set(order.id, order)
      log.info('order-manager', `Order submitted: ${order.id} exchangeId=${result.exchangeOrderId}`)

      // Paper mode: auto-fill immediately (no exchange WS to notify us)
      if (getEffectivePaperTrade()) {
        const slippageDir = side === 'long' ? 1 : -1
        const paperFillPrice = entryPrice * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
        const paperTracker = getPaperTracker(strategyId)

        // Correlation guard for paper mode (mirrors live TradingAgent check)
        const corrCheck = paperTracker.canEnter(coin)
        if (corrCheck.blocked) {
          log.info('order-manager', `[PAPER] Blocked by correlation guard: ${corrCheck.reason}`)
          order.status = 'rejected'
          order.updatedAt = Date.now()
          await updateOrderInDb(order)
          return order
        }

        // Enhanced entry with multi-TP tracking (matches backtest simulator)
        const tp2Price = (setup.patternData['tp2Price'] as number | undefined) ?? tpPrice
        const atrVal = (setup.patternData['atrAtEntry'] as number | undefined) ?? 0
        const trailMult = ATR_TRAIL_MULTIPLIER[setup.interval] ?? 2.0

        paperTracker.recordEntryEnhanced({
          orderId: order.id, coin, side,
          entryPrice: paperFillPrice,
          size: order.size,
          interval: setup.interval,
          slPrice: slPrice ?? paperFillPrice,
          tp1Price: tpPrice ?? paperFillPrice,
          tp2Price: tp2Price ?? tpPrice ?? paperFillPrice,
          atrValue: atrVal,
          trailMultiplier: trailMult,
        })
        await this.onOrderFilled(order.id, paperFillPrice, order.size)
      } else if (
        result.fillPrice !== undefined &&
        result.fillSize !== undefined &&
        result.fillSize > 0
      ) {
        // Live: HL often returns immediate fill for market entry — same tick must place SL/TP (R9).
        await this.onOrderFilled(order.id, result.fillPrice, result.fillSize)
      }
    } else {
      order.status = 'rejected'
      order.updatedAt = Date.now()
      await updateOrderInDb(order)
      this.orders.set(order.id, order)
      log.error('order-manager', `Order rejected by exchange: ${result.error}`)
      this.dispatchToAgent?.(coin, { type: 'order_rejected', orderId: order.id, reason: result.error ?? 'exchange_rejection' }, strategyId)
    }

    return order
  }

  // ── Order Fill ──────────────────────────────────────────────────────────

  /**
   * Handle order fill notification (from exchange WS or poll).
   * Transitions order to 'filled', places SL/TP triggers (R9).
   */
  async onOrderFilled(orderId: string, fillPrice: number, fillSize: number): Promise<void> {
    const order = this.orders.get(orderId) ?? await getOrderById(orderId)
    if (!order) {
      log.error('order-manager', `Fill for unknown order: ${orderId}`)
      return
    }

    // Guard: skip if already filled (prevents double-dispatch in paper mode / WS race)
    if (order.status === 'filled') {
      log.warn('order-manager', `onOrderFilled skipped — order ${orderId} already filled`)
      return
    }

    const now = Date.now()
    order.status = 'filled'
    order.fillPrice = fillPrice
    order.filledAt = now
    order.fillSize = fillSize
    order.updatedAt = now

    // Create position ID and store on order for reliable lookup
    const positionId = randomUUID()
    order.positionId = positionId

    await updateOrderInDb(order)
    this.orders.set(order.id, order)

    log.info('order-manager', `Order filled: ${order.id} ${order.coin} @ ${fillPrice} positionId=${positionId}`)

    // R9: Place SL + TP trigger orders on exchange
    await this.placeSLTP(order)

    const svcForLev = this.getExchangeForStrategy(order.strategyId)
    const accountValueForLev = getEffectivePaperTrade()
      ? getPaperTracker(order.strategyId).getBalance()
      : (svcForLev?.getCachedAccountValue() || SIMULATED_ACCOUNT)
    const sizeUsd = fillPrice * fillSize
    const maxLev = svcForLev?.getMaxLeverage?.(order.coin)
    const leverage = computeEntryLeverageForTargetMargin(
      sizeUsd,
      accountValueForLev,
      TARGET_MARGIN_PCT,
      maxLev,
    )

    // Register position with PositionMonitor for tracking (trail stop, partial close, TUI display)
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
      strategyId: order.strategyId,
    })

    // Dispatch to agent (with strategyId for correct routing)
    this.dispatchToAgent?.(order.coin, {
      type: 'order_filled',
      orderId: order.id,
      fillPrice,
      positionId,
    }, order.strategyId)
  }

  /**
   * Handle partial fill. Updates fill size but stays in ENTERING.
   * Full transition only on complete fill.
   * @param fillPrice Actual fill price from exchange (not the original order price).
   */
  async onPartialFill(orderId: string, filledSize: number, fillPrice?: number): Promise<void> {
    const order = this.orders.get(orderId) ?? await getOrderById(orderId)
    if (!order) {
      log.error('order-manager', `Partial fill for unknown order: ${orderId}`)
      return
    }

    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return
    }

    order.fillSize = filledSize
    order.status = 'partial'
    order.updatedAt = Date.now()
    await updateOrderInDb(order)
    this.orders.set(order.id, order)

    log.info('order-manager', `Partial fill: ${order.id} ${order.coin} filled=${filledSize}/${order.size}`)

    // If filled enough (>= requested), treat as full fill — use actual fill price
    if (filledSize >= order.size) {
      const actualPrice = fillPrice ?? order.fillPrice ?? order.price
      await this.onOrderFilled(orderId, actualPrice, filledSize)
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
      log.warn('order-manager', `No SL/TP prices for order ${entryOrder.id} — skipping trigger placement`)
      return
    }

    const svc = this.getExchangeForStrategy(entryOrder.strategyId)
    if (!getEffectivePaperTrade() && svc?.exchangeId === 'BB') {
      log.info('order-manager', `SL/TP already set inline (BB): ${entryOrder.coin} sl=${entryOrder.slPrice} tp=${entryOrder.tpPrice}`)
      return
    }

    const closeSide: 'long' | 'short' = entryOrder.side === 'long' ? 'short' : 'long'
    const triggers: TriggerOrder[] = []

    // SL: trigger-market (guaranteed fill on stop hit)
    const slTrigger: TriggerOrder = {
      type: 'sl',
      coin: entryOrder.coin,
      side: closeSide,
      triggerPrice: entryOrder.slPrice,
      size: entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size,
      isMarket: SL_IS_MARKET,
      cloid: generateCloid(),
      exchangeOrderId: null,
      parentOrderId: entryOrder.id,
    }
    const slResult = getEffectivePaperTrade()
      ? paperSimulateTrigger(slTrigger)
      : await this.placeTriggerWithRetry(slTrigger, 'SL', entryOrder.coin, svc)
    if (slResult.success) {
      slTrigger.exchangeOrderId = slResult.exchangeOrderId
      log.info('order-manager', `SL trigger placed: ${entryOrder.coin} @ ${entryOrder.slPrice} [${slResult.exchangeOrderId}]`)
    } else {
      log.error('order-manager', `SL trigger FAILED for ${entryOrder.coin} after retries: ${slResult.error}`)
    }
    triggers.push(slTrigger)

    // TP: trigger-market (guaranteed fill on target hit)
    const tpTrigger: TriggerOrder = {
      type: 'tp',
      coin: entryOrder.coin,
      side: closeSide,
      triggerPrice: entryOrder.tpPrice,
      size: entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size,
      isMarket: TP_IS_MARKET,
      cloid: generateCloid(),
      exchangeOrderId: null,
      parentOrderId: entryOrder.id,
    }
    const tpResult = getEffectivePaperTrade()
      ? paperSimulateTrigger(tpTrigger)
      : await this.placeTriggerWithRetry(tpTrigger, 'TP', entryOrder.coin, svc)
    if (tpResult.success) {
      tpTrigger.exchangeOrderId = tpResult.exchangeOrderId
      log.info('order-manager', `TP trigger placed: ${entryOrder.coin} @ ${entryOrder.tpPrice} [${tpResult.exchangeOrderId}]`)
    } else {
      log.error('order-manager', `TP trigger FAILED for ${entryOrder.coin} after retries: ${tpResult.error}`)
    }
    triggers.push(tpTrigger)

    this.triggerOrders.set(entryOrder.id, triggers)
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
        const result = await placeTriggerOnExchange(trigger, exchangeSvc)
        if (!result.success) {
          // Check if the error is retryable — if not, throw non-retryable to break out
          const errMsg = result.error ?? 'unknown error'
          if (!isRetryableExchangeError(new Error(errMsg))) {
            // Return the failed result directly (don't retry validation errors)
            return result
          }
          throw new Error(errMsg)
        }
        return result
      },
      {
        maxAttempts: RETRY.slTpMaxAttempts,
        initialDelayMs: RETRY.initialDelayMs,
        jitterFraction: RETRY.jitterFraction,
        shouldRetry: (err) => isRetryableExchangeError(err),
        onRetry: (err, attempt, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('order-manager', `${label} trigger retry ${attempt} for ${coin}: ${msg} (backoff ${delayMs}ms)`)
        },
      },
    )

    if (retryResult.success && retryResult.value) {
      return retryResult.value
    }
    const msg = retryResult.lastError instanceof Error ? retryResult.lastError.message : String(retryResult.lastError)
    return { success: false, exchangeOrderId: null, error: msg }
  }

  // ── Cancel Order ───────────────────────────────────────────────────────

  /**
   * Cancel an unfilled order (timeout, invalidation, pause).
   * Idempotent — no-op if already cancelled/filled.
   */
  async cancelOrder(orderId: string, reason: string): Promise<void> {
    const order = this.orders.get(orderId) ?? await getOrderById(orderId)
    if (!order) {
      log.warn('order-manager', `Cancel for unknown order: ${orderId}`)
      return
    }

    // Already terminal — idempotent
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      log.debug('order-manager', `Cancel no-op: ${orderId} already ${order.status}`)
      return
    }

    // Cancel on exchange if submitted (or simulate in paper mode) — route to strategy wallet
    if (order.exchangeOrderId) {
      const svc = this.getExchangeForStrategy(order.strategyId)
      let cancelResult = getEffectivePaperTrade()
        ? paperSimulateCancel(order.exchangeOrderId, order.coin)
        : await cancelOnExchange(order.exchangeOrderId, order.coin, svc)
      // Fallback: cancel by cloid when exchangeOrderId is invalid (e.g. Bybit stored "submitted")
      if (!cancelResult.success && order.cloid && !getEffectivePaperTrade()) {
        log.info('order-manager', `Retrying cancel by cloid for ${orderId}`)
        cancelResult = await svc.cancelByCloid(order.coin, order.cloid)
      }
      if (!cancelResult.success) {
        log.error('order-manager', `Exchange cancel failed for ${orderId}: ${cancelResult.error}`)
        // Still mark cancelled in DB — reconciliation will catch discrepancies
      }
    }

    order.status = 'cancelled'
    order.updatedAt = Date.now()
    await updateOrderInDb(order)
    this.orders.set(order.id, order)

    log.info('order-manager', `Order cancelled: ${orderId} reason=${reason}`)
  }

  // ── Modify SL/TP (for trailing stop) ──────────────────────────────────

  /**
   * Modify SL trigger order on exchange (used by PositionMonitor for trail stop).
   * S10: Uses ExchangeService.modifyTrigger if oid available, else cancel+replace.
   */
  async modifySLPrice(parentOrderId: string, newSlPrice: number): Promise<void> {
    const triggers = this.triggerOrders.get(parentOrderId)
    if (!triggers) {
      log.warn('order-manager', `No triggers for order ${parentOrderId}`)
      return
    }

    const slTrigger = triggers.find(t => t.type === 'sl')
    if (!slTrigger) {
      log.warn('order-manager', `No SL trigger for order ${parentOrderId}`)
      return
    }

    const oldPrice = slTrigger.triggerPrice
    slTrigger.triggerPrice = newSlPrice

    // Paper mode: just update in-memory, no exchange calls
    if (getEffectivePaperTrade()) {
      log.info('order-manager', `[PAPER] SL updated: ${slTrigger.coin} ${oldPrice} → ${newSlPrice}`)
      return
    }

    // Get strategy-specific exchange service from parent order
    const parentOrder = this.orders.get(parentOrderId)
    const svc = this.getExchangeForStrategy(parentOrder?.strategyId ?? DEFAULT_STRATEGY)

    // Try to modify on exchange if we have an oid
    if (slTrigger.exchangeOrderId) {
      const oid = parseInt(slTrigger.exchangeOrderId, 10)
      if (!isNaN(oid)) {
        try {
          const result = await svc.modifyTrigger(
            slTrigger.coin,
            oid,
            slTrigger.side,
            newSlPrice,
            slTrigger.size,
            slTrigger.isMarket,
            'sl',
          )
          if (result.success) {
            log.info('order-manager', `SL modified on exchange: ${slTrigger.coin} ${oldPrice} → ${newSlPrice}`)
            return
          }
          log.warn('order-manager', `SL modify failed, trying cancel+replace: ${result.error}`)
        } catch (err) {
          log.warn('order-manager', `SL modify error, trying cancel+replace: ${err instanceof Error ? err.message : err}`)
        }
      }

      // Fallback: cancel old + place new — route to strategy wallet
      await cancelOnExchange(slTrigger.exchangeOrderId, slTrigger.coin, svc)
      const newResult = await placeTriggerOnExchange(slTrigger, svc)
      if (newResult.success) {
        slTrigger.exchangeOrderId = newResult.exchangeOrderId
        log.info('order-manager', `SL replaced on exchange: ${slTrigger.coin} ${oldPrice} → ${newSlPrice}`)
      } else {
        log.error('order-manager', `SL replace failed: ${newResult.error}`)
      }
    } else {
      log.info('order-manager', `SL updated in-memory: ${slTrigger.coin} ${oldPrice} → ${newSlPrice} (no exchange oid)`)
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
    if (getEffectivePaperTrade()) return
    for (const [, order] of this.orders) {
      if (order.status !== 'submitted' && order.status !== 'partial') continue
      const svc = this.getExchangeForStrategy(order.strategyId)
      const fill = await svc.getFillAggregateByCloid(order.cloid, order.coin)
      if (!fill || fill.totalSz <= 0) continue

      // isFilled=true means the exchange confirms the order is fully done (e.g. Bybit
      // orderStatus='Filled'). Use it to avoid a false-partial when Bybit rounds the
      // submitted qty down to szDecimals and fills that smaller-but-exact amount.
      const eps = 1e-12
      if (!fill.isFilled && fill.totalSz + eps < order.size) {
        await this.onPartialFill(order.id, fill.totalSz, fill.avgPx)
      } else {
        const sz = Math.min(fill.totalSz, order.size)
        await this.onOrderFilled(order.id, fill.avgPx, sz)
      }
    }
  }

  async checkTimeouts(): Promise<void> {
    const now = Date.now()
    for (const [, order] of this.orders) {
      if (order.status !== 'pending' && order.status !== 'submitted') continue
      const age = now - order.createdAt
      if (age > ORDER_FILL_TIMEOUT_MS) {
        log.info('order-manager', `Order timeout: ${order.id} ${order.coin} age=${Math.round(age / 1000)}s`)
        await this.cancelOrder(order.id, 'timeout')
        this.dispatchToAgent?.(order.coin, { type: 'order_timeout', orderId: order.id }, order.strategyId)
      }
    }
  }

  // ── Action Listener (from TradingAgent) ────────────────────────────────

  /**
   * Handle actions emitted by TradingAgent.
   * Wired via `agent.onAction(om.handleAction.bind(om))`.
   */
  async handleAction(action: AgentAction): Promise<void> {
    switch (action.type) {
      case 'place_order': {
        const setup = action.setup
        const sid = setup.strategyId ?? DEFAULT_STRATEGY
        const order = await this.placeOrder(setup)
        if (order === null) {
          // placeOrder can skip (duplicate, min notional, sizing) — must unblock agent ENTERING
          this.dispatchToAgent?.(setup.coin, {
            type: 'order_rejected',
            orderId: '',
            reason: 'place_order_skipped',
          }, sid)
        } else if (order.status === 'submitted' || order.status === 'partial') {
          // Notify agent of submitted (resting limit) order so it can track pendingOrderId
          // for cancel on timeout/invalidation. Skip for filled (paper/immediate live fill —
          // agent already received order_filled) and rejected (agent already got order_rejected
          // from inside placeOrder — dispatching order_submitted would corrupt pendingOrderId).
          this.dispatchToAgent?.(setup.coin, { type: 'order_submitted', orderId: order.id }, sid)
        }
        break
      }
      case 'cancel_order':
        await this.cancelOrder(action.orderId, action.reason)
        break
      case 'close_position':
        // S7 (PositionMonitor) handles close. OrderManager places the close order.
        await this.closePosition(action.positionId, action.reason)
        break
      case 'update_stop':
        // Find the entry order for this position, update its SL trigger
        await this.updateStopForPosition(action.positionId, action.newStopPrice)
        break
      default:
        // Other actions (watch, log_journal, partial_close, none) not handled here
        break
    }
  }

  // ── Close Position ────────────────────────────────────────────────────

  /**
   * Close a position by placing a market order in the opposite direction.
   * Also cancels any active SL/TP trigger orders.
   */
  private async closePosition(positionId: string, reason: string): Promise<void> {
    // Find the order that opened this position
    const entryOrder = this.findOrderByPositionContext(positionId)
    if (!entryOrder) {
      log.warn('order-manager', `No entry order found for position ${positionId} — close deferred to S10 exchange sync`)
      return
    }

    // Route to strategy-specific exchange wallet
    const svc = this.getExchangeForStrategy(entryOrder.strategyId)

    // Cancel SL/TP triggers
    const triggers = this.triggerOrders.get(entryOrder.id)
    if (triggers) {
      for (const trigger of triggers) {
        if (trigger.exchangeOrderId) {
          if (getEffectivePaperTrade()) {
            paperSimulateCancel(trigger.exchangeOrderId, trigger.coin)
          } else {
            await cancelOnExchange(trigger.exchangeOrderId, trigger.coin, svc)
          }
        }
      }
      this.triggerOrders.delete(entryOrder.id)
    }

    // Place close order (opposite side) — use entry fillPrice as reference (HL needs a valid price even for market orders)
    const closeSide: 'long' | 'short' = entryOrder.side === 'long' ? 'short' : 'long'
    const closeSize = entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size
    const refPrice = entryOrder.fillPrice ?? entryOrder.price
    const cloid = generateCloid()
    if (getEffectivePaperTrade()) {
      const slippageDir = closeSide === 'long' ? 1 : -1
      const closePrice = refPrice * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
      paperSimulateFill(entryOrder.coin, closeSide, closePrice, closeSize, cloid)
      const trade = getPaperTracker(entryOrder.strategyId).recordExit(entryOrder.id, closePrice)
      // Dispatch with real P&L so agent state machine + circuit breakers work
      if (trade && entryOrder.positionId) {
        this.dispatchToAgent?.(entryOrder.coin, {
          type: 'position_closed',
          positionId: entryOrder.positionId,
          closePrice,
          pnl: trade.pnl,
          reason,
        }, entryOrder.strategyId)
      }
    } else {
      const closeRef = computeMarketRefPrice(entryOrder.coin, closeSide, refPrice)
      await submitToExchange(entryOrder.coin, closeSide, 'market', closeRef, closeSize, cloid, svc)
    }

    log.info('order-manager', `Position close submitted: ${entryOrder.coin} reason=${reason}`)
  }

  /** Update SL trigger for a position (trail stop). */
  private async updateStopForPosition(positionId: string, newStopPrice: number): Promise<void> {
    const entryOrder = this.findOrderByPositionContext(positionId)
    if (!entryOrder) return
    await this.modifySLPrice(entryOrder.id, newStopPrice)
  }

  /**
   * Find the filled entry order associated with a position.
   * Matches by positionId (stored on order at fill time).
   * Falls back to coin match for backward compatibility.
   */
  private findOrderByPositionContext(positionId: string): Order | null {
    // Primary: match by positionId stored on the order at fill time
    for (const [, order] of this.orders) {
      if (order.status === 'filled' && order.positionId === positionId) {
        return order
      }
    }
    // No match — position not found
    log.warn('order-manager', `findOrderByPositionContext: no filled order with positionId=${positionId}`)
    return null
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /** Get an order by ID (from cache or DB). */
  async getOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? await getOrderById(orderId)
  }

  /** Get all cached orders. */
  getOrders(): Map<string, Order> {
    return new Map(this.orders)
  }

  /** Get trigger orders for a parent entry order. */
  getTriggerOrders(parentOrderId: string): TriggerOrder[] {
    return this.triggerOrders.get(parentOrderId) ?? []
  }

  /** Load active orders from DB into cache (startup recovery). */
  async loadActiveOrders(): Promise<void> {
    const exchange = getActiveExchange()
    const rows = await sql`
      SELECT * FROM orders
      WHERE status IN ('pending', 'submitted', 'partial', 'filled')
        AND exchange = ${exchange}
    `
    for (const row of rows) {
      const order = rowToOrder(row)
      this.orders.set(order.id, order)
    }
    log.info('order-manager', `Loaded ${rows.length} active orders from DB [exchange=${exchange}]`)

    // Reconcile: cancel stale pending/submitted orders from previous runs.
    // These are phantom orders that never completed — the bot crashed or was
    // restarted before the order lifecycle finished.  Without this, the
    // idempotency guard blocks all new entries for the affected coin+strategy.
    await this.reconcileStaleOrders()
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
    const now = Date.now()
    let cancelled = 0
    for (const [, order] of this.orders) {
      if (order.status !== 'pending' && order.status !== 'submitted') continue
      const age = now - order.createdAt
      // Pending with no exchange ID → never submitted (crash). Cancel immediately.
      // Submitted but older than timeout → stale. Cancel.
      if (order.status === 'pending' && !order.exchangeOrderId || age > ORDER_FILL_TIMEOUT_MS) {
        order.status = 'cancelled'
        order.updatedAt = now
        await updateOrderInDb(order)
        this.orders.set(order.id, order)
        log.info('order-manager', `Reconciled stale order: ${order.id} ${order.coin} [${order.strategyId}] age=${Math.round(age / 1000)}s → cancelled`)
        cancelled++
      }
    }
    if (cancelled > 0) {
      log.info('order-manager', `Reconciled ${cancelled} stale order(s) at startup`)
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
    const openCoins = new Set<string>()
    for (const snap of exchangeSnaps) {
      if (snap.size !== 0) openCoins.add(snap.coin)
    }
    if (openCoins.size === 0) return

    // For each open coin, find the most recent filled order in our cache
    const latestByCoin = new Map<string, Order>()
    for (const [, order] of this.orders) {
      if (order.status !== 'filled') continue
      if (!order.positionId || !order.fillPrice) continue
      if (!openCoins.has(order.coin)) continue
      const existing = latestByCoin.get(order.coin)
      const orderTs = order.filledAt ?? order.updatedAt
      const existingTs = existing ? (existing.filledAt ?? existing.updatedAt) : 0
      if (!existing || orderTs > existingTs) latestByCoin.set(order.coin, order)
    }

    let restored = 0
    for (const [, order] of latestByCoin) {
      this.onPositionOpen?.({
        positionId: order.positionId!,
        coin: order.coin,
        side: order.side,
        entryPrice: order.fillPrice!,
        size: order.size,  // fillSize not persisted; original size is close enough for trail/TUI
        slPrice: order.slPrice ?? 0,
        tpPrice: order.tpPrice ?? 0,
        entryOrderId: order.id,
        leverage: 0,  // unknown at restore time; TUI merge uses exchange value as fallback
        strategyId: order.strategyId,
      })
      restored++
    }

    if (restored > 0) {
      log.info('order-manager', `Restored ${restored} open position(s) into PositionMonitor after restart`)
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: OrderManager | null = null

/** Get or create the singleton OrderManager. */
export function getOrderManager(): OrderManager {
  if (!instance) {
    instance = new OrderManager()
  }
  return instance
}

/** Reset OrderManager (tests only). */
export function resetOrderManager(): void {
  instance = null
}
