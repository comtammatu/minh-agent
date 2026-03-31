/**
 * Layered Decision Framework — pipeline orchestrator.
 *
 * Replaces the flat engine.ts with a 5-layer sequential pipeline + regime context.
 * Only file with module-level state (activeSetups, lastCandleTs, statusState).
 *
 * Flow per WS tick:
 *   1. Append candle to store (always)
 *   2. Closed-candle gate: skip if same timestamp (candle still forming)
 *   3. Readiness check: enough candles?
 *   4. Shared context: pivots, regime (parallel with layers)
 *   5. Layer 1: Bias (Wyckoff + SMC + HTF) → neutral = STOP
 *   6. Layer 2: Structure (PA swings) → deny = STOP
 *   7. Layer 3: Zones (bias-filtered) → empty = STOP
 *   8. Layer 4: Confirm (isAtZone + VSA/VP boosts)
 *   9. Layer 5: Trigger (PA pattern at zone) → null = wait
 *  10. Confluence + Regime + Risk → grade C or not tradeable = STOP
 *  11. Track + Alert + Invalidate
 */

import type {
  Candle,
  CandleInterval,
  ActiveSetup,
  MarketRegime,
  Signal,
  ConfluenceGrade,
} from '../types.js'
import { appendCandle, getCandles } from '../feed/store.js'
import { getLatestDelta } from '../feed/trades.js'
import { getLatestBook } from '../feed/orderbook.js'
import { getLatestFunding } from '../feed/funding.js'
import { getOiDelta, hasDivergence } from '../feed/asset-ctx.js'
import type { OrderFlowContext } from './layers/confirm.js'
import { detectRegime } from '../indicators/core.js'
import { findPivots } from '../indicators/smc.js'
import { classifySwings } from '../indicators/structure.js'
import { determineBias } from './layers/bias.js'
import { confirmStructure } from './layers/structure.js'
import { findEntryZones } from './layers/zones.js'
import { confirmZones } from './layers/confirm.js'
import { findTrigger } from './layers/trigger.js'
import { scoreConfluence } from './confluence.js'
import { applyRegimeModifier } from './regime.js'
import { assessRisk } from './risk-filter.js'
import { isInvalidated, computeExpiresAtBar, setupId } from './invalidation.js'
import { atr } from '../indicators/core.js'
import {
  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  MIN_CANDLES_FOR_SCAN,
  INDICATOR_WINDOW,
  HTF_MAP,
  SIMULATED_ACCOUNT,
} from '../config.js'
import { getExchangeService } from '../execution/exchange-service.js'
import { EventEmitter } from 'events'
import { ANSI, formatSide, formatGrade } from '../ui/terminal.js'
import { playSound } from '../ui/sound.js'

// ── Pipeline Diagnostic Stats ────────────────────────────────────────────────

export interface PipelineStats {
  /** Total closed candles processed (entered runPipeline). */
  totalTicks: number
  /** Passed Layer 1 — bias is non-neutral. */
  passL1Bias: number
  /** Passed Layer 2 — structure not deny. */
  passL2Structure: number
  /** Passed Layer 3 — zones non-empty. */
  passL3Zones: number
  /** Passed Layer 4+5 — trigger found (confirm→trigger chain). */
  passL5Trigger: number
  /** Passed confluence gate (grade B+). */
  passConfluence: number
  /** Passed risk filter. */
  passRisk: number
  /** Passed regime modifier (final confidence ≥ MIN_CONFIDENCE). */
  passRegime: number
  /** Setups tracked (signal fully qualified). */
  setupsTracked: number
  /** Setups invalidated. */
  setupsInvalidated: number
  /** Layer 3 detail: total zones before freshness filter. */
  l3ZonesTotal: number
  /** Layer 3 detail: zones after freshness filter. */
  l3ZonesFresh: number
  /** Layer 4 detail: zones at zone (isAtZone true). */
  l4ZonesAtZone: number
  /** Layer 4 detail: zones confirmed (boost threshold met). */
  l4ZonesConfirmed: number
}

function zeroPipelineStats(): PipelineStats {
  return {
    totalTicks: 0,
    passL1Bias: 0,
    passL2Structure: 0,
    passL3Zones: 0,
    passL5Trigger: 0,
    passConfluence: 0,
    passRisk: 0,
    passRegime: 0,
    setupsTracked: 0,
    setupsInvalidated: 0,
    l3ZonesTotal: 0,
    l3ZonesFresh: 0,
    l4ZonesAtZone: 0,
    l4ZonesConfirmed: 0,
  }
}

let pipelineStats = zeroPipelineStats()

/** Get current pipeline diagnostic stats. */
export function getPipelineStats(): PipelineStats {
  return { ...pipelineStats }
}

/** Reset pipeline diagnostic stats (call before backtest run). */
export function resetPipelineStats(): void {
  pipelineStats = zeroPipelineStats()
}

/** Format pipeline stats as a human-readable report. */
export function formatPipelineStats(stats: PipelineStats): string {
  const t = stats.totalTicks
  const pct = (n: number) => t > 0 ? `${(n / t * 100).toFixed(2)}%` : '0%'
  const lines = [
    '=== PIPELINE DIAGNOSTIC STATS ===',
    `Total ticks:         ${t}`,
    `L1 Bias pass:        ${stats.passL1Bias} (${pct(stats.passL1Bias)})`,
    `L2 Structure pass:   ${stats.passL2Structure} (${pct(stats.passL2Structure)})`,
    `L3 Zones pass:       ${stats.passL3Zones} (${pct(stats.passL3Zones)})`,
    `  L3 total zones:    ${stats.l3ZonesTotal}`,
    `  L3 fresh zones:    ${stats.l3ZonesFresh} (${stats.l3ZonesTotal > 0 ? (stats.l3ZonesFresh / stats.l3ZonesTotal * 100).toFixed(1) + '%' : '0%'} fresh)`,
    `  L4 zones at zone:  ${stats.l4ZonesAtZone}`,
    `  L4 zones confirmed:${stats.l4ZonesConfirmed}`,
    `L5 Trigger pass:     ${stats.passL5Trigger} (${pct(stats.passL5Trigger)})`,
    `Confluence pass:     ${stats.passConfluence} (${pct(stats.passConfluence)})`,
    `Risk pass:           ${stats.passRisk} (${pct(stats.passRisk)})`,
    `Regime pass:         ${stats.passRegime} (${pct(stats.passRegime)})`,
    `Setups tracked:      ${stats.setupsTracked}`,
    `Setups invalidated:  ${stats.setupsInvalidated}`,
    '=================================',
  ]
  return lines.join('\n')
}

// ── Module-level state ──────────────────────────────────────────────────────

const activeSetups = new Map<string, ActiveSetup>()

/**
 * Pipeline EventEmitter (R10).
 * Emits 'setup' when a new setup is tracked, 'invalidation' when one is removed.
 * Agent subscribes via getPipelineEmitter().
 */
const pipelineEmitter = new EventEmitter()

/** Get the pipeline event emitter for agent subscription. */
export function getPipelineEmitter(): EventEmitter {
  return pipelineEmitter
}
const lastCandleTs = new Map<string, number>()

export interface StatusSnapshot {
  coin: string
  interval: CandleInterval
  regime: MarketRegime
  bias: string
  biasConfidence: number
  confluenceGrade: ConfluenceGrade | null
  activeCount: number
  lastUpdateAt: number
}

const statusState = new Map<string, StatusSnapshot>()

// ── Public API ───────────────────────────────────────────────────────────────

/** Called by WS subscription on every candle tick. */
export function onCandleTick(
  coin: string,
  interval: CandleInterval,
  candle: Candle,
): void {
  // Always store latest candle data
  appendCandle(coin, interval, candle)

  // ── Closed-candle gate ──────────────────────────────────────────────────
  const sk = `${coin}:${interval}`
  const prevTs = lastCandleTs.get(sk)

  if (prevTs === candle.t) return  // same candle still forming
  lastCandleTs.set(sk, candle.t)

  // First tick for this coin/tf — no previous closed candle yet
  if (prevTs === undefined) return

  const candles = getCandles(coin, interval, INDICATOR_WINDOW)
  if (candles.length < MIN_CANDLES_FOR_SCAN + 1) return

  // Scan on the CLOSED candle (second-to-last)
  const idx = candles.length - 2

  runPipeline(coin, interval, candles, idx)
}

/** Get current status snapshots for all coin/tf combinations. */
export function getStatus(): StatusSnapshot[] {
  return Array.from(statusState.values())
}

/** Get all currently active setups. */
export function getActiveSetups(): ActiveSetup[] {
  return Array.from(activeSetups.values())
}

/** Get unique list of coins that have at least one active setup. */
export function getActiveSetupCoins(): string[] {
  const coins = new Set<string>()
  for (const setup of activeSetups.values()) {
    coins.add(setup.coin)
  }
  return Array.from(coins)
}

/** Clear state for a specific coin (all timeframes). */
export function clearCoinState(coin: string): void {
  const prefix = `${coin}:`
  for (const k of activeSetups.keys()) { if (k.startsWith(prefix)) activeSetups.delete(k) }
  for (const k of statusState.keys()) { if (k.startsWith(prefix)) statusState.delete(k) }
  for (const k of lastCandleTs.keys()) { if (k.startsWith(prefix)) lastCandleTs.delete(k) }
}

/** Clear all state — used in tests and backtest engine. */
export function clearPipelineState(): void {
  activeSetups.clear()
  statusState.clear()
  lastCandleTs.clear()
  resetPipelineStats()
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

function runPipeline(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): void {
  const sk = `${coin}:${interval}`
  const confirmedSlice = candles.slice(0, idx + 1)

  pipelineStats.totalTicks++

  // ── Shared context (computed once per tick) ────────────────────────────
  const pivots = findPivots(confirmedSlice, idx, 3)
  const regime = detectRegime(confirmedSlice, idx)
  const swings = classifySwings(confirmedSlice, idx)

  // ── Layer 1: Bias ──────────────────────────────────────────────────────
  const htfInterval = HTF_MAP[interval]
  const htfCandles = htfInterval !== interval
    ? getCandles(coin, htfInterval, INDICATOR_WINDOW)
    : []  // same TF (1d→1d) → no HTF check

  const bias = determineBias(confirmedSlice, idx, htfCandles, pivots)

  // Update status (even if bias is neutral — show current state)
  const activeCount = countActiveSetupsFor(coin, interval)
  statusState.set(sk, {
    coin,
    interval,
    regime,
    bias: bias?.bias ?? 'neutral',
    biasConfidence: bias?.confidence ?? 0,
    confluenceGrade: null,
    activeCount,
    lastUpdateAt: Date.now(),
  })

  if (!bias || bias.bias === 'neutral') {
    // STOP — invalidate existing setups still
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL1Bias++

  // ── Layer 2: Structure ─────────────────────────────────────────────────
  const verdict = confirmStructure(confirmedSlice, idx, bias, swings)
  if (verdict === 'deny') {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL2Structure++

  // ── Layer 3: Zones ─────────────────────────────────────────────────────
  const zonesResult = findEntryZones(confirmedSlice, idx, bias)
  const zones = zonesResult.zones
  // Diagnostic: total vs fresh zone counts
  pipelineStats.l3ZonesTotal += zonesResult.totalBeforeFilter
  pipelineStats.l3ZonesFresh += zones.length
  if (zones.length === 0) {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL3Zones++

  // ── Layer 4: Confirm ───────────────────────────────────────────────────
  const orderFlow: OrderFlowContext = {
    delta: getLatestDelta(coin),
    book: getLatestBook(coin),
    funding: getLatestFunding(coin),
    oiDelta: getOiDelta(coin),
    divergenceWarning: hasDivergence(coin),
    signalSide: bias.bias as 'long' | 'short',
  }
  const confirmed = confirmZones(confirmedSlice, idx, zones, orderFlow)

  // L4 diagnostic detail
  pipelineStats.l4ZonesAtZone += confirmed.length
  pipelineStats.l4ZonesConfirmed += confirmed.filter(z => z.confirmed).length

  // ── Layer 5: Trigger ───────────────────────────────────────────────────
  const signal = findTrigger(confirmedSlice, idx, confirmed, bias)
  if (!signal) {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL5Trigger++

  // ── Confluence + Risk + Regime ─────────────────────────────────────────
  const bestZone = confirmed.length > 0 ? confirmed[0]! : null
  const confluence = scoreConfluence(bias, verdict, bestZone, signal, regime)

  // Update status with grade
  statusState.set(sk, {
    ...statusState.get(sk)!,
    confluenceGrade: confluence.grade,
    activeCount: activeCount + 1,
  })

  if (confluence.grade === 'C') {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passConfluence++

  // Risk filter
  const currentPrice = confirmedSlice[idx]!.c
  const atrVal = atr(confirmedSlice, idx, 14)
  const zone = bestZone?.zone ?? zones[0]!
  // R11: Use real account balance from ExchangeService, fallback to SIMULATED_ACCOUNT
  const accountValue = getExchangeService().getCachedAccountValue() || SIMULATED_ACCOUNT
  const risk = assessRisk(signal, zone, currentPrice, atrVal, accountValue)
  if (!risk.tradeable) {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passRisk++

  // Regime modifier on final confidence
  const finalConf = applyRegimeModifier(confluence.confidence, signal.side, regime)
  if (finalConf < MIN_CONFIDENCE) {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passRegime++

  // ── Track + Alert ──────────────────────────────────────────────────────
  const enrichedSignal: Signal = {
    ...signal,
    confidence: finalConf,
    biasSource: bias.source,
    confluenceGrade: confluence.grade,
    confluenceCount: confluence.count,
    zoneOrigin: zone.origin,
    riskAssessment: risk,
  }

  const id = setupId(coin, interval, signal.type)
  const existing = activeSetups.get(id)

  // Skip if already tracking with equal or higher confidence
  if (existing && existing.confidence >= finalConf) {
    invalidateSetups(coin, interval, confirmedSlice, idx)
    return
  }

  const setup: ActiveSetup = {
    ...enrichedSignal,
    id,
    coin,
    interval,
    detectedAt: Date.now(),
    detectedAtBar: idx,
    expiresAtBar: computeExpiresAtBar(signal.type, idx),
  }

  activeSetups.set(id, setup)
  pipelineStats.setupsTracked++
  if (existing) {
    console.log(
      `[${ts()}] ${ANSI.dim}↻ REPLACE${ANSI.reset} | ${coin} ${interval} | ${formatSide(existing.side)} ${existing.type} → ${formatSide(setup.side)} | conf ${existing.confidence.toFixed(2)} → ${setup.confidence.toFixed(2)}`,
    )
  }
  logSetupAlert(coin, interval, setup, regime, bias.source, confluence, risk)

  // R10: Emit setup event for agent subscription
  pipelineEmitter.emit('setup', setup)

  // Invalidate after processing
  invalidateSetups(coin, interval, confirmedSlice, idx)
}

// ── Private helpers ──────────────────────────────────────────────────────────

function invalidateSetups(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  currentBarIdx: number,
): void {
  for (const [id, setup] of activeSetups) {
    if (setup.coin !== coin || setup.interval !== interval) continue

    const result = isInvalidated(setup, candles, currentBarIdx)
    if (result.invalidated) {
      const age = currentBarIdx - (setup.expiresAtBar - (PATTERN_TTL_BARS_LOOKUP[setup.type] ?? 10))
      console.log(
        `[${ts()}] ${ANSI.yellow}⚠ INVALID${ANSI.reset} | ${coin} ${interval} | ${setup.type} ${formatSide(setup.side)} | reason: ${result.reason} | lived ${Math.max(age, 0)} bars`,
      )
      activeSetups.delete(id)
      pipelineStats.setupsInvalidated++
      // R10: Emit invalidation event for agent subscription
      pipelineEmitter.emit('invalidation', id, result.reason ?? 'unknown')
    }
  }
}

// Import TTL for age calculation
import { PATTERN_TTL_BARS } from '../config.js'
const PATTERN_TTL_BARS_LOOKUP = PATTERN_TTL_BARS

function countActiveSetupsFor(coin: string, interval: CandleInterval): number {
  let count = 0
  for (const setup of activeSetups.values()) {
    if (setup.coin === coin && setup.interval === interval) count++
  }
  return count
}

function logSetupAlert(
  coin: string,
  interval: CandleInterval,
  setup: ActiveSetup,
  regime: MarketRegime,
  biasSource: string,
  confluence: { grade: ConfluenceGrade; count: number; confidence: number },
  risk: { suggestedSize: string; minRR: number },
): void {
  const rrRaw = Math.abs(setup.tpPrice - setup.entryPrice) / Math.abs(setup.entryPrice - setup.slPrice)
  const rr = isNaN(rrRaw) ? 0 : rrRaw

  const isAligned =
    (setup.side === 'long' && regime === 'BULL') ||
    (setup.side === 'short' && regime === 'BEAR')

  const regimeTag = isAligned ? `${regime} aligned` : regime

  // Layered format per Sprint 1 Step 3 spec — ANSI enhanced (S15)
  console.log(
    `[${ts()}] ${ANSI.bold}⚡ SETUP${ANSI.reset} | ${coin} ${interval.toUpperCase()} | ${formatSide(setup.side)} ${setup.type} at ${setup.zoneOrigin ?? 'zone'} | ` +
    `${formatGrade(confluence.grade)} (${confluence.count}/7) | conf:${setup.confidence.toFixed(2)} | ${regimeTag}`,
  )
  console.log(
    `         entry:${fmt(setup.entryPrice)} sl:${fmt(setup.slPrice)} tp:${fmt(setup.tpPrice)} | ` +
    `R:R 1:${rr.toFixed(2)} | bias:${biasSource} | structure:${setup.confluenceGrade ?? '-'}`,
  )

  // VSA/VP boosts from patternData
  const pd = setup.patternData
  const vsaBoost = pd['vsaBoost'] as number | undefined
  const vpBoost = pd['vpBoost'] as number | undefined
  const pattern = pd['pattern'] as string | undefined
  const throughZone = pd['throughZone'] as boolean | undefined

  const deltaBoost = pd['deltaBoost'] as number | undefined
  const bookBoost = pd['bookBoost'] as number | undefined
  const fundingBoost = pd['fundingBoost'] as number | undefined
  const oiBoost = pd['oiBoost'] as number | undefined
  const divergenceWarning = pd['divergenceWarning'] as boolean | undefined

  const boostParts: string[] = []
  if (vsaBoost && vsaBoost > 0) boostParts.push(`VSA(+${vsaBoost.toFixed(2)})`)
  if (vpBoost && vpBoost !== 0) boostParts.push(`VP(${vpBoost > 0 ? '+' : ''}${vpBoost.toFixed(2)})`)
  if (deltaBoost && deltaBoost > 0) boostParts.push(`Δ(+${deltaBoost.toFixed(2)})`)
  if (bookBoost && bookBoost > 0) boostParts.push(`Book(+${bookBoost.toFixed(2)})`)
  if (fundingBoost && fundingBoost > 0) boostParts.push(`Fund(+${fundingBoost.toFixed(2)})`)
  if (oiBoost && oiBoost > 0) boostParts.push(`OI(+${oiBoost.toFixed(2)})`)
  if (divergenceWarning) boostParts.push('⚠DIV')
  if (throughZone) boostParts.push('through-zone')

  console.log(
    `         ${boostParts.length > 0 ? boostParts.join(' ') + ' | ' : ''}` +
    `trigger:${pattern ?? setup.type} | risk:${risk.suggestedSize}`,
  )

  // S15: Sound alert for grade B+ setups
  if (confluence.grade === 'B' || confluence.grade === 'A' || confluence.grade === 'A+') {
    playSound()
  }
}

function fmt(n: number): string {
  return n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(2) : n.toFixed(4)
}

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}
