/**
 * Telegram Bot Commands — command handlers.
 *
 * Each command returns a MarkdownV2-formatted reply string.
 * I/O (sending messages) happens in bot.ts.
 *
 * /help      — built-in, pure
 * /status    — reads agent snapshot + health report
 * /positions — reads position monitor
 * /pnl       — reads live metrics (async, hits DB)
 * /pause     — mutates agent state (pauseAll or per-coin with duration)
 * /resume    — mutates agent state (resumeAll)
 * /risk      — risk dashboard (PnL, CB, consecutive losses)
 * /closeall  — emergency close all (requires /confirm)
 * /confirm   — confirm pending /closeall or remote /operator action
 */

import { escapeHtml, escapeMarkdownV2 } from './alerts.js'
import {
  getBriefingRefreshHealth,
  getBriefingRefreshHistory,
  getBriefingRefreshIncidents,
  getBriefingRefreshStats,
} from './briefing-refresh-stats.js'
import { getAgent } from '../../agent/trading-agent.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import { getHealthMonitor } from '../../agent/self-healing.js'
import { getLiveMetrics } from '../../analytics/metrics-service.js'
import { closeAllPositions } from '../../agent/close-all.js'
import { getJournalEntries, logOperatorAuditEntry } from '../../agent/journal.js'
import { getOrderManager } from '../../agent/order-manager.js'
import {
  getDecisionTraceByPositionId,
  getDecisionTraceBySetupId,
  getDecisionTraces,
  getDecisionTracesForCoin,
  recordDecisionTraceAgentAction,
} from '../../strategy/index.js'
import {
  TELEGRAM_BOT,
  PAPER_TRADE,
  getEffectivePaperTrade,
  getPaperTradeRuntimeOverride,
  setPaperTradeRuntimeOverride,
} from '../../config.js'
import type { CommandDef } from './types.js'
import type { DecisionTrace } from '../../types.js'

// ─── Command Registry ──────────────────────────────────────────────────────

/** All registered commands. Mutable — S4-S6 will push more commands. */
const commands: CommandDef[] = []

/** Register a command. */
export function registerCommand(def: CommandDef): void {
  commands.push(def)
}

/** Get all registered commands (for routing). */
export function getCommands(): readonly CommandDef[] {
  return commands
}

/** Find a command by name. */
export function findCommand(name: string): CommandDef | null {
  return commands.find(c => c.name === name) ?? null
}

/** Reset registry (for testing). */
export function resetCommands(): void {
  commands.length = 0
}

// ─── /help ─────────────────────────────────────────────────────────────────

function helpHandler(): string {
  const esc = escapeMarkdownV2
  const lines = [
    `*Minh \\(明\\) — Trading Bot*`,
    ``,
    `Available commands:`,
  ]
  for (const cmd of commands) {
    lines.push(`/${esc(cmd.name)} — ${esc(cmd.description)}`)
  }
  return lines.join('\n')
}

// ─── /status ──────────────────────────────────────────────────────────────

function formatBriefingRefreshStatsLine(): string {
  const esc = escapeMarkdownV2
  const stats = getBriefingRefreshStats()
  const lastOutcome = stats.lastOutcome != null ? stats.lastOutcome.replace(/_/g, ' ') : 'none'
  return `Briefing: ${esc(String(stats.edited))} edited \\| ${esc(String(stats.skippedIdentical))} skipped \\| ${esc(String(stats.coalesced))} coalesced \\| last ${esc(lastOutcome)}`
}

function formatBriefingHistoryLine(limit = 3): string | null {
  const esc = escapeMarkdownV2
  const history = getBriefingRefreshHistory(limit)
  if (history.length === 0) return null

  return history
    .map(entry => {
      const state = `${entry.from}->${entry.to}`
      const target = entry.target != null ? ` ${entry.target}` : ''
      return `${esc(state)}${target.length > 0 ? ` ${esc(target.trim())}` : ''}`
    })
    .join(' \\| ')
}

function formatBriefingIncidentLine(limit = 2): string | null {
  const esc = escapeMarkdownV2
  const incidents = getBriefingRefreshIncidents(limit)
  if (incidents.length === 0) return null

  return incidents
    .map(incident => {
      const label = incident.status === 'recovered'
        ? `${incident.peakState} recovered`
        : `${incident.peakState} active`
      const target = incident.target != null ? ` ${incident.target}` : ''
      return `${esc(label)}${target.length > 0 ? ` ${esc(target.trim())}` : ''}`
    })
    .join(' \\| ')
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatTopCounts(counts: Map<string, number>): string {
  const esc = escapeMarkdownV2
  if (counts.size === 0) return `idle`

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([label, count]) => `${esc(label)} ${esc(String(count))}`)
    .join(' \\| ')
}

function formatBotActionSummary(traces: readonly DecisionTrace[]): string {
  const counts = new Map<string, number>()
  for (const trace of traces) {
    const action = trace.outcome.action.replace(/_/g, ' ').toUpperCase()
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  return formatTopCounts(counts)
}

function formatGuardianActivitySummary(traces: readonly DecisionTrace[]): string {
  const esc = escapeMarkdownV2
  const counts = new Map<string, number>()
  let active = 0

  for (const trace of traces) {
    const guardian = trace.roles.guardian
    if (guardian == null) continue
    active += 1
    const state = formatRoleState(guardian.state)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }

  if (active === 0) return `0 active`

  const topStates = formatTopCounts(counts)
  return `${esc(formatCountLabel(active, 'active case', 'active cases'))} \\| ${topStates}`
}

function formatBriefingHealthSummary(): string {
  const esc = escapeMarkdownV2
  const stats = getBriefingRefreshStats()
  const health = getBriefingRefreshHealth()

  const parts = [esc(health.state)]
  if (stats.requested === 0) parts.push(`idle`)
  parts.push(`${esc(String(Math.round(health.editRatio * 100)))}% edit`)
  if (stats.failed > 0) parts.push(`${esc(String(stats.failed))} failed`)
  parts.push(`${esc(String(stats.edited))}/${esc(String(stats.requested))} edited`)
  parts.push(`${esc(String(stats.skippedIdentical))} skipped`)
  parts.push(`${esc(String(stats.coalesced))} coalesced`)
  if (stats.lastOutcome != null) {
    parts.push(`last ${esc(stats.lastOutcome.replace(/_/g, ' '))}`)
  }
  return parts.join(' \\| ')
}

function formatBriefingDrilldownLine(): string | null {
  const esc = escapeMarkdownV2
  const health = getBriefingRefreshHealth()
  const pieces: string[] = []
  if (health.state === 'healthy' && health.recoveredFrom != null) {
    pieces.push(`recovered ${esc(health.recoveredFrom)}`)
    if (health.recoveredTarget != null) pieces.push(`target ${esc(health.recoveredTarget)}`)
    if (health.recoveredAttention != null) pieces.push(`attention ${esc(health.recoveredAttention)}`)
  } else {
    if (health.lastKind != null) pieces.push(esc(health.lastKind))
    if (health.lastOutcome != null) pieces.push(esc(health.lastOutcome.replace(/_/g, ' ')))
    if (health.lastTarget != null) pieces.push(`target ${esc(health.lastTarget)}`)
    if (health.lastAttention != null) pieces.push(`attention ${esc(health.lastAttention)}`)
  }
  if (pieces.length === 0) return null
  return pieces.join(' \\| ')
}

function statusHandler(): string {
  const esc = escapeMarkdownV2
  try {
    const snap = getAgent().getSnapshot()
    const health = getHealthMonitor().getReport()
    const posCount = getPositionMonitor().getPositions().size

    const uptimeMin = Math.floor(snap.global.uptime / 60_000)
    const uptimeH = Math.floor(uptimeMin / 60)
    const uptimeM = uptimeMin % 60

    const paused = snap.global.globalPaused
      ? `PAUSED \\(${esc(snap.global.globalPauseReason ?? 'unknown')}\\)`
      : 'RUNNING'

    const coinStates = Object.entries(snap.coins)
    const watching = coinStates.filter(([, c]) => c.state === 'WATCHING').length
    const inPos = coinStates.filter(([, c]) => c.state === 'IN_POSITION').length

    const ov = getPaperTradeRuntimeOverride()
    const modeLine = ov === null
      ? `Mode: ${esc(getEffectivePaperTrade() ? 'PAPER' : 'LIVE')} \\(env ${esc(PAPER_TRADE ? 'PAPER' : 'LIVE')}\\)`
      : `Mode: ${esc(getEffectivePaperTrade() ? 'PAPER' : 'LIVE')} \\(override ${esc(ov ? 'PAPER' : 'LIVE')}, env ${esc(PAPER_TRADE ? 'PAPER' : 'LIVE')}\\)`

    return [
      `*Status*`,
      modeLine,
      `Agent: ${paused}`,
      `Health: ${esc(health.overall)}`,
      `Uptime: ${esc(`${uptimeH}h ${uptimeM}m`)}`,
      `Daily PnL: ${esc(snap.global.dailyPnl.toFixed(2))} USDC`,
      `Positions: ${esc(String(posCount))}`,
      `Coins: ${esc(String(coinStates.length))} \\(${esc(String(watching))} watching, ${esc(String(inPos))} in\\-position\\)`,
      formatBriefingRefreshStatsLine(),
      ...(formatBriefingIncidentLine(2) != null ? [`Briefing incident: ${formatBriefingIncidentLine(2)}`] : []),
      ...(formatBriefingHistoryLine(2) != null ? [`Briefing history: ${formatBriefingHistoryLine(2)}`] : []),
    ].join('\n')
  } catch {
    return `Agent not initialized\\.`
  }
}

// ─── /positions ───────────────────────────────────────────────────────────

function positionsHandler(): string {
  const esc = escapeMarkdownV2
  try {
    const pm = getPositionMonitor()
    const posMap = pm.getPositions()

    if (posMap.size === 0) return `No open positions\\.`

    const lines: string[] = [`*Open Positions \\(${esc(String(posMap.size))}\\)*`, ``]

    for (const [, pos] of posMap) {
      const side = pos.side === 'long' ? 'LONG' : 'SHORT'
      const notional = pos.currentSize * pos.entryPrice
      lines.push(
        `*${esc(pos.coin)}* ${side}`,
        `  Entry: ${esc(pos.entryPrice.toFixed(2))} | Size: ${esc(pos.currentSize.toFixed(4))}`,
        `  Notional: ${esc(notional.toFixed(2))} USDC`,
        `  SL: ${esc(pos.slPrice.toFixed(2))} | TP: ${esc(pos.tpPrice.toFixed(2))}`,
        ``,
      )
    }

    return lines.join('\n')
  } catch {
    return `Agent not initialized\\.`
  }
}

// ─── /pnl ─────────────────────────────────────────────────────────────────

async function pnlHandler(): Promise<string> {
  const esc = escapeMarkdownV2
  try {
    const m = await getLiveMetrics()

    const fmt = (n: number) => esc(n.toFixed(2))
    const pct = (n: number) => esc((n * 100).toFixed(1))

    return [
      `*PnL Summary*`,
      ``,
      `*Daily:*  ${fmt(m.pnl.daily)} USDC \\| WR ${pct(m.winRate.daily)}% \\| ${esc(String(m.trades.daily))} trades`,
      `*Weekly:* ${fmt(m.pnl.weekly)} USDC \\| WR ${pct(m.winRate.weekly)}% \\| ${esc(String(m.trades.weekly))} trades`,
      `*Monthly:* ${fmt(m.pnl.monthly)} USDC \\| WR ${pct(m.winRate.monthly)}% \\| ${esc(String(m.trades.monthly))} trades`,
      `*All\\-time:* ${fmt(m.pnl.allTime)} USDC \\| WR ${pct(m.winRate.allTime)}% \\| ${esc(String(m.trades.allTime))} trades`,
      ``,
      `Drawdown: ${fmt(m.currentDrawdown)} \\(max ${fmt(m.maxDrawdown)}\\)`,
    ].join('\n')
  } catch {
    return `Failed to load metrics\\.`
  }
}

// ─── /pause ───────────────────────────────────────────────────────────────

/**
 * Parse per-coin pause args: "/pause BTC 4h" → { coin: 'BTC', durationMs: 14400000, label: '4h' }
 * Supported suffixes: m (minutes), h (hours), d (days).
 * Returns null if args don't match per-coin format (falls back to global pause).
 */
export function parsePauseCoinArgs(args: string): { coin: string; durationMs: number; label: string } | null {
  const parts = args.trim().split(/\s+/)
  if (parts.length < 2) return null

  const rawCoin = parts[0]
  const rawDuration = parts[1]
  if (!rawCoin || !rawDuration) return null

  const coin = rawCoin.toUpperCase()
  const durationStr = rawDuration.toLowerCase()
  const match = durationStr.match(/^(\d+)(m|h|d)$/)
  if (!match) return null

  const [, rawValue, unit] = match
  if (!rawValue || !unit) return null

  const value = parseInt(rawValue, 10)
  if (value <= 0 || isNaN(value)) return null

  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  const multiplier = multipliers[unit]
  if (multiplier === undefined) return null
  const durationMs = value * multiplier
  return { coin, durationMs, label: durationStr }
}

function pauseHandler(args: string): string {
  const esc = escapeMarkdownV2
  try {
    const agent = getAgent()
    const coinPause = parsePauseCoinArgs(args)

    if (coinPause) {
      // Per-coin pause with auto-resume timer
      const { coin, durationMs, label } = coinPause
      const state = agent.getCoinState(coin)
      if (state === 'IDLE' && !agent.getCoinContext(coin)) {
        return `Unknown coin: ${esc(coin)}`
      }
      agent.dispatch(coin, { type: 'pause', reason: `manual via Telegram (${label})` })
      // Schedule auto-resume
      setTimeout(() => {
        try { agent.dispatch(coin, { type: 'resume' }) } catch { /* agent may be gone */ }
      }, durationMs)
      return `${esc(coin)} paused for ${esc(label)}`
    }

    // Global pause (original behavior)
    const reason = args.trim() || 'manual via Telegram'
    agent.pauseAll(reason)
    return `Agent paused: ${esc(reason)}`
  } catch {
    return `Agent not initialized\\.`
  }
}

// ─── /resume ──────────────────────────────────────────────────────────────

function resumeHandler(): string {
  try {
    getAgent().resumeAll()
    return `Agent resumed\\.`
  } catch {
    return `Agent not initialized\\.`
  }
}

// ─── /risk ────────────────────────────────────────────────────────────────

function riskHandler(): string {
  const esc = escapeMarkdownV2
  try {
    const snap = getAgent().getSnapshot()
    const posCount = getPositionMonitor().getPositions().size

    const paused = snap.global.globalPaused ? 'YES' : 'NO'
    const cbTripped = snap.global.totalConsecutiveLosses >= 3 ? 'TRIPPED' : 'OK'

    // Per-coin consecutive losses (only show coins with losses > 0)
    const coinLosses: string[] = []
    for (const [coin, ctx] of Object.entries(snap.coins)) {
      if (ctx.consecutiveLosses > 0) {
        coinLosses.push(`  ${esc(coin)}: ${esc(String(ctx.consecutiveLosses))} consecutive`)
      }
    }

    const lines = [
      `*Risk Dashboard*`,
      ``,
      `Daily PnL: ${esc(snap.global.dailyPnl.toFixed(2))} USDC`,
      `Open positions: ${esc(String(posCount))}`,
      `Global paused: ${esc(paused)}`,
      `Circuit breaker: ${esc(cbTripped)} \\(${esc(String(snap.global.totalConsecutiveLosses))} consecutive losses\\)`,
    ]

    if (coinLosses.length > 0) {
      lines.push(``, `*Per\\-coin losses:*`)
      lines.push(...coinLosses)
    }

    return lines.join('\n')
  } catch {
    return `Agent not initialized\\.`
  }
}

// ─── /trace ───────────────────────────────────────────────────────────────

function formatTraceTimeline(trace: DecisionTrace): string[] {
  const esc = escapeMarkdownV2
  return trace.timeline.slice(-3).map(item => {
    const actor =
      item.actor === 'scanner'
        ? 'scanner'
        : item.actor === 'judge'
          ? 'judge'
          : item.actor === 'executor'
            ? 'executor'
            : 'guardian'
    return `  ${esc(actor)}: ${esc(item.summary)}`
  })
}

function formatRoleState(state: string): string {
  return state.replace(/_/g, ' ').toUpperCase()
}

function formatGuardianSnapshot(trace: DecisionTrace): string[] {
  const esc = escapeMarkdownV2
  const lines: string[] = []
  const guardian = trace.roles.guardian
  const executor = trace.roles.executor
  const positionId = trace.outcome.positionId

  if (guardian == null && executor == null && positionId == null) return lines

  lines.push(``, `*Guardian Snapshot*`)

  if (guardian != null) {
    lines.push(`Guardian: ${esc(formatRoleState(guardian.state))}`)
    lines.push(`  ${esc(guardian.summary)}`)
    if (guardian.actions.length > 0) {
      lines.push(`  Actions: ${esc(guardian.actions.join(', '))}`)
    }
  }

  if (executor != null) {
    lines.push(`Executor: ${esc(formatRoleState(executor.state))}`)
    lines.push(`  ${esc(executor.summary)}`)
  }

  if (positionId != null) {
    const pos = getPositionMonitor().getPosition(positionId)
    if (pos != null) {
      lines.push(`Live: ${esc(pos.coin)} ${esc(pos.side.toUpperCase())} \\| tracked`)
      lines.push(
        `  Size: ${esc(pos.currentSize.toFixed(4))} \\| Entry: ${esc(pos.entryPrice.toFixed(2))} \\| Lev: ${esc(pos.leverage.toFixed(0))}x`,
      )
      lines.push(`  SL: ${esc(pos.slPrice.toFixed(2))} \\| TP: ${esc(pos.tpPrice.toFixed(2))}`)
      if (pos.partialClosesFired.length > 0) {
        lines.push(`  Partials: ${esc(pos.partialClosesFired.join(', '))}`)
      }
    } else {
      lines.push(`Live: position is no longer tracked`)
    }
  }

  const latestLifecycle = [...trace.timeline].reverse().find(item =>
    item.actor === 'guardian' || item.actor === 'executor',
  )
  if (latestLifecycle != null) {
    lines.push(`Last lifecycle: ${esc(latestLifecycle.actor)} \\| ${esc(latestLifecycle.summary)}`)
  }

  return lines
}

interface TraceOperatorAudit {
  action: string
  target: string
  status: 'submitted' | 'failed'
  source: string | null
  ts: Date
}

async function findLatestOperatorAuditForTrace(trace: DecisionTrace): Promise<TraceOperatorAudit | null> {
  const entries = await getJournalEntries({
    eventType: 'operator',
    coin: trace.coin,
    limit: 12,
  })

  const filtered = entries.filter(entry => {
    if (entry.eventType !== 'operator') return false
    const action = typeof entry.details.action === 'string' ? entry.details.action : null
    const target = typeof entry.details.target === 'string' ? entry.details.target : null
    const status = entry.details.status
    if (action == null || target == null || (status !== 'submitted' && status !== 'failed')) return false

    const entryPositionId = typeof entry.details.positionId === 'string' ? entry.details.positionId : null

    if (trace.outcome.positionId != null && entryPositionId === trace.outcome.positionId) return true
    return false
  })

  const latest = filtered[0]
  if (latest == null) return null

  return {
    action: latest.details.action as string,
    target: latest.details.target as string,
    status: latest.details.status as 'submitted' | 'failed',
    source: typeof latest.details.operatorSource === 'string' ? latest.details.operatorSource : null,
    ts: latest.ts,
  }
}

function formatOperatorIntervention(audit: TraceOperatorAudit | null): string[] {
  const esc = escapeMarkdownV2
  if (audit == null) return []
  const source = audit.source != null ? audit.source.toUpperCase() : 'MANUAL'
  return [
    ``,
    `*Manual Intervention*`,
    `Status: ${esc(audit.status.toUpperCase())} \\| Source: ${esc(source)}`,
    `Action: ${esc(audit.action)} \\| Target: ${esc(audit.target)}`,
    `At: ${esc(audit.ts.toISOString().slice(11, 19))}`,
  ]
}

interface BriefingHealthFocus {
  coin: string | null
  positionId: string | null
  attention: string | null
}

function resolveBriefingHealthFocus(): BriefingHealthFocus {
  const snapshot = getBriefingRefreshHealth()
  if (snapshot.state === 'healthy' && snapshot.recoveredFrom != null) {
    return {
      coin: snapshot.recoveredCoin,
      positionId: snapshot.recoveredPositionId,
      attention: snapshot.recoveredAttention,
    }
  }
  return {
    coin: snapshot.lastCoin,
    positionId: snapshot.lastPositionId,
    attention: snapshot.lastAttention,
  }
}

function matchesBriefingHealthTarget(
  target: {
    coin?: string
    positionId?: string
  },
  focus: BriefingHealthFocus,
): boolean {
  if (target.positionId != null && focus.positionId != null && target.positionId === focus.positionId) {
    return true
  }
  if (target.coin != null && focus.coin != null) {
    return target.coin.toUpperCase() === focus.coin.toUpperCase()
  }
  return false
}

function prependBriefingFocusIntro(
  mode: 'trace' | 'operator',
  reply: string,
  target: {
    coin?: string
    positionId?: string
  } | null,
): string {
  if (target == null || (target.coin == null && target.positionId == null)) return reply

  const normalizedCoin = target.coin?.trim().toUpperCase() ?? null
  const normalizedPositionId = target.positionId?.trim() ?? null
  const focusLabel = normalizedCoin ?? normalizedPositionId
  if (focusLabel == null || focusLabel.length === 0) return reply

  const focus = resolveBriefingHealthFocus()
  const esc = escapeMarkdownV2
  const lines = [
    `🧭 *${mode === 'trace' ? 'Trace' : 'Operator'} Focus*`,
    `Target: ${esc(focusLabel)}.`,
  ]
  if (
    focus.attention != null &&
    focusLabel.length > 0 &&
    matchesBriefingHealthTarget(
      {
        ...(normalizedCoin != null ? { coin: normalizedCoin } : {}),
        ...(normalizedPositionId != null ? { positionId: normalizedPositionId } : {}),
      },
      focus,
    )
  ) {
    lines.push(`Attention: ${esc(focus.attention)}.`)
  }
  return `${lines.join('\n')}\n\n${reply}`
}

async function formatTraceReply(trace: DecisionTrace): Promise<string> {
  const esc = escapeMarkdownV2
  const judge = trace.roles.judge
  const verdict = judge?.verdict?.toUpperCase() ?? 'UNKNOWN'
  const latestOperatorAudit = await findLatestOperatorAuditForTrace(trace)
  const lines = [
    `*Decision Trace*`,
    ``,
    `Market: ${esc(trace.coin)} ${esc(trace.interval)}`,
    `Verdict: ${esc(verdict)} \\| Action: ${esc(trace.outcome.action.toUpperCase())}`,
    `Confidence: ${esc(String(Math.round(trace.outcome.confidence * 100)))}%`,
    `Summary: ${esc(trace.outcome.summary)}`,
  ]

  if (trace.outcome.setupId) {
    lines.push(`Setup: \`${esc(trace.outcome.setupId)}\``)
  }
  if (trace.outcome.positionId) {
    lines.push(`Position: \`${esc(trace.outcome.positionId)}\``)
  }

  lines.push(...formatGuardianSnapshot(trace))
  lines.push(...formatOperatorIntervention(latestOperatorAudit))

  const recent = formatTraceTimeline(trace)
  if (recent.length > 0) {
    lines.push(``, `*Recent:*`, ...recent)
  }

  return lines.join('\n')
}

function traceUsage(): string {
  return [
    `*Trace*`,
    ``,
    `\\/trace`,
    `\\/trace BTC`,
    `\\/trace setup <setupId>`,
    `\\/trace position <positionId>`,
  ].join('\n')
}

export function parseTracePositionArgs(args: string): string | null {
  const raw = args.trim()
  if (raw.length === 0) return null
  const parts = raw.split(/\s+/)
  const head = parts[0]?.toLowerCase()
  if (head !== 'position' && head !== 'pos') return null
  const id = raw.slice(parts[0]?.length ?? 0).trim()
  return id.length > 0 ? id : null
}

export function getTracePositionReplyMarkup(
  positionId: string,
  context?: {
    briefingMessageId?: number
    briefingKind?: 'morning' | 'evening' | 'live'
  },
): {
  inline_keyboard: { text: string; callback_data: string }[][]
} | null {
  const pos = getPositionMonitor().getPosition(positionId)
  if (pos == null) return null
  const briefingSuffix =
    context?.briefingMessageId != null && context.briefingKind != null
      ? `:b:${context.briefingMessageId}:${context.briefingKind}`
      : ''
  return {
    inline_keyboard: [
      [
        { text: '➖ Reduce 25%', callback_data: `c:trace_reduce25:${positionId}${briefingSuffix}` },
        { text: '➗ Reduce 50%', callback_data: `c:trace_reduce50:${positionId}${briefingSuffix}` },
      ],
      [
        { text: '🛑 Close', callback_data: `c:trace_close:${positionId}${briefingSuffix}` },
        { text: '🔄 Refresh', callback_data: `c:trace_refresh:${positionId}${briefingSuffix}` },
      ],
    ],
  }
}

async function traceHandler(args: string): Promise<string> {
  const esc = escapeMarkdownV2
  const raw = args.trim()

  let trace: DecisionTrace | null = null
  let focusTarget: { coin?: string; positionId?: string } | null = null
  if (raw.length === 0) {
    const traces = [...getDecisionTraces()].sort((a, b) => b.ts - a.ts)
    trace = traces[0] ?? null
  } else {
    const parts = raw.split(/\s+/)
    const head = parts[0]?.toLowerCase()
    if (head === 'setup') {
      const id = raw.slice(parts[0]?.length ?? 0).trim()
      if (id.length === 0) return traceUsage()
      trace = getDecisionTraceBySetupId(id)
    } else if (head === 'position' || head === 'pos') {
      const id = raw.slice(parts[0]?.length ?? 0).trim()
      if (id.length === 0) return traceUsage()
      focusTarget = { positionId: id }
      trace = getDecisionTraceByPositionId(id)
    } else if (parts.length === 1) {
      const coin = raw.toUpperCase()
      focusTarget = { coin }
      trace = getDecisionTracesForCoin(coin)[0] ?? null
    } else {
      return traceUsage()
    }
  }

  if (trace == null) {
    const message = `No decision trace found for ${esc(raw.length === 0 ? 'current context' : raw)}\\.`
    return focusTarget == null ? message : prependBriefingFocusIntro('trace', message, focusTarget)
  }

  const focusedTraceContext =
    focusTarget == null
      ? null
      : focusTarget.positionId != null && trace.outcome.positionId != null
        ? {
            coin: trace.coin,
            positionId: trace.outcome.positionId,
          }
        : focusTarget
  const reply = await formatTraceReply(trace)
  return focusedTraceContext == null ? reply : prependBriefingFocusIntro('trace', reply, focusedTraceContext)
}

// ─── /operator ────────────────────────────────────────────────────────────

function operatorUsage(): string {
  return [
    `*Operator Audit*`,
    ``,
    `\\/operator`,
    `\\/operator BTC`,
    `\\/operator position <positionId>`,
    `\\/operator close <positionId>`,
    `\\/operator reduce <positionId> 25`,
  ].join('\n')
}

function getConfirmTimeoutSec(): number {
  return TELEGRAM_BOT.closeallConfirmTimeoutSec
}

interface PendingPositionOperatorAction {
  chatId: number
  requestedAt: number
  kind: 'close' | 'reduce'
  positionId: string
  closePct: number | null
  target: string
  coin: string
  briefingSource?: {
    messageId: number
    kind: 'morning' | 'evening' | 'live'
  }
}

const pendingPositionActions = new Map<number, PendingPositionOperatorAction>()

function getPendingPositionAction(chatId: number): PendingPositionOperatorAction | null {
  return pendingPositionActions.get(chatId) ?? null
}

function clearPendingPositionAction(chatId?: number): void {
  if (chatId == null) {
    pendingPositionActions.clear()
    return
  }
  pendingPositionActions.delete(chatId)
}

function buildPendingPositionActionKeyboard(action: PendingPositionOperatorAction): {
  inline_keyboard: { text: string; callback_data: string }[][]
} {
  const confirmText =
    action.kind === 'close'
      ? `✅ Confirm Close ${action.coin}`
      : `✅ Confirm Reduce ${Math.round((action.closePct ?? 0) * 100)}%`
  return {
    inline_keyboard: [
      [
        { text: confirmText, callback_data: 'c:operator_confirm' },
        { text: '❌ Cancel', callback_data: 'c:operator_cancel' },
      ],
    ],
  }
}

function formatPendingPositionActionLabel(action: PendingPositionOperatorAction): string {
  if (action.kind === 'close') return `close ${action.target}`
  const pct = Math.round((action.closePct ?? 0) * 100)
  return `reduce ${pct}% ${action.target}`
}

export function getPendingOperatorBriefingSource(chatId: number): {
  messageId: number
  kind: 'morning' | 'evening' | 'live'
} | null {
  return getPendingPositionAction(chatId)?.briefingSource ?? null
}

export function getPendingOperatorActionReplyMarkup(chatId: number): {
  inline_keyboard: { text: string; callback_data: string }[][]
} | null {
  const pendingPositionAction = getPendingPositionAction(chatId)
  if (pendingPositionAction == null) return null
  const timeoutSec = getConfirmTimeoutSec()
  const elapsed = (Date.now() - pendingPositionAction.requestedAt) / 1000
  if (elapsed >= timeoutSec) {
    clearPendingPositionAction(chatId)
    return null
  }
  return buildPendingPositionActionKeyboard(pendingPositionAction)
}

export function cancelPendingOperatorAction(chatId: number): string {
  const esc = escapeMarkdownV2
  const pendingPositionAction = getPendingPositionAction(chatId)
  if (pendingPositionAction == null) {
    return `No pending operator action to cancel\\.`
  }
  const actionLabel = formatPendingPositionActionLabel(pendingPositionAction)
  clearPendingPositionAction(chatId)
  return `Cancelled pending operator action: ${esc(actionLabel)}\\.`
}

function parseReducePercent(raw: string): number | null {
  const normalized = raw.trim().replace(/%$/, '')
  if (normalized === '25') return 0.25
  if (normalized === '50') return 0.5
  return null
}

function schedulePendingPositionActionExpiry(chatId: number, timeoutSec: number): void {
  setTimeout(() => {
    const pendingPositionAction = getPendingPositionAction(chatId)
    if (pendingPositionAction && Date.now() - pendingPositionAction.requestedAt >= timeoutSec * 1000) {
      clearPendingPositionAction(chatId)
    }
  }, timeoutSec * 1000 + 500)
}

export function requestRemoteOperatorActionWithContext(
  raw: string,
  chatId: number,
  briefingSource?: {
    messageId: number
    kind: 'morning' | 'evening' | 'live'
  },
): string {
  const esc = escapeMarkdownV2
  const timeoutSec = getConfirmTimeoutSec()
  const parts = raw.trim().split(/\s+/)
  const kind = parts[0]?.toLowerCase()
  const positionId = parts[1]

  if ((kind !== 'close' && kind !== 'reduce') || !positionId) return operatorUsage()
  const pendingCloseAll = getPendingCloseAll(chatId)
  if (pendingCloseAll != null) {
    return `A /closeall is already pending\\. Send /confirm within ${esc(String(Math.ceil(timeoutSec - ((Date.now() - pendingCloseAll.requestedAt) / 1000))))}s or wait for it to expire\\.`
  }
  const pendingPositionAction = getPendingPositionAction(chatId)
  if (pendingPositionAction != null) {
    const elapsed = (Date.now() - pendingPositionAction.requestedAt) / 1000
    if (elapsed < timeoutSec) {
      return `A remote operator action is already pending: ${esc(formatPendingPositionActionLabel(pendingPositionAction))}\\. Send /confirm within ${esc(String(Math.ceil(timeoutSec - elapsed)))}s\\.`
    }
    clearPendingPositionAction(chatId)
  }

  const pm = getPositionMonitor()
  const pos = pm.getPosition(positionId)
  if (pos == null) {
    return `Tracked position not found: \`${esc(positionId)}\`\\.`
  }

  let closePct: number | null = null
  if (kind === 'reduce') {
    const rawPct = parts[2]
    if (!rawPct) return operatorUsage()
    closePct = parseReducePercent(rawPct)
    if (closePct == null) {
      return `Unsupported reduce size\\. Use 25 or 50\\.`
    }
  }

  const pendingAction: PendingPositionOperatorAction = {
    chatId,
    requestedAt: Date.now(),
    kind,
    positionId,
    closePct,
    target: `${pos.coin} ${pos.side.toUpperCase()}`,
    coin: pos.coin,
    ...(briefingSource != null ? { briefingSource } : {}),
  }
  pendingPositionActions.set(chatId, pendingAction)
  schedulePendingPositionActionExpiry(chatId, timeoutSec)

  const actionLabel = formatPendingPositionActionLabel(pendingAction)
  return [
    `*Remote Operator Action* — Confirmation required`,
    ``,
    `Action: ${esc(actionLabel)}`,
    `Position: \`${esc(positionId)}\``,
    ``,
    `Send /confirm within ${esc(String(timeoutSec))}s to proceed\\.`,
  ].join('\n')
}

function requestRemoteOperatorAction(raw: string, chatId: number): string {
  return requestRemoteOperatorActionWithContext(raw, chatId)
}

async function operatorHandler(args: string, chatId: number): Promise<string> {
  const esc = escapeMarkdownV2
  const raw = args.trim()
  const parts = raw.length > 0 ? raw.split(/\s+/) : []
  const head = parts[0]?.toLowerCase()

  let coin: string | undefined
  let positionId: string | undefined
  let focusTarget: { coin?: string; positionId?: string } | null = null

  if (head === 'close' || head === 'reduce') {
    return requestRemoteOperatorAction(raw, chatId)
  }

  if (parts.length === 0) {
    // latest
  } else if (parts.length === 1) {
    coin = raw.toUpperCase()
    focusTarget = { coin }
  } else if (parts.length >= 2) {
    const head = parts[0]?.toLowerCase()
    const tail = raw.slice(parts[0]?.length ?? 0).trim()
    if (head === 'position' || head === 'pos') {
      if (tail.length === 0) return operatorUsage()
      positionId = tail
      focusTarget = { positionId: tail }
    } else {
      return operatorUsage()
    }
  }

  try {
    const baseEntries = await getJournalEntries({
      eventType: 'operator',
      ...(coin != null ? { coin } : {}),
      limit: positionId != null ? 100 : 5,
    })
    const entries = baseEntries.filter(entry => {
      if (positionId != null) {
        return entry.details.positionId === positionId
      }
      return true
    }).slice(0, 5)

    if (entries.length === 0) {
      const noEntries = coin
        ? `No operator audit entries found for ${esc(coin)}\\.`
        : positionId
          ? `No operator audit entries found for position ${esc(positionId)}\\.`
          : `No operator audit entries found\\.`
      return focusTarget == null ? noEntries : prependBriefingFocusIntro('operator', noEntries, focusTarget)
    }

    const lines = [
      `*Operator Audit*`,
      coin
        ? `Filter: ${esc(coin)}`
        : positionId
          ? `Position: ${esc(positionId)}`
          : `Scope: latest manual interventions`,
      ``,
    ]

    for (const entry of entries) {
      const action = typeof entry.details.action === 'string' ? entry.details.action : entry.eventType
      const target = typeof entry.details.target === 'string' ? entry.details.target : (entry.coin ?? 'unknown')
      const status = typeof entry.details.status === 'string' ? entry.details.status.toUpperCase() : 'UNKNOWN'
      const reason = typeof entry.details.reason === 'string' ? entry.details.reason : null
      const position = typeof entry.details.positionId === 'string' ? entry.details.positionId : null
      const stamp = entry.ts.toISOString().slice(11, 19)

      lines.push(`${esc(stamp)} \\| *${esc(status)}* \\| ${esc(action)} ${esc(target)}`)
      if (position != null && positionId == null) {
        lines.push(`  pos: \`${esc(position)}\``)
      }
      if (reason != null && reason.length > 0) {
        lines.push(`  ${esc(reason)}`)
      }
    }

    const reply = lines.join('\n')
    return focusTarget == null ? reply : prependBriefingFocusIntro('operator', reply, focusTarget)
  } catch {
    return `Failed to load operator audit\\.`
  }
}

// ─── /closeall state machine ─────────────────────────────────────────────

interface CloseAllState {
  chatId: number
  requestedAt: number
}

/** Pending /closeall confirmation by chat. */
const pendingCloseAllByChat = new Map<number, CloseAllState>()

/** Expose for testing. */
export function getPendingCloseAll(chatId?: number): CloseAllState | null {
  if (chatId == null) return pendingCloseAllByChat.values().next().value ?? null
  return pendingCloseAllByChat.get(chatId) ?? null
}

/** Reset state (for testing). */
export function resetCloseAllState(chatId?: number): void {
  if (chatId == null) {
    pendingCloseAllByChat.clear()
    clearPendingPositionAction()
    return
  }
  pendingCloseAllByChat.delete(chatId)
  clearPendingPositionAction(chatId)
}

function closeallHandler(_args: string, chatId: number): string {
  const esc = escapeMarkdownV2
  const timeoutSec = getConfirmTimeoutSec()

  const pendingPositionAction = getPendingPositionAction(chatId)
  if (pendingPositionAction != null) {
    const elapsed = (Date.now() - pendingPositionAction.requestedAt) / 1000
    if (elapsed < timeoutSec) {
      return `A remote operator action is already pending\\. Send /confirm within ${esc(String(Math.ceil(timeoutSec - elapsed)))}s or wait for it to expire\\.`
    }
    clearPendingPositionAction(chatId)
  }

  const pendingCloseAll = getPendingCloseAll(chatId)
  if (pendingCloseAll) {
    const elapsed = (Date.now() - pendingCloseAll.requestedAt) / 1000
    if (elapsed < timeoutSec) {
      return `A /closeall is already pending\\. Send /confirm within ${esc(String(Math.ceil(timeoutSec - elapsed)))}s\\.`
    }
    // Expired — allow new request
    pendingCloseAllByChat.delete(chatId)
  }

  pendingCloseAllByChat.set(chatId, { chatId, requestedAt: Date.now() })

  // Auto-cancel after timeout
  setTimeout(() => {
    const pendingCloseAll = getPendingCloseAll(chatId)
    if (pendingCloseAll && Date.now() - pendingCloseAll.requestedAt >= timeoutSec * 1000) {
      pendingCloseAllByChat.delete(chatId)
    }
  }, timeoutSec * 1000 + 500) // small buffer

  return [
    `*CLOSE ALL* — Confirmation required`,
    ``,
    `This will:`,
    `1\\. Pause the agent`,
    `2\\. Cancel all pending orders`,
    `3\\. Close all open positions`,
    ``,
    `Send /confirm within ${esc(String(timeoutSec))}s to proceed\\.`,
  ].join('\n')
}

async function confirmHandler(_args: string, chatId: number): Promise<string> {
  const esc = escapeMarkdownV2
  const timeoutSec = getConfirmTimeoutSec()

  const pendingPositionAction = getPendingPositionAction(chatId)
  if (pendingPositionAction) {
    const elapsed = (Date.now() - pendingPositionAction.requestedAt) / 1000
    if (elapsed >= timeoutSec) {
      clearPendingPositionAction(chatId)
      return `Operator confirmation expired\\. Send /operator again\\.`
    }

    const actionState = pendingPositionAction
    clearPendingPositionAction(chatId)

    const pm = getPositionMonitor()
    const pos = pm.getPosition(actionState.positionId)
    if (pos == null) {
      await logOperatorAuditEntry(
        actionState.kind === 'close' ? 'close' : `reduce ${Math.round((actionState.closePct ?? 0) * 100)}%`,
        actionState.target,
        'failed',
        {
          coin: actionState.coin,
          source: 'telegram',
          details: {
            reason: 'manual via Telegram',
            positionId: actionState.positionId,
            ...(actionState.closePct != null ? { closePct: actionState.closePct } : {}),
            failure: 'position_not_found',
          },
        },
      )
      return `Tracked position no longer exists: \`${esc(actionState.positionId)}\`\\.`
    }

    const om = getOrderManager()
    try {
      if (actionState.kind === 'close') {
        const action = { type: 'close_position' as const, positionId: actionState.positionId, reason: 'manual via Telegram' }
        recordDecisionTraceAgentAction(action)
        await om.handleAction(action)
        await logOperatorAuditEntry('close', actionState.target, 'submitted', {
          coin: pos.coin,
          source: 'telegram',
          details: {
            reason: 'manual via Telegram',
            positionId: actionState.positionId,
          },
        })
      } else {
        const closePct = actionState.closePct ?? 0.25
        const action = { type: 'partial_close' as const, positionId: actionState.positionId, closePct }
        recordDecisionTraceAgentAction(action)
        await om.handleAction(action)
        await logOperatorAuditEntry(`reduce ${Math.round(closePct * 100)}%`, actionState.target, 'submitted', {
          coin: pos.coin,
          source: 'telegram',
          details: {
            reason: 'manual via Telegram',
            positionId: actionState.positionId,
            closePct,
          },
        })
      }

      return [
        `*Operator Action Executed*`,
        `Action: ${esc(formatPendingPositionActionLabel(actionState))}`,
        `Position: \`${esc(actionState.positionId)}\``,
      ].join('\n')
    } catch {
      await logOperatorAuditEntry(
        actionState.kind === 'close' ? 'close' : `reduce ${Math.round((actionState.closePct ?? 0) * 100)}%`,
        actionState.target,
        'failed',
        {
          coin: pos.coin,
          source: 'telegram',
          details: {
            reason: 'manual via Telegram',
            positionId: actionState.positionId,
            ...(actionState.closePct != null ? { closePct: actionState.closePct } : {}),
          },
        },
      )
      return `Operator action failed\\. Check logs\\.`
    }
  }

  const pendingCloseAll = getPendingCloseAll(chatId)
  if (!pendingCloseAll) {
    return `No pending /closeall to confirm\\.`
  }

  // Check timeout
  const elapsed = (Date.now() - pendingCloseAll.requestedAt) / 1000
  if (elapsed >= timeoutSec) {
    pendingCloseAllByChat.delete(chatId)
    return `Confirmation expired\\. Send /closeall again\\.`
  }

  // Execute
  pendingCloseAllByChat.delete(chatId)
  try {
    const result = await closeAllPositions('emergency close-all via Telegram')
    return [
      `*Close\\-all executed*`,
      `Cancelled orders: ${esc(String(result.cancelled))}`,
      `Closed positions: ${esc(String(result.closed))}`,
      `Agent is now paused\\.`,
    ].join('\n')
  } catch {
    return `Close\\-all failed\\. Check logs\\.`
  }
}

// ─── /report ──────────────────────────────────────────────────────────────

async function reportHandler(): Promise<string> {
  const esc = escapeMarkdownV2
  try {
    const m = await getLiveMetrics()
    const operatorEntries = await getJournalEntries({
      eventType: 'operator',
      limit: 5,
    })
    const decisionTraces = [...getDecisionTraces()]
      const liveTraces = [...decisionTraces]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 3)

    const fmt = (n: number) => esc(n.toFixed(2))
    const pct = (n: number) => esc((n * 100).toFixed(1))

    const lines: string[] = [
      `*Daily Report*`,
      ``,
      `*Ops Recap:*`,
      `  Bot: ${esc(formatCountLabel(m.openPositionCount, 'open position', 'open positions'))} \\| ${esc(formatCountLabel(decisionTraces.length, 'live case', 'live cases'))} \\| ${esc(formatBotActionSummary(decisionTraces))}`,
      `  Guardian: ${formatGuardianActivitySummary(decisionTraces)}`,
      `  Operator: ${operatorEntries.length > 0
        ? `${esc(formatCountLabel(operatorEntries.length, 'recent action', 'recent actions'))} \\| ${esc(formatCountLabel(operatorEntries.filter(entry => entry.details.status === 'submitted').length, 'submitted', 'submitted'))} \\| ${esc(formatCountLabel(operatorEntries.filter(entry => entry.details.status === 'failed').length, 'failed', 'failed'))}`
        : `none`}`,
      `  Briefing: ${formatBriefingHealthSummary()}`,
      ``,
      `*PnL:*`,
      `  Daily: ${fmt(m.pnl.daily)} USDC \\| Weekly: ${fmt(m.pnl.weekly)}`,
      `  Monthly: ${fmt(m.pnl.monthly)} \\| All\\-time: ${fmt(m.pnl.allTime)}`,
      ``,
      `*Win Rate:*`,
      `  Daily: ${pct(m.winRate.daily)}% \\(${esc(String(m.trades.daily))} trades\\)`,
      `  Weekly: ${pct(m.winRate.weekly)}% \\(${esc(String(m.trades.weekly))}\\)`,
      `  Monthly: ${pct(m.winRate.monthly)}% \\(${esc(String(m.trades.monthly))}\\)`,
      ``,
      `*Drawdown:* ${fmt(m.currentDrawdown)} \\(max ${fmt(m.maxDrawdown)}\\)`,
      `*Open positions:* ${esc(String(m.openPositionCount))}`,
    ]

    // Top patterns by trade count (max 5)
    if (m.patternMetrics.length > 0) {
      const topPatterns = [...m.patternMetrics]
        .sort((a, b) => b.trades - a.trades)
        .slice(0, 5)
      lines.push(``, `*Top Patterns:*`)
      for (const p of topPatterns) {
        lines.push(
          `  ${esc(p.patternType)} ${esc(p.signalGrade)}: ${esc(String(p.trades))}t WR ${pct(p.winRate)}% PnL ${fmt(p.totalPnl)}`,
        )
      }
    }

    // Top coins by PnL (max 5)
    if (m.coinMetrics.length > 0) {
      const topCoins = [...m.coinMetrics]
        .sort((a, b) => b.totalPnl - a.totalPnl)
        .slice(0, 5)
      lines.push(``, `*Top Coins:*`)
      for (const c of topCoins) {
        lines.push(
          `  ${esc(c.coin)}: ${esc(String(c.trades))}t WR ${pct(c.winRate)}% PnL ${fmt(c.totalPnl)}`,
        )
      }
    }

    if (operatorEntries.length > 0) {
      const submitted = operatorEntries.filter(entry => entry.details.status === 'submitted').length
      const failed = operatorEntries.filter(entry => entry.details.status === 'failed').length
      lines.push(``, `*Operator Recent:*`)
      lines.push(`  ${esc(String(operatorEntries.length))} actions \\| ${esc(String(submitted))} submitted \\| ${esc(String(failed))} failed`)
      for (const entry of operatorEntries.slice(0, 3)) {
        const action = typeof entry.details.action === 'string' ? entry.details.action : 'manual'
        const target = typeof entry.details.target === 'string' ? entry.details.target : (entry.coin ?? 'unknown')
        const source = typeof entry.details.operatorSource === 'string' ? entry.details.operatorSource.toUpperCase() : 'MANUAL'
        lines.push(
          `  ${esc(action)} ${esc(target)} \\| ${esc(source)} \\| ${esc(entry.ts.toISOString().slice(11, 19))}`,
        )
      }
    }

    const briefingStats = getBriefingRefreshStats()
    lines.push(``, `*Briefing Refresh:*`)
    lines.push(
      `  ${esc(String(briefingStats.requested))} requested \\| ${esc(String(briefingStats.edited))} edited \\| ${esc(String(briefingStats.skippedIdentical))} skipped \\| ${esc(String(briefingStats.coalesced))} coalesced`,
    )
    if (briefingStats.lastOutcome != null) {
      const lastAt =
        briefingStats.lastAt != null
          ? new Date(briefingStats.lastAt).toISOString().slice(11, 19)
          : 'unknown'
      lines.push(
        `  last ${esc(briefingStats.lastOutcome.replace(/_/g, ' '))} \\| ${esc(briefingStats.lastKind ?? 'unknown')} \\| ${esc(lastAt)}`,
      )
    }
    const briefingDrilldown = formatBriefingDrilldownLine()
    if (briefingDrilldown != null) {
      lines.push(`  ${briefingDrilldown}`)
    }
    const briefingIncident = formatBriefingIncidentLine(2)
    if (briefingIncident != null) {
      lines.push(`  incident ${briefingIncident}`)
    }
    const briefingHistory = formatBriefingHistoryLine(3)
    if (briefingHistory != null) {
      lines.push(`  history ${briefingHistory}`)
    }

    if (liveTraces.length > 0) {
      lines.push(``, `*Live Oversight:*`)
      for (const trace of liveTraces) {
        const guardian = trace.roles.guardian != null ? formatRoleState(trace.roles.guardian.state) : 'WAITING'
        const executor = trace.roles.executor != null ? formatRoleState(trace.roles.executor.state) : 'IDLE'
        lines.push(
          `  ${esc(trace.coin)} ${esc(trace.interval)} \\| ${esc(trace.outcome.action.toUpperCase())} \\| G ${esc(guardian)} \\| E ${esc(executor)}`,
        )
      }
    }

    return lines.join('\n')
  } catch {
    return `Failed to load report\\.`
  }
}

// ─── /menu (HTML body + inline keyboard in bot.ts) ───────────────────────

function menuHandler(): string {
  const h = escapeHtml
  const eff = getEffectivePaperTrade() ? 'PAPER' : 'LIVE'
  return [
    `<b>Minh (明) — Menu</b>`,
    `Chọn nút bên dưới hoặc gõ <code>/help</code>.`,
    ``,
    `Paper: <b>${h(eff)}</b> · env: <code>${h(PAPER_TRADE ? 'PAPER' : 'LIVE')}</code>`,
  ].join('\n')
}

// ─── /paper ────────────────────────────────────────────────────────────────

function paperHandler(args: string): string {
  const esc = escapeMarkdownV2
  const a = args.trim().toLowerCase()
  if (a === 'on' || a === 'true' || a === '1') {
    setPaperTradeRuntimeOverride(true)
    return `Paper trade: *ON* \\(runtime\\)\\.`
  }
  if (a === 'off' || a === 'false' || a === '0') {
    setPaperTradeRuntimeOverride(false)
    return [
      `Paper trade: *OFF* \\(live execution\\)\\.`,
      `⚠️ Đảm bảo bạn hiểu rủi ro trước khi giao dịch thực\\.`,
      `Dùng \\/paper reset để khôi phục cài đặt theo env\\.`,
    ].join('\n')
  }
  if (a === 'reset' || a === 'env') {
    setPaperTradeRuntimeOverride(null)
    return `Đã hủy override\\. Env: *${esc(PAPER_TRADE ? 'PAPER' : 'LIVE')}*\\.`
  }
  const ov = getPaperTradeRuntimeOverride()
  return [
    `*Paper trade*`,
    `Hiện tại: *${esc(getEffectivePaperTrade() ? 'PAPER' : 'LIVE')}*`,
    `Env PAPER_TRADE: ${esc(PAPER_TRADE ? 'true' : 'false')}`,
    `Override: ${ov === null ? 'none' : esc(ov ? 'ON' : 'OFF')}`,
    ``,
    `\\/paper on \\| off \\| reset`,
  ].join('\n')
}

/** Inline keyboard for /menu — callback_data prefix \`c:\`. */
export function getMainMenuKeyboard(): {
  inline_keyboard: { text: string; callback_data: string }[][]
} {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'c:status' },
        { text: '📈 Positions', callback_data: 'c:positions' },
      ],
      [
        { text: '💰 PnL', callback_data: 'c:pnl' },
        { text: '📑 Report', callback_data: 'c:report' },
      ],
      [
        { text: '🧾 Operator', callback_data: 'c:operator' },
        { text: '🧠 Trace', callback_data: 'c:trace' },
      ],
      [
        { text: '🟢 Paper ON', callback_data: 'c:paper_on' },
        { text: '🔴 Paper OFF', callback_data: 'c:paper_off' },
      ],
      [{ text: '❓ Help', callback_data: 'c:help' }],
    ],
  }
}

/** Inline keyboard for scheduled briefing messages. */
interface BriefingReplyContext {
  positionId?: string | null
  coin?: string | null
  briefingKind?: 'morning' | 'evening' | 'live'
  prioritizeHealthTarget?: boolean
  preferredHealthAction?: 'trace' | 'operator' | null
  healthButtonLabels?: {
    trace: string
    operator: string
  } | null
  healthTarget?: {
    positionId?: string | null
    coin?: string | null
  } | null
  buckets?: Array<{
    label: string
    positionId?: string | null
    coin?: string | null
  }>
}

function getBriefingTraceCallback(target: { positionId?: string | null; coin?: string | null }): string {
  const normalizedCoin = target.coin?.trim().toUpperCase() ?? null
  if (target.positionId != null && target.positionId.length > 0) {
    return `c:briefing_trace_position:${target.positionId}`
  }
  if (normalizedCoin != null && normalizedCoin.length > 0) {
    return `c:briefing_trace_coin:${normalizedCoin}`
  }
  return 'c:trace'
}

export function getBriefingReplyMarkup(context: BriefingReplyContext = {}): {
  inline_keyboard: { text: string; callback_data: string }[][]
} {
  const normalizedCoin = context.coin?.trim().toUpperCase() ?? null
  const healthCoin = context.healthTarget?.coin?.trim().toUpperCase() ?? null
  const traceCallback = getBriefingTraceCallback(context)
  const operatorCallback =
    context.positionId != null && context.positionId.length > 0
      ? `c:briefing_operator_position:${context.positionId}`
      : normalizedCoin != null && normalizedCoin.length > 0
        ? `c:briefing_operator_coin:${normalizedCoin}`
        : 'c:operator'
  const refreshCallback = `c:briefing_refresh:${context.briefingKind ?? 'live'}`
  const healthButtons = (
    (context.healthTarget?.positionId != null && context.healthTarget.positionId.length > 0) ||
    (healthCoin != null && healthCoin.length > 0)
  )
    ? (() => {
        const healthTraceCallback = getBriefingTraceCallback(context.healthTarget ?? {})
        const healthOperatorCallback =
          context.healthTarget?.positionId != null && context.healthTarget.positionId.length > 0
            ? `c:briefing_operator_position:${context.healthTarget.positionId}`
            : healthCoin != null && healthCoin.length > 0
              ? `c:briefing_operator_coin:${healthCoin}`
              : 'c:operator'
        const preferredHealthAction = context.preferredHealthAction ?? 'trace'
        const healthButtonLabels = {
          trace: context.healthButtonLabels?.trace ?? '⚠️ Health Trace',
          operator: context.healthButtonLabels?.operator ?? '⚠️ Health Operator',
        }
        const orderedButtons = preferredHealthAction === 'operator'
          ? [
              { text: healthButtonLabels.operator, callback_data: healthOperatorCallback },
              { text: healthButtonLabels.trace, callback_data: healthTraceCallback },
            ]
          : [
              { text: healthButtonLabels.trace, callback_data: healthTraceCallback },
              { text: healthButtonLabels.operator, callback_data: healthOperatorCallback },
            ]
        return [[
          ...orderedButtons,
        ]]
      })()
    : []
  const replyMarkup = {
    inline_keyboard: [
      ...(context.prioritizeHealthTarget ? healthButtons : []),
      [
        { text: '🧠 Trace', callback_data: traceCallback },
        { text: '📈 Positions', callback_data: 'c:positions' },
      ],
      [
        { text: '🧾 Operator', callback_data: operatorCallback },
        { text: '📑 Report', callback_data: 'c:report' },
      ],
      [{ text: '🔄 Refresh briefing', callback_data: refreshCallback }],
    ],
  }

  const bucketButtons = (context.buckets ?? [])
    .filter(bucket => {
      if (bucket.positionId != null && bucket.positionId.length > 0) return true
      return bucket.coin != null && bucket.coin.trim().length > 0
    })
    .map(bucket => ({
      text: `↘️ ${bucket.label}`,
      callback_data: getBriefingTraceCallback(bucket),
    }))

  for (let i = 0; i < bucketButtons.length; i += 2) {
    replyMarkup.inline_keyboard.push(bucketButtons.slice(i, i + 2))
  }

  if (!context.prioritizeHealthTarget && healthButtons.length > 0) {
    replyMarkup.inline_keyboard.push(...healthButtons)
  }

  return replyMarkup
}

/** Run a registered command by name (for callback_query). */
export async function executeCommandByName(name: string, args: string, chatId: number): Promise<string> {
  const cmd = findCommand(name)
  if (!cmd) return `Unknown command: /${escapeMarkdownV2(name)}`
  return cmd.handler(args, chatId)
}

// ─── Register Built-in Commands ────────────────────────────────────────────

/** Register all built-in commands. Safe to call multiple times (idempotent). */
export function registerBuiltinCommands(): void {
  if (commands.length > 0) return
  registerCommand({ name: 'help', description: 'Show this help message', handler: helpHandler })
  registerCommand({ name: 'menu', description: 'Menu + inline buttons', handler: menuHandler })
  registerCommand({ name: 'status', description: 'Agent state, health, uptime', handler: statusHandler })
  registerCommand({ name: 'trace', description: 'Latest decision trace or lookup by setup/position', handler: traceHandler })
  registerCommand({ name: 'operator', description: 'Recent manual operator interventions', handler: operatorHandler })
  registerCommand({ name: 'positions', description: 'Open positions list', handler: positionsHandler })
  registerCommand({ name: 'pnl', description: 'PnL summary (daily/weekly/monthly)', handler: pnlHandler })
  registerCommand({ name: 'pause', description: 'Pause agent or coin (/pause BTC 4h)', handler: pauseHandler })
  registerCommand({ name: 'resume', description: 'Resume agent', handler: resumeHandler })
  registerCommand({ name: 'risk', description: 'Risk dashboard (PnL, CB, losses)', handler: riskHandler })
  registerCommand({ name: 'closeall', description: 'Emergency close all (requires /confirm)', handler: closeallHandler })
  registerCommand({ name: 'confirm', description: 'Confirm pending close-all or operator action', handler: confirmHandler })
  registerCommand({ name: 'report', description: 'Daily report (PnL, patterns, coins)', handler: reportHandler })
  registerCommand({ name: 'paper', description: 'Paper trade on/off/reset', handler: paperHandler })
}
