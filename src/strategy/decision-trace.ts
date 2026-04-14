import type {
  ActiveSetup,
  AnalystCard,
  CandleInterval,
  DecisionTrace,
  DecisionTraceTimelineEntry,
  ExchangeId,
  MarketRegime,
  StructureBreak,
} from '../types.js'
import type { WyckoffResult } from '../indicators/wyckoff.js'
import type { BiasResult } from './shared/bias.js'
import { applyRegimeModifier } from './shared/regime.js'

export interface StatusDecisionTraceInput {
  coin: string
  interval: CandleInterval
  exchange: ExchangeId
  regime: MarketRegime
  bias: BiasResult | null
  wyckoff: WyckoffResult
  breaks: StructureBreak[]
  activeCount: number
  ts?: number
}

export interface SetupDecisionTraceInput {
  setup: ActiveSetup
  regime: MarketRegime
  bias: BiasResult | null
  wyckoff: WyckoffResult
  breaks: StructureBreak[]
  activeCount: number
  ts?: number
}

const SYSTEM_STRATEGY_ID = 'system'

export function buildStatusDecisionTrace(input: StatusDecisionTraceInput): DecisionTrace {
  const ts = input.ts ?? Date.now()
  const bias = input.bias
  const biasSide = bias?.bias ?? 'neutral'
  const regimeModifier = biasSide === 'long' || biasSide === 'short'
    ? applyRegimeModifier(1, biasSide, input.regime)
    : 1
  const verdict = biasSide === 'neutral' ? 'reject' : 'watch'
  const outcomeSummary = biasSide === 'neutral'
    ? 'Scanner stays patient while structure remains mixed.'
    : `Scanner is leaning ${biasSide} and waiting for executable confirmation.`
  const traceId = `${SYSTEM_STRATEGY_ID}:${input.coin}|${input.interval}|status|${ts}`

  return {
    traceId,
    coin: input.coin,
    interval: input.interval,
    strategyId: SYSTEM_STRATEGY_ID,
    exchange: input.exchange,
    ts,
    regime: {
      state: input.regime,
      confidence: clamp01(bias?.confidence ?? 0),
      modifier: regimeModifier,
    },
    roles: {
      wyckoff: buildWyckoffCard(input.wyckoff),
      bull: buildDirectionalCard('Bull Analyst', 'bullish', bias, input.breaks, input.regime),
      bear: buildDirectionalCard('Bear Analyst', 'bearish', bias, input.breaks, input.regime),
      risk: buildStatusRiskCard(input.activeCount, input.regime),
      judge: {
        role: 'judge',
        verdict,
        confidence: clamp01(bias?.confidence ?? 0),
        summary: outcomeSummary,
        reasonsFor: buildJudgeReasonsFor(input.wyckoff, bias, input.breaks, input.regime),
        reasonsAgainst: buildJudgeReasonsAgainst(input.wyckoff, bias, input.breaks),
      },
    },
    timeline: buildInitialTimeline(ts, 'scanner', verdict, outcomeSummary),
    outcome: {
      action: 'skip',
      confidence: clamp01(bias?.confidence ?? 0),
      summary: outcomeSummary,
    },
  }
}

export function buildSetupDecisionTrace(input: SetupDecisionTraceInput): DecisionTrace {
  const ts = input.ts ?? input.setup.detectedAt
  const strategyId = input.setup.strategyId ?? SYSTEM_STRATEGY_ID
  const regimeModifier = applyRegimeModifier(1, input.setup.side, input.regime)
  const rr = computeRiskReward(input.setup.entryPrice, input.setup.slPrice, input.setup.tpPrice)
  const grade = input.setup.confluenceGrade ?? 'C'
  const zoneOrigin = getStringData(input.setup.patternData, 'zoneOrigin')
  const pattern = getStringData(input.setup.patternData, 'pattern')
  const regimeTag = getStringData(input.setup.patternData, 'regime')
  const summaryParts = [
    `${strategyId} proposes a ${input.setup.side.toUpperCase()} setup on ${input.setup.coin} ${input.setup.interval}.`,
    `Grade ${grade} at ${Math.round(input.setup.confidence * 100)}% confidence.`,
  ]
  if (zoneOrigin !== null) summaryParts.push(`Zone: ${zoneOrigin}.`)
  if (pattern !== null) summaryParts.push(`Trigger: ${pattern}.`)

  const traceId = `${strategyId}:${input.setup.coin}|${input.setup.interval}|setup|${ts}`
  return {
    traceId,
    coin: input.setup.coin,
    interval: input.setup.interval,
    strategyId,
    exchange: input.setup.exchange,
    ts,
    regime: {
      state: input.regime,
      confidence: clamp01(input.setup.confidence),
      modifier: regimeModifier,
    },
    roles: {
      wyckoff: buildWyckoffCard(input.wyckoff),
      bull: buildDirectionalCard('Bull Analyst', 'bullish', input.bias, input.breaks, input.regime),
      bear: buildDirectionalCard('Bear Analyst', 'bearish', input.bias, input.breaks, input.regime),
      risk: buildSetupRiskCard(input.activeCount, rr, input.setup.side, input.regime),
      judge: {
        role: 'judge',
        verdict: grade === 'C' ? 'watch' : 'approve',
        confidence: clamp01(input.setup.confidence),
        summary: summaryParts.join(' '),
        reasonsFor: buildSetupReasonsFor(input.setup, rr, regimeTag),
        reasonsAgainst: buildSetupReasonsAgainst(input.setup, rr, input.bias),
      },
      executor: {
        role: 'executor',
        state: 'idle',
        summary: 'Setup is staged for the agent state machine and waiting on execution rules.',
      },
    },
    timeline: buildInitialTimeline(
      ts,
      'judge',
      grade === 'C' ? 'watch' : 'approve',
      summaryParts.join(' '),
    ),
    outcome: {
      action: 'watch',
      confidence: clamp01(input.setup.confidence),
      summary: summaryParts.join(' '),
      setupId: input.setup.id,
    },
  }
}

function buildInitialTimeline(
  ts: number,
  actor: DecisionTraceTimelineEntry['actor'],
  action: string,
  summary: string,
): DecisionTraceTimelineEntry[] {
  return [{ ts, actor, action, summary }]
}

function buildWyckoffCard(wyckoff: WyckoffResult): AnalystCard {
  const phase = wyckoff.phase
  const event = wyckoff.event
  const stance = phaseToStance(phase)
  const evidence: string[] = []
  if (phase !== null) evidence.push(`Phase: ${phase}`)
  if (event !== null) evidence.push(`Event: ${event}`)
  if (evidence.length === 0) evidence.push('No clear Wyckoff phase yet')

  return {
    role: 'Wyckoff Specialist',
    stance,
    confidence: clamp01(wyckoff.confidence),
    summary: phase === null
      ? 'Wyckoff context is inconclusive on this bar.'
      : `Wyckoff reads ${phase}${event === null ? '' : ` with ${event}`}.`,
    evidence,
    veto: phase === null ? 'Wait for clearer phase behavior.' : null,
  }
}

function buildDirectionalCard(
  role: string,
  target: 'bullish' | 'bearish',
  bias: BiasResult | null,
  breaks: StructureBreak[],
  regime: MarketRegime,
): AnalystCard {
  const agrees =
    (target === 'bullish' && bias?.bias === 'long') ||
    (target === 'bearish' && bias?.bias === 'short')
  const conflicts =
    (target === 'bullish' && bias?.bias === 'short') ||
    (target === 'bearish' && bias?.bias === 'long')

  const evidence = collectBreakEvidence(target, breaks)
  evidence.push(`Regime: ${regime}`)
  if (bias?.source !== undefined) evidence.push(`Bias source: ${bias.source}`)

  return {
    role,
    stance: target,
    confidence: clamp01(
      agrees ? bias?.confidence ?? 0.25 : conflicts ? 0.15 : 0.3,
    ),
    summary: agrees
      ? `${role} sees structure aligned with the ${target} case.`
      : conflicts
        ? `${role} is outvoted by current structure and waits.`
        : `${role} is tracking a possible ${target} path but lacks confirmation.`,
    evidence,
    veto: conflicts ? `Current bias is ${bias?.bias ?? 'neutral'}.` : null,
  }
}

function buildStatusRiskCard(activeCount: number, regime: MarketRegime): AnalystCard {
  const evidence = [
    `Active setups: ${activeCount}`,
    `Regime filter: ${regime}`,
    'No executable order yet',
  ]
  return {
    role: 'Risk Manager',
    stance: 'neutral',
    confidence: activeCount > 0 ? 0.55 : 0.45,
    summary: 'Risk stays conservative until a setup survives confluence and entry rules.',
    evidence,
    veto: null,
  }
}

function buildSetupRiskCard(
  activeCount: number,
  rr: number | null,
  side: 'long' | 'short',
  regime: MarketRegime,
): AnalystCard {
  const evidence = [
    `Side: ${side}`,
    `Regime filter: ${regime}`,
    `Active setups: ${activeCount}`,
  ]
  if (rr !== null) evidence.push(`R:R 1:${rr.toFixed(2)}`)

  return {
    role: 'Risk Manager',
    stance: 'neutral',
    confidence: rr !== null && rr >= 1.5 ? 0.7 : 0.5,
    summary: rr !== null && rr >= 1.5
      ? 'Risk is acceptable if portfolio and execution checks stay green.'
      : 'Risk is tradable but not yet exceptional; execution guards still decide.',
    evidence,
    veto: rr !== null && rr < 1
      ? 'Reward is too close to the stop distance.'
      : null,
  }
}

function buildJudgeReasonsFor(
  wyckoff: WyckoffResult,
  bias: BiasResult | null,
  breaks: StructureBreak[],
  regime: MarketRegime,
): string[] {
  const reasons: string[] = []
  if (wyckoff.phase !== null) reasons.push(`Wyckoff phase ${wyckoff.phase}`)
  if (bias?.source !== undefined) reasons.push(`Bias source ${bias.source}`)
  const latest = breaks[breaks.length - 1]
  if (latest !== undefined) reasons.push(`Latest break: ${latest.kind} ${latest.direction}`)
  reasons.push(`Regime context ${regime}`)
  return reasons
}

function buildJudgeReasonsAgainst(
  wyckoff: WyckoffResult,
  bias: BiasResult | null,
  breaks: StructureBreak[],
): string[] {
  const reasons: string[] = []
  if (wyckoff.phase === null) reasons.push('Wyckoff phase is not established')
  if (bias?.bias === 'neutral' || bias === null) reasons.push('Directional bias is neutral')
  if (breaks.length === 0) reasons.push('No recent BOS/CHoCH evidence')
  if (reasons.length === 0) reasons.push('Execution trigger still pending')
  return reasons
}

function buildSetupReasonsFor(
  setup: ActiveSetup,
  rr: number | null,
  regimeTag: string | null,
): string[] {
  const reasons = [
    `Confluence ${setup.confluenceGrade ?? 'C'} (${setup.confluenceCount ?? 0})`,
    `${setup.side.toUpperCase()} setup on ${setup.interval}`,
  ]
  if (rr !== null) reasons.push(`R:R 1:${rr.toFixed(2)}`)
  if (regimeTag !== null) reasons.push(`Strategy regime ${regimeTag}`)
  return reasons
}

function buildSetupReasonsAgainst(
  setup: ActiveSetup,
  rr: number | null,
  bias: BiasResult | null,
): string[] {
  const reasons: string[] = []
  if ((setup.confluenceGrade ?? 'C') === 'C') reasons.push('Grade C does not auto-promote conviction')
  if (rr !== null && rr < 1.5) reasons.push('Risk/reward is below the stronger target zone')
  if (bias?.bias === 'neutral') reasons.push('Top-down bias is still neutral')
  if (reasons.length === 0) reasons.push('Position sizing and execution checks still pending')
  return reasons
}

function collectBreakEvidence(target: 'bullish' | 'bearish', breaks: StructureBreak[]): string[] {
  const relevant = breaks.filter(br => br.direction === target).slice(-2)
  if (relevant.length === 0) return ['No recent structural break in this direction']
  return relevant.map(br => `${br.kind.toUpperCase()} at ${fmtLevel(br.level)}`)
}

function computeRiskReward(entry: number, sl: number, tp: number): number | null {
  const risk = Math.abs(entry - sl)
  if (!Number.isFinite(risk) || risk === 0) return null
  const reward = Math.abs(tp - entry)
  if (!Number.isFinite(reward)) return null
  return reward / risk
}

function phaseToStance(phase: WyckoffResult['phase']): 'bullish' | 'bearish' | 'neutral' {
  if (phase === 'accumulation' || phase === 'markup') return 'bullish'
  if (phase === 'distribution' || phase === 'markdown') return 'bearish'
  return 'neutral'
}

function getStringData(patternData: Record<string, unknown>, key: string): string | null {
  const value = patternData[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fmtLevel(level: number): string {
  return level >= 1000 ? level.toFixed(0) : level >= 10 ? level.toFixed(2) : level.toFixed(4)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}
