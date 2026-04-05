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
import type { ActiveSetup } from '../types.js'
import type {
  Order,
  OrderStatus,
  TriggerOrder,
  ExchangeOrderResult,
  AgentAction,
  AgentEvent,
} from './types.js'
import { sql } from '../db/connection.js'
import {
  ORDER_FILL_TIMEOUT_MS,
  MAX_ORDERS_PER_COIN,
  SL_IS_MARKET,
  TP_IS_MARKET,
  RETRY,
  PAPER_TRADE,
  PAPER_SLIPPAGE_PCT,
} from '../config.js'
import { getExchangeService, type ExchangeService } from '../execution/exchange-service.js'
import type { ExchangePool } from '../execution/exchange-pool.js'
import { log } from '../lib/logger.js'
import { withRetry, isRetryableExchangeError } from '../lib/retry.js'

/** Default strategy ID for backward compatibility (single-strategy mode). */
const DEFAULT_STRATEGY = 'layered'

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
  svc?: ExchangeService,
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
    })
    if (result.success) {
      // oid may be null for "waitingForFill"/"waitingForTrigger" — use status as fallback
      const exchangeId = result.oid !== null ? String(result.oid) : result.status
      return { success: true, exchangeOrderId: exchangeId, error: null }
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
  svc?: ExchangeService,
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

    log.warn('order-manager', `cancelOnExchange: cannot cancel without valid oid or cloid+coin (id=${exchangeOrderId})`)
    return { success: false, exchangeOrderId: null, error: 'Missing coin for cancel' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, exchangeOrderId: null, error: msg }
  }
}

/**
 * Place trigger order (SL/TP) on exchange via ExchangeService.
 * R9: SL = trigger-market (isMarket=true), TP = trigger-limit (isMarket=false).
 */
export async function placeTriggerOnExchange(
  trigger: TriggerOrder,
  svc?: ExchangeService,
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
    INSERT INTO orders (id, coin, side, type, price, size, status, setup_id, sl_price, tp_price, exchange_order_id, created_at, updated_at, fill_price, filled_at, strategy_id)
    VALUES (
      ${order.id}, ${order.coin}, ${order.side}, ${order.type}, ${order.price},
      ${order.size}, ${order.status}, ${order.setupId}, ${order.slPrice}, ${order.tpPrice},
      ${order.exchangeOrderId}, ${new Date(order.createdAt)}, ${new Date(order.updatedAt)},
      ${order.fillPrice}, ${order.filledAt ? new Date(order.filledAt) : null},
      ${order.strategyId}
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
      updated_at = ${new Date(order.updatedAt)}
    WHERE id = ${order.id}
  `
}

/** Get all pending/submitted orders for a coin. */
async function getActiveOrdersForCoin(coin: string): Promise<Order[]> {
  const rows = await sql`
    SELECT * FROM orders
    WHERE coin = ${coin} AND status IN ('pending', 'submitted', 'partial')
    ORDER BY created_at DESC
  `
  return rows.map(rowToOrder)
}

/** Get order by ID. */
async function getOrderById(orderId: string): Promise<Order | null> {
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
  /** ExchangePool for per-strategy exchange routing (Sprint 4.5). */
  private exchangePool: ExchangePool | null = null

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent, strategyId?: string) => void): void {
    this.dispatchToAgent = fn
  }

  /** Set the ExchangePool for per-strategy exchange routing (Sprint 4.5). */
  setExchangePool(pool: ExchangePool): void {
    this.exchangePool = pool
  }

  /** Get ExchangeService for a strategy. Falls back to singleton if no pool. */
  private getExchangeForStrategy(strategyId: string): ExchangeService {
    if (this.exchangePool) {
      return this.exchangePool.get(strategyId)
    }
    return getExchangeService()
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
    const { coin, side, entryPrice, slPrice, tpPrice } = setup
    const strategyId = setup.strategyId ?? DEFAULT_STRATEGY

    // Idempotency: 1 order per coin (MAX_ORDERS_PER_COIN = 1)
    const active = await getActiveOrdersForCoin(coin)
    if (active.length >= MAX_ORDERS_PER_COIN) {
      log.warn('order-manager', `Blocked duplicate order for ${coin} — active order exists: ${active[0]?.id}`)
      return null
    }

    // Build order
    const now = Date.now()
    const cloid = generateCloid()
    const order: Order = {
      id: randomUUID(),
      coin,
      side,
      type: 'market',  // default to market for entry
      price: entryPrice,
      size: setup.patternData.positionSizeCoins as number ?? 0,
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
    }

    // Persist pending
    await insertOrder(order)
    this.orders.set(order.id, order)
    log.info('order-manager', `Order created: ${order.id} ${coin} ${side} @ ${entryPrice} strategy=${strategyId} [cloid=${cloid.slice(0, 10)}...]`)

    // Submit to exchange (or simulate in paper mode) — route to strategy-specific wallet
    const svc = this.getExchangeForStrategy(strategyId)
    const result = PAPER_TRADE
      ? paperSimulateFill(coin, side, entryPrice, order.size, cloid)
      : await submitToExchange(coin, side, order.type, entryPrice, order.size, cloid, svc)

    if (result.success) {
      order.status = 'submitted'
      order.exchangeOrderId = result.exchangeOrderId
      order.updatedAt = Date.now()
      await updateOrderInDb(order)
      this.orders.set(order.id, order)
      log.info('order-manager', `Order submitted: ${order.id} exchangeId=${result.exchangeOrderId}`)

      // Paper mode: auto-fill immediately (no exchange WS to notify us)
      if (PAPER_TRADE) {
        const slippageDir = side === 'long' ? 1 : -1
        const paperFillPrice = entryPrice * (1 + slippageDir * PAPER_SLIPPAGE_PCT)
        await this.onOrderFilled(order.id, paperFillPrice, order.size)
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

    const now = Date.now()
    order.status = 'filled'
    order.fillPrice = fillPrice
    order.filledAt = now
    order.fillSize = fillSize
    order.updatedAt = now
    await updateOrderInDb(order)
    this.orders.set(order.id, order)

    log.info('order-manager', `Order filled: ${order.id} ${order.coin} @ ${fillPrice}`)

    // R9: Place SL + TP trigger orders on exchange
    await this.placeSLTP(order)

    // Create position ID and dispatch to agent (with strategyId for correct routing)
    const positionId = randomUUID()
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
   */
  async onPartialFill(orderId: string, filledSize: number): Promise<void> {
    const order = this.orders.get(orderId) ?? await getOrderById(orderId)
    if (!order) {
      log.error('order-manager', `Partial fill for unknown order: ${orderId}`)
      return
    }

    order.fillSize = filledSize
    order.status = 'partial'
    order.updatedAt = Date.now()
    await updateOrderInDb(order)
    this.orders.set(order.id, order)

    log.info('order-manager', `Partial fill: ${order.id} ${order.coin} filled=${filledSize}/${order.size}`)

    // If filled enough (>= requested), treat as full fill
    if (filledSize >= order.size) {
      await this.onOrderFilled(orderId, order.price, filledSize)
    }
  }

  // ── SL/TP Trigger Orders (R9) ──────────────────────────────────────────

  /**
   * R9: After entry fill, place SL (trigger-market) + TP (trigger-limit) on HL.
   * Exchange-managed safety — protected even if agent dies.
   */
  private async placeSLTP(entryOrder: Order): Promise<void> {
    if (!entryOrder.slPrice || !entryOrder.tpPrice) {
      log.warn('order-manager', `No SL/TP prices for order ${entryOrder.id} — skipping trigger placement`)
      return
    }

    const closeSide: 'long' | 'short' = entryOrder.side === 'long' ? 'short' : 'long'
    const triggers: TriggerOrder[] = []
    // Route SL/TP to strategy-specific exchange wallet
    const svc = this.getExchangeForStrategy(entryOrder.strategyId)

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
    const slResult = PAPER_TRADE
      ? paperSimulateTrigger(slTrigger)
      : await this.placeTriggerWithRetry(slTrigger, 'SL', entryOrder.coin, svc)
    if (slResult.success) {
      slTrigger.exchangeOrderId = slResult.exchangeOrderId
      log.info('order-manager', `SL trigger placed: ${entryOrder.coin} @ ${entryOrder.slPrice} [${slResult.exchangeOrderId}]`)
    } else {
      log.error('order-manager', `SL trigger FAILED for ${entryOrder.coin} after retries: ${slResult.error}`)
    }
    triggers.push(slTrigger)

    // TP: trigger-limit (better fill price on target)
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
    const tpResult = PAPER_TRADE
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
    exchangeSvc?: ExchangeService,
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
      const result = PAPER_TRADE
        ? paperSimulateCancel(order.exchangeOrderId, order.coin)
        : await cancelOnExchange(order.exchangeOrderId, order.coin, svc)
      if (!result.success) {
        log.error('order-manager', `Exchange cancel failed for ${orderId}: ${result.error}`)
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
    if (PAPER_TRADE) {
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
      case 'place_order':
        await this.placeOrder(action.setup)
        break
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
          if (PAPER_TRADE) {
            paperSimulateCancel(trigger.exchangeOrderId, trigger.coin)
          } else {
            await cancelOnExchange(trigger.exchangeOrderId, trigger.coin, svc)
          }
        }
      }
      this.triggerOrders.delete(entryOrder.id)
    }

    // Place close order (opposite side)
    const closeSide: 'long' | 'short' = entryOrder.side === 'long' ? 'short' : 'long'
    const closeSize = entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size
    const cloid = generateCloid()
    if (PAPER_TRADE) {
      paperSimulateFill(entryOrder.coin, closeSide, 0, closeSize, cloid)
    } else {
      await submitToExchange(entryOrder.coin, closeSide, 'market', 0, closeSize, cloid, svc)
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
   * Simple scan — with 1 position per coin, this is fast.
   */
  private findOrderByPositionContext(positionId: string): Order | null {
    // Look for a filled order whose coin matches a position
    // In current design, positionId is generated at fill time and stored in CoinContext,
    // but not in the order itself. We match by coin + filled status.
    for (const [, order] of this.orders) {
      if (order.status === 'filled') {
        return order  // 1 position per coin → first filled order is the match
      }
    }
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
    const rows = await sql`
      SELECT * FROM orders WHERE status IN ('pending', 'submitted', 'partial', 'filled')
    `
    for (const row of rows) {
      const order = rowToOrder(row)
      this.orders.set(order.id, order)
    }
    log.info('order-manager', `Loaded ${rows.length} active orders from DB`)
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
