/**
 * Layered 5-layer Wyckoff/SMC pipeline.
 *
 * Flow per closed candle:
 *   L1 Bias → L2 Structure → L3 Zones → L4 Confirm → L5 Trigger
 *   → R:R gate → Confluence + Risk + Regime → Track + Alert
 */

import type {
  Candle,
  CandleInterval,
  ActiveSetup,
  MarketRegime,
  Signal,
  ConfluenceGrade,
} from '../../../types.js'
import { getCandles } from '../../../feed/store.js'
import { getLatestDelta } from '../../../feed/trades.js'
import { getLatestBook } from '../../../feed/orderbook.js'
import { getLatestFunding } from '../../../feed/funding.js'
import { getOiDelta, hasDivergence } from '../../../feed/asset-ctx.js'
import type { OrderFlowContext } from './layers/confirm.js'
import { detectRegime } from '../../../indicators/core.js'
import { findPivots } from '../../../indicators/smc.js'
import { classifySwings } from '../../../indicators/price-action.js'
import { determineBias } from './layers/bias.js'
import { confirmStructure } from './layers/structure.js'
import { findEntryZones } from './layers/zones.js'
import { confirmZones } from './layers/confirm.js'
import { findTrigger } from './layers/trigger.js'
import { detectPriceAction } from '../../../indicators/price-action.js'
import { scoreConfluence } from './confluence.js'
import { applyRegimeModifier } from '../../shared/regime.js'
import { assessRisk } from './risk-filter.js'
import { isInvalidated, computeExpiresAtBar, setupId } from '../../shared/invalidation.js'
import { atr } from '../../../indicators/core.js'
import {
  MIN_CONFIDENCE,
  CONFLUENCE_MIN,
  MIN_CANDLES_FOR_SCAN,
  INDICATOR_WINDOW,
  HTF_MAP,
  MIN_TP1_RR,
  PATTERN_TTL_BARS,
  getEffectivePaperTrade,
  getActiveExchange,
} from '../../../config.js'
import { getCachedAccountValueForStrategy } from '../../../execution/exchange-pool.js'
import { getPaperTracker } from '../../../agent/paper-tracker.js'
import { playSound } from '../../../ui/sound.js'
import { log } from '../../../lib/logger.js'
import { getOrCreateStats } from '../../diagnostics.js'
import { getStatusState, getActiveSetupsMap, getPipelineEmitter } from '../../orchestrator.js'

// Re-export runPipeline as runLayeredPipeline for strategy adapter
export { runPipeline as runLayeredPipeline }

// Re-export clearLayeredState for strategy adapter
export { clearLayeredState } from '../../orchestrator.js'

const PATTERN_TTL_BARS_LOOKUP = PATTERN_TTL_BARS

// ── Pipeline ─────────────────────────────────────────────────────────────────

/** Layered 5-layer Wyckoff/SMC pipeline. Pure computation, emits via pipelineEmitter. */
export function runPipeline(
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  idx: number,
): void {
  const sk = `${coin}|${interval}`
  const confirmedSlice = candles.slice(0, idx + 1)
  const pipelineStats = getOrCreateStats('layered')
  const statusState = getStatusState()
  const activeSetups = getActiveSetupsMap()

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
  const activeCount = countActiveSetupsFor(activeSetups, coin, interval)
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
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL1Bias++

  // ── Layer 2: Structure ─────────────────────────────────────────────────
  const verdict = confirmStructure(confirmedSlice, idx, bias, swings)
  if (verdict === 'deny') {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
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
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
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
  const atZoneResults = confirmZones(confirmedSlice, idx, zones, orderFlow)

  // L4 diagnostic detail
  pipelineStats.l4ZonesAtZone += atZoneResults.length
  pipelineStats.l4ZonesConfirmed += atZoneResults.filter(z => z.confirmed).length

  // L4 hard filter: only pass zones with volume confirmation (VSA/VP/OF/throughZone)
  // Per spec Section 9.2: "volume im ắng → zone yếu, nên skip"
  const confirmed = atZoneResults.filter(z => z.confirmed)
  if (confirmed.length === 0) {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }

  // ── Layer 5: Trigger ───────────────────────────────────────────────────
  const signal = findTrigger(confirmedSlice, idx, confirmed, bias)
  if (!signal) {
    // L5 rejection diagnostic — only when confirmed zones exist
    if (confirmed.length > 0) {
      const rawPatterns = detectPriceAction(confirmedSlice, idx)
      if (rawPatterns.length === 0) {
        pipelineStats.l5NoPatternsDetected++
      } else {
        pipelineStats.l5WrongDirection++
      }
      pipelineStats.l5Rejections.push({
        coin,
        interval,
        idx,
        ts: confirmedSlice[idx]!.t,
        patternsDetected: rawPatterns.map(p => `${p.name}(${p.direction})`),
        biasDir: bias.bias,
        confirmedCount: confirmed.filter(z => z.confirmed).length,
      })
    }
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passL5Trigger++

  // ── R:R geometry gate ─────────────────────────────────────────────────
  // Reject setups where planned R:R is below MIN_TP1_RR (1.5).
  const slDist = Math.abs(signal.entryPrice - signal.slPrice)
  const tpDist = Math.abs(signal.tpPrice - signal.entryPrice)
  const plannedRR = slDist > 0 ? tpDist / slDist : 0
  if (plannedRR < MIN_TP1_RR) {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }

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
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passConfluence++

  // Risk filter
  const currentPrice = confirmedSlice[idx]!.c
  const atrVal = atr(confirmedSlice, idx, 14)
  const zone = bestZone?.zone ?? zones[0]!
  // R11: Balance for this strategy's wallet (pool) or singleton fallback
  // Paper mode: PaperTracker for `layered` (mirrors live multi-wallet)
  const accountValue = getEffectivePaperTrade()
    ? getPaperTracker('layered').getBalance()
    : getCachedAccountValueForStrategy('layered')
  const risk = assessRisk(signal, zone, currentPrice, atrVal, accountValue)
  if (!risk.tradeable) {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
    return
  }
  pipelineStats.passRisk++

  // Regime modifier on final confidence
  const finalConf = applyRegimeModifier(confluence.confidence, signal.side, regime)
  if (finalConf < MIN_CONFIDENCE) {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
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

  const id = setupId(coin, interval, signal.type, 'layered')
  const existing = activeSetups.get(id)

  // Skip if already tracking with equal or higher confidence
  if (existing && existing.confidence >= finalConf) {
    invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
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
    exchange: getActiveExchange(),
  }

  activeSetups.set(id, setup)
  pipelineStats.setupsTracked++
  if (existing) {
    log.info('pipeline', `↻ REPLACE | ${coin} ${interval} | ${existing.side.toUpperCase()} ${existing.type} → ${setup.side.toUpperCase()} | conf ${existing.confidence.toFixed(2)} → ${setup.confidence.toFixed(2)}`)
  }
  logSetup(coin, interval, setup, regime, bias.source, confluence, risk)

  // R10: Emit setup event for agent subscription
  const pipelineEmitter = getPipelineEmitter()
  pipelineEmitter.emit('setup', setup)

  // Invalidate after processing
  invalidateSetups(activeSetups, pipelineStats, coin, interval, confirmedSlice, idx)
}

// ── Private helpers ──────────────────────────────────────────────────────────

function invalidateSetups(
  activeSetups: Map<string, ActiveSetup>,
  pipelineStats: { setupsInvalidated: number },
  coin: string,
  interval: CandleInterval,
  candles: Candle[],
  currentBarIdx: number,
): void {
  const pipelineEmitter = getPipelineEmitter()
  for (const [id, setup] of activeSetups) {
    if (setup.coin !== coin || setup.interval !== interval) continue

    const result = isInvalidated(setup, candles, currentBarIdx)
    if (result.invalidated) {
      const age = currentBarIdx - (setup.expiresAtBar - (PATTERN_TTL_BARS_LOOKUP[setup.type] ?? 10))
      log.info('pipeline', `⚠ INVALID | ${coin} ${interval} | ${setup.type} ${setup.side.toUpperCase()} | reason: ${result.reason} | lived ${Math.max(age, 0)} bars`)
      activeSetups.delete(id)
      pipelineStats.setupsInvalidated++
      // R10: Emit invalidation event for agent subscription
      pipelineEmitter.emit('invalidation', id, result.reason ?? 'unknown')
    }
  }
}

function countActiveSetupsFor(
  activeSetups: Map<string, ActiveSetup>,
  coin: string,
  interval: CandleInterval,
): number {
  let count = 0
  for (const setup of activeSetups.values()) {
    if (setup.coin === coin && setup.interval === interval) count++
  }
  return count
}

function logSetup(
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

  const boostStr = boostParts.length > 0 ? boostParts.join(' ') + ' | ' : ''

  log.info('pipeline',
    `⚡ SETUP | ${coin} ${interval.toUpperCase()} [${setup.exchange}] | ${setup.side.toUpperCase()} ${setup.type} at ${setup.zoneOrigin ?? 'zone'} | ` +
    `${confluence.grade} (${confluence.count}/7) | conf:${setup.confidence.toFixed(2)} | ${regimeTag} | ` +
    `entry:${fmt(setup.entryPrice)} sl:${fmt(setup.slPrice)} tp:${fmt(setup.tpPrice)} | R:R 1:${rr.toFixed(2)} | bias:${biasSource} | ` +
    `ttl:${setup.expiresAtBar - setup.detectedAtBar}bars | ${boostStr}trigger:${pattern ?? setup.type} | risk:${risk.suggestedSize} | [${setup.strategyId ?? 'layered'}]`,
  )

  playAlertIfQualified(confluence.grade)
}

/** S15: Sound alert for grade B+ setups. */
function playAlertIfQualified(grade: ConfluenceGrade): void {
  if (grade === 'B' || grade === 'A' || grade === 'A+') {
    playSound()
  }
}

function fmt(n: number): string {
  return n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(2) : n.toFixed(4)
}
