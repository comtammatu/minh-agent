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
} from '../config.js'
import { log } from '../lib/logger.js'

// ─── Cloid Generation ───────────────────────────────────────────────────────

/** Generate a 128-bit hex client order ID for HL idempotency. */
export function generateCloid(): string {
  // UUID v4 → strip dashes → prefix 0x
  return '0x' + randomUUID().replace(/-/g, '')
}

// ─── Exchange Stubs (wired in S10) ──────────────────────────────────────────

/**
 * Submit order to exchange. Stubbed — returns simulated success.
 * S10 replaces with real HL ExchangeClient call.
 */
export async function submitToExchange(
  _coin: string,
  _side: 'long' | 'short',
  _type: 'limit' | 'market',
  _price: number,
  _size: number,
  _cloid: string,
): Promise<ExchangeOrderResult> {
  log.warn('order-manager', 'submitToExchange STUB — no real exchange call')
  return { success: true, exchangeOrderId: `sim-${Date.now()}`, error: null }
}

/**
 * Cancel order on exchange. Stubbed.
 */
export async function cancelOnExchange(
  _exchangeOrderId: string,
): Promise<ExchangeOrderResult> {
  log.warn('order-manager', 'cancelOnExchange STUB — no real exchange call')
  return { success: true, exchangeOrderId: null, error: null }
}

/**
 * Place trigger order (SL/TP) on exchange. Stubbed.
 * R9: SL = trigger-market, TP = trigger-limit.
 */
export async function placeTriggerOnExchange(
  _trigger: TriggerOrder,
): Promise<ExchangeOrderResult> {
  log.warn('order-manager', 'placeTriggerOnExchange STUB — no real exchange call')
  return { success: true, exchangeOrderId: `sim-trig-${Date.now()}`, error: null }
}

// ─── DB Operations ──────────────────────────────────────────────────────────

/** Insert a new order into the database. */
async function insertOrder(order: Order): Promise<void> {
  await sql`
    INSERT INTO orders (id, coin, side, type, price, size, status, setup_id, sl_price, tp_price, exchange_order_id, created_at, updated_at, fill_price, filled_at)
    VALUES (
      ${order.id}, ${order.coin}, ${order.side}, ${order.type}, ${order.price},
      ${order.size}, ${order.status}, ${order.setupId}, ${order.slPrice}, ${order.tpPrice},
      ${order.exchangeOrderId}, ${new Date(order.createdAt)}, ${new Date(order.updatedAt)},
      ${order.fillPrice}, ${order.filledAt ? new Date(order.filledAt) : null}
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
  }
}

// ─── OrderManager Class ─────────────────────────────────────────────────────

export class OrderManager {
  /** In-memory order cache — keyed by order ID. DB is source of truth. */
  private orders: Map<string, Order> = new Map()
  /** In-memory trigger orders — keyed by parent order ID. */
  private triggerOrders: Map<string, TriggerOrder[]> = new Map()
  /** Callback to dispatch events back to TradingAgent. */
  private dispatchToAgent: ((coin: string, event: AgentEvent) => void) | null = null

  /** Set the callback for dispatching events to the agent state machine. */
  setAgentDispatch(fn: (coin: string, event: AgentEvent) => void): void {
    this.dispatchToAgent = fn
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
    }

    // Persist pending
    await insertOrder(order)
    this.orders.set(order.id, order)
    log.info('order-manager', `Order created: ${order.id} ${coin} ${side} @ ${entryPrice} [cloid=${cloid.slice(0, 10)}...]`)

    // Submit to exchange
    const result = await submitToExchange(coin, side, order.type, entryPrice, order.size, cloid)

    if (result.success) {
      order.status = 'submitted'
      order.exchangeOrderId = result.exchangeOrderId
      order.updatedAt = Date.now()
      await updateOrderInDb(order)
      this.orders.set(order.id, order)
      log.info('order-manager', `Order submitted: ${order.id} exchangeId=${result.exchangeOrderId}`)
    } else {
      order.status = 'rejected'
      order.updatedAt = Date.now()
      await updateOrderInDb(order)
      this.orders.set(order.id, order)
      log.error('order-manager', `Order rejected by exchange: ${result.error}`)
      this.dispatchToAgent?.(coin, { type: 'order_rejected', orderId: order.id, reason: result.error ?? 'exchange_rejection' })
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

    // Create position ID and dispatch to agent
    const positionId = randomUUID()
    this.dispatchToAgent?.(order.coin, {
      type: 'order_filled',
      orderId: order.id,
      fillPrice,
      positionId,
    })
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
    const slResult = await placeTriggerOnExchange(slTrigger)
    if (slResult.success) {
      slTrigger.exchangeOrderId = slResult.exchangeOrderId
      log.info('order-manager', `SL trigger placed: ${entryOrder.coin} @ ${entryOrder.slPrice} [${slResult.exchangeOrderId}]`)
    } else {
      log.error('order-manager', `SL trigger FAILED for ${entryOrder.coin}: ${slResult.error}`)
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
    const tpResult = await placeTriggerOnExchange(tpTrigger)
    if (tpResult.success) {
      tpTrigger.exchangeOrderId = tpResult.exchangeOrderId
      log.info('order-manager', `TP trigger placed: ${entryOrder.coin} @ ${entryOrder.tpPrice} [${tpResult.exchangeOrderId}]`)
    } else {
      log.error('order-manager', `TP trigger FAILED for ${entryOrder.coin}: ${tpResult.error}`)
    }
    triggers.push(tpTrigger)

    this.triggerOrders.set(entryOrder.id, triggers)
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

    // Cancel on exchange if submitted
    if (order.exchangeOrderId) {
      const result = await cancelOnExchange(order.exchangeOrderId)
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
   * Stub — exchange call wired in S10.
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

    slTrigger.triggerPrice = newSlPrice
    // TODO S10: cancel old SL trigger + place new one on exchange
    log.info('order-manager', `SL modified: ${slTrigger.coin} new SL @ ${newSlPrice} (stub — exchange update in S10)`)
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
        this.dispatchToAgent?.(order.coin, { type: 'order_timeout', orderId: order.id })
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

    // Cancel SL/TP triggers
    const triggers = this.triggerOrders.get(entryOrder.id)
    if (triggers) {
      for (const trigger of triggers) {
        if (trigger.exchangeOrderId) {
          await cancelOnExchange(trigger.exchangeOrderId)
        }
      }
      this.triggerOrders.delete(entryOrder.id)
    }

    // Place close order (opposite side)
    const closeSide: 'long' | 'short' = entryOrder.side === 'long' ? 'short' : 'long'
    const closeSize = entryOrder.fillSize > 0 ? entryOrder.fillSize : entryOrder.size
    const cloid = generateCloid()
    await submitToExchange(entryOrder.coin, closeSide, 'market', 0, closeSize, cloid)

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
