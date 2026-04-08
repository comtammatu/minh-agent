/**
 * Exit strategies — SL/TP computation, position sizing, trailing, partial close.
 *
 * Section 12 rules:
 *   - Stop = invalidation level, NOT "comfortable" level
 *   - Position size adjusts to stop distance, never the other way
 *   - Structure stop > ATR stop > trailing (priority order)
 *
 * Pure functions. Zero I/O. Zero side effects.
 */

import type { SignalSide } from '../types.js'
import {
  DEFAULT_RISK_PERCENT,
  ATR_STOP_MULTIPLIER,
  STRUCTURE_STOP_ATR_BUFFER,
  MAX_STOP_DISTANCE_PCT,
  MAX_LEVERAGE_WARN,
  TRAILING_STOP,
  PARTIAL_CLOSE,
  MIN_POSITION_SIZE_PCT,
  STOP_SLIPPAGE_BUFFER,
} from '../config.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type StopMethod = 'structure' | 'atr' | 'combined'

export interface StopLossResult {
  price: number
  method: StopMethod
  distancePct: number  // fraction (0.02 = 2%)
  atrBuffer: number    // absolute ATR buffer added
}

export interface TakeProfitResult {
  price: number
  rr: number           // reward-to-risk ratio achieved
  distancePct: number  // fraction
}

export interface PositionSizeResult {
  sizeUsd: number
  sizeCoins: number
  leverage: number
  riskAmount: number
  verdict: 'good' | 'warn' | 'skip'
  reason?: string
}

export interface TrailingStopConfig {
  activationPct: number  // activate after this % profit from entry
  trailPct: number       // trail this % below highest price
}

export interface TrailingStopState {
  active: boolean
  highestPrice: number
  currentStopPrice: number
}

export interface PartialCloseConfig {
  firstTpRatio: number    // first TP at Nx risk
  firstClosePct: number   // fraction of position to close (0.5 = 50%)
  moveSlToBreakeven: boolean
  secondTpRatio: number   // second TP target for remainder
}

export interface PartialCloseLevel {
  targetPrice: number
  closePct: number       // fraction to close
  newSlPrice?: number    // move SL here after close (breakeven)
}

export interface ExitPlan {
  stopLoss: StopLossResult
  takeProfit: TakeProfitResult
  positionSize: PositionSizeResult
  partialCloses: PartialCloseLevel[]
  trailingConfig: TrailingStopConfig
}

// ─── Position Sizing (R12: shared by risk-filter + order-manager) ────────────

/**
 * Compute position size from account value, risk %, entry, and stop price.
 * Section 12.6 formula: riskAmount / stopDistance.
 *
 * @returns Position size in coin units. Returns 0 if stop distance is zero.
 */
export function computePositionSize(
  accountValue: number,
  riskPercent: number,
  entryPrice: number,
  slPrice: number,
): number {
  const stopDistance = Math.abs(entryPrice - slPrice)
  if (stopDistance === 0 || entryPrice === 0) return 0
  const riskAmount = accountValue * riskPercent
  return riskAmount / stopDistance
}

/**
 * Cap coin size so that, at the exchange's max leverage for this asset, initial margin
 * does not exceed `accountValue × targetMarginPct`.
 *
 * Used in tests and optional tooling — **not** applied in `OrderManager.placeOrder`
 * (live/paper entries use pure risk-based size; HL enforces margin / max leverage).
 *
 * @returns Adjusted size in coin units; `wasCapped` if risk-based size was reduced.
 */
export function clampPositionSizeForMaxLeverage(
  sizeCoins: number,
  entryPrice: number,
  accountValue: number,
  targetMarginPct: number,
  maxLeverage: number | undefined,
): { sizeCoins: number; wasCapped: boolean } {
  if (entryPrice <= 0 || accountValue <= 0 || sizeCoins <= 0) {
    return { sizeCoins, wasCapped: false }
  }
  if (maxLeverage === undefined || maxLeverage <= 0) {
    return { sizeCoins, wasCapped: false }
  }
  const sizeUsd = sizeCoins * entryPrice
  const maxNotionalUsd = accountValue * targetMarginPct * maxLeverage
  if (sizeUsd <= maxNotionalUsd) {
    return { sizeCoins, wasCapped: false }
  }
  return { sizeCoins: maxNotionalUsd / entryPrice, wasCapped: true }
}

/**
 * Leverage chosen before entry — mirrors `ExchangeService.setLeverage` (ceil, min 1, cap by maxLev).
 * margin_used ≈ sizeUsd / leverage ≤ accountValue × targetMarginPct when max leverage does not bind.
 */
export function computeEntryLeverageForTargetMargin(
  sizeUsd: number,
  accountValue: number,
  targetMarginPct: number,
  maxLeverage: number | undefined,
): number {
  if (sizeUsd <= 0 || accountValue <= 0 || targetMarginPct <= 0) return 1
  const targetMarginUsd = accountValue * targetMarginPct
  const raw = sizeUsd / targetMarginUsd
  if (maxLeverage !== undefined && maxLeverage > 0) {
    return Math.min(Math.max(1, Math.ceil(raw)), maxLeverage)
  }
  return Math.max(1, Math.ceil(raw))
}

/**
 * Full position sizing with validation (Section 12.6).
 * Returns size in USD and coins, leverage, and verdict.
 */
export function computePositionSizeDetailed(
  accountValue: number,
  riskPercent: number,
  entryPrice: number,
  slPrice: number,
): PositionSizeResult {
  if (accountValue <= 0 || entryPrice <= 0) {
    return { sizeUsd: 0, sizeCoins: 0, leverage: 0, riskAmount: 0, verdict: 'skip', reason: 'invalid input' }
  }

  const stopDistanceAbs = Math.abs(entryPrice - slPrice)
  if (stopDistanceAbs === 0) {
    return { sizeUsd: 0, sizeCoins: 0, leverage: 0, riskAmount: 0, verdict: 'skip', reason: 'zero stop distance' }
  }

  const stopDistancePct = stopDistanceAbs / entryPrice

  // Skip if stop too wide (> MAX_STOP_DISTANCE_PCT)
  if (stopDistancePct > MAX_STOP_DISTANCE_PCT) {
    return {
      sizeUsd: 0,
      sizeCoins: 0,
      leverage: 0,
      riskAmount: accountValue * riskPercent,
      verdict: 'skip',
      reason: `stop too wide: ${(stopDistancePct * 100).toFixed(1)}% > ${(MAX_STOP_DISTANCE_PCT * 100).toFixed(0)}%`,
    }
  }

  const riskAmount = accountValue * riskPercent
  const sizeUsd = riskAmount / stopDistancePct
  const sizeCoins = sizeUsd / entryPrice
  const leverage = sizeUsd / accountValue

  // Check minimum size
  if (sizeUsd < accountValue * MIN_POSITION_SIZE_PCT) {
    return { sizeUsd, sizeCoins, leverage, riskAmount, verdict: 'skip', reason: 'position size too small' }
  }

  // Warn on high leverage
  if (leverage > MAX_LEVERAGE_WARN) {
    return { sizeUsd, sizeCoins, leverage, riskAmount, verdict: 'warn', reason: `high leverage: ${leverage.toFixed(1)}x` }
  }

  return { sizeUsd, sizeCoins, leverage, riskAmount, verdict: 'good' }
}

// ─── Stop Loss ──────────────────────────────────────────────────────────────

/**
 * Structure-based stop: zone boundary + ATR buffer (Section 12.2 Method 1).
 * For longs: stop below zone bottom. For shorts: stop above zone top.
 */
export function computeStructureStop(
  side: SignalSide,
  zoneBottom: number,
  zoneTop: number,
  atrValue: number,
  entryPrice: number,
): StopLossResult {
  const atrBuffer = atrValue * STRUCTURE_STOP_ATR_BUFFER
  const price = side === 'long'
    ? zoneBottom - atrBuffer
    : zoneTop + atrBuffer
  const distancePct = Math.abs(entryPrice - price) / entryPrice

  return { price, method: 'structure', distancePct, atrBuffer }
}

/**
 * ATR-based stop: entry ± ATR × multiplier (Section 12.2 Method 2).
 * Used when no clear zone exists.
 */
export function computeAtrStop(
  side: SignalSide,
  entryPrice: number,
  atrValue: number,
  multiplier: number = ATR_STOP_MULTIPLIER.standard,
): StopLossResult {
  const atrBuffer = atrValue * multiplier
  const price = side === 'long'
    ? entryPrice - atrBuffer
    : entryPrice + atrBuffer
  const distancePct = Math.abs(entryPrice - price) / entryPrice

  return { price, method: 'atr', distancePct, atrBuffer }
}

/**
 * Combined stop: structure level + ATR buffer (Section 12.2 best approach).
 * Uses the tighter of structure and ATR stop for better risk management,
 * but never tighter than the raw structure level (no zone boundary violation).
 */
export function computeCombinedStop(
  side: SignalSide,
  zoneBottom: number,
  zoneTop: number,
  entryPrice: number,
  atrValue: number,
  atrMultiplier: number = ATR_STOP_MULTIPLIER.standard,
): StopLossResult {
  const structureStop = computeStructureStop(side, zoneBottom, zoneTop, atrValue, entryPrice)
  const atrStop = computeAtrStop(side, entryPrice, atrValue, atrMultiplier)

  // For longs: use the higher (tighter) stop, but not above zone bottom
  // For shorts: use the lower (tighter) stop, but not below zone top
  let price: number
  if (side === 'long') {
    price = Math.max(structureStop.price, Math.min(atrStop.price, zoneBottom))
  } else {
    price = Math.min(structureStop.price, Math.max(atrStop.price, zoneTop))
  }

  const distancePct = Math.abs(entryPrice - price) / entryPrice
  return { price, method: 'combined', distancePct, atrBuffer: structureStop.atrBuffer }
}

// ─── Take Profit ────────────────────────────────────────────────────────────

/**
 * R:R-based take profit: TP = entry + (entry - SL) × ratio.
 */
export function computeRrTakeProfit(
  side: SignalSide,
  entryPrice: number,
  slPrice: number,
  targetRR: number,
): TakeProfitResult {
  const stopDistance = Math.abs(entryPrice - slPrice)
  const reward = stopDistance * targetRR
  const price = side === 'long'
    ? entryPrice + reward
    : entryPrice - reward
  const distancePct = reward / entryPrice

  return { price, rr: targetRR, distancePct }
}

/**
 * Structure-based take profit: use a specific target price and compute R:R.
 */
export function computeStructureTakeProfit(
  side: SignalSide,
  entryPrice: number,
  slPrice: number,
  targetPrice: number,
): TakeProfitResult {
  const stopDistance = Math.abs(entryPrice - slPrice)
  const reward = Math.abs(targetPrice - entryPrice)
  const rr = stopDistance > 0 ? reward / stopDistance : 0
  const distancePct = reward / entryPrice

  return { price: targetPrice, rr, distancePct }
}

// ─── Trailing Stop ──────────────────────────────────────────────────────────

/**
 * Get default trailing stop config.
 */
export function getDefaultTrailingConfig(): TrailingStopConfig {
  return { ...TRAILING_STOP }
}

/**
 * Compute trailing stop state given current price.
 * Pure function — caller manages state persistence.
 *
 * @param side        Position side
 * @param entryPrice  Entry price
 * @param currentPrice Current market price
 * @param prevState   Previous trailing state (null = first call)
 * @param config      Trailing stop config
 * @returns Updated trailing state. Check `active` and `currentStopPrice`.
 */
export function computeTrailingStop(
  side: SignalSide,
  entryPrice: number,
  currentPrice: number,
  prevState: TrailingStopState | null,
  config: TrailingStopConfig = TRAILING_STOP,
): TrailingStopState {
  const profitPct = side === 'long'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice

  // Not yet activated
  if (profitPct < config.activationPct) {
    return {
      active: false,
      highestPrice: side === 'long'
        ? Math.max(currentPrice, prevState?.highestPrice ?? currentPrice)
        : Math.min(currentPrice, prevState?.highestPrice ?? currentPrice),
      currentStopPrice: prevState?.currentStopPrice ?? 0,
    }
  }

  // Activated — track the extreme price
  let highestPrice: number
  if (side === 'long') {
    highestPrice = Math.max(currentPrice, prevState?.highestPrice ?? currentPrice)
    const stopPrice = highestPrice * (1 - config.trailPct)
    return { active: true, highestPrice, currentStopPrice: stopPrice }
  } else {
    // For shorts, "highest" means lowest price (most profitable)
    highestPrice = Math.min(currentPrice, prevState?.highestPrice ?? currentPrice)
    const stopPrice = highestPrice * (1 + config.trailPct)
    return { active: true, highestPrice, currentStopPrice: stopPrice }
  }
}

/**
 * Check if trailing stop has been hit.
 */
export function isTrailingStopHit(
  side: SignalSide,
  currentPrice: number,
  state: TrailingStopState,
): boolean {
  if (!state.active || state.currentStopPrice === 0) return false
  return side === 'long'
    ? currentPrice <= state.currentStopPrice
    : currentPrice >= state.currentStopPrice
}

// ─── Partial Close ──────────────────────────────────────────────────────────

/**
 * Get default partial close config.
 */
export function getDefaultPartialCloseConfig(): PartialCloseConfig {
  return { ...PARTIAL_CLOSE }
}

/**
 * Compute partial close levels from entry/SL/config.
 * Returns ordered list of close targets.
 */
export function computePartialCloseLevels(
  side: SignalSide,
  entryPrice: number,
  slPrice: number,
  config: PartialCloseConfig = PARTIAL_CLOSE,
): PartialCloseLevel[] {
  const stopDistance = Math.abs(entryPrice - slPrice)
  if (stopDistance === 0) return []

  const levels: PartialCloseLevel[] = []

  // First TP level
  const firstTpDistance = stopDistance * config.firstTpRatio
  const firstTpPrice = side === 'long'
    ? entryPrice + firstTpDistance
    : entryPrice - firstTpDistance

  levels.push({
    targetPrice: firstTpPrice,
    closePct: config.firstClosePct,
    newSlPrice: config.moveSlToBreakeven ? entryPrice : undefined,
  })

  // Second TP level (remainder)
  const secondTpDistance = stopDistance * config.secondTpRatio
  const secondTpPrice = side === 'long'
    ? entryPrice + secondTpDistance
    : entryPrice - secondTpDistance

  levels.push({
    targetPrice: secondTpPrice,
    closePct: 1 - config.firstClosePct,  // close remainder
  })

  return levels
}

// ─── Full Exit Plan ─────────────────────────────────────────────────────────

/**
 * Build a complete exit plan for a signal.
 * Combines SL, TP, position sizing, partial close, and trailing config.
 */
export function buildExitPlan(
  side: SignalSide,
  entryPrice: number,
  zoneBottom: number,
  zoneTop: number,
  atrValue: number,
  accountValue: number,
  riskPercent: number = DEFAULT_RISK_PERCENT,
  targetRR: number = 2.0,
): ExitPlan | null {
  if (entryPrice <= 0 || atrValue <= 0 || accountValue <= 0) return null

  // 1. Compute stop loss (combined method — best approach per Section 12)
  const stopLoss = computeCombinedStop(side, zoneBottom, zoneTop, entryPrice, atrValue)

  // 2. Compute take profit
  const takeProfit = computeRrTakeProfit(side, entryPrice, stopLoss.price, targetRR)

  // 3. Compute position size
  const positionSize = computePositionSizeDetailed(accountValue, riskPercent, entryPrice, stopLoss.price)

  // 4. Partial close levels
  const partialCloses = computePartialCloseLevels(side, entryPrice, stopLoss.price)

  // 5. Trailing config
  const trailingConfig = getDefaultTrailingConfig()

  return { stopLoss, takeProfit, positionSize, partialCloses, trailingConfig }
}

/**
 * Add slippage buffer to a stop price (Section 12.5).
 * Widens the stop slightly to account for market order slippage.
 */
export function addSlippageBuffer(
  side: SignalSide,
  stopPrice: number,
  buffer: number = STOP_SLIPPAGE_BUFFER,
): number {
  return side === 'long'
    ? stopPrice * (1 - buffer)
    : stopPrice * (1 + buffer)
}
