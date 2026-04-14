/**
 * Telegram Alerts — fire-and-forget notifications via Telegram Bot API.
 *
 * S14: Sends alerts for key agent events (setup, fill, close, circuit breaker).
 * Trade alerts use HTML parse mode (richer + simpler escaping than MarkdownV2).
 *
 * Design:
 *   - Fire-and-forget: errors are caught + logged, never bubble up.
 *   - Injected fetch for testability (defaults to global fetch).
 *   - Logs WARN on startup if env vars missing (alerts disabled).
 *
 * Integration:
 *   agent.onAction(action => {
 *     const msg = formatAlert(action)
 *     if (msg) void sendTelegramAlert(msg.text, globalThis.fetch, { parseMode: msg.parseMode })
 *   })
 */

import { TELEGRAM, getEffectivePaperTrade } from '../../config.js'
import { log } from '../../lib/logger.js'
import type { AgentAction } from '../../agent/types.js'
import type { DecisionTrace } from '../../types.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import { getTotalPaperBalance } from '../../agent/paper-tracker.js'
import { getHLExchangeService as getExchangeService } from '../../execution/hl-exchange-service.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch

interface TelegramConfig {
  botToken: string
  chatId: string
}

/** Parsed outgoing alert with Telegram parse mode. */
export type FormattedTelegramAlert = {
  text: string
  parseMode: 'MarkdownV2' | 'HTML'
}

export interface SendTelegramOptions {
  parseMode?: 'MarkdownV2' | 'HTML'
  /** Inline keyboard / reply markup (Telegram Bot API shape). */
  replyMarkup?: Record<string, unknown>
}

// ─── MarkdownV2 Escaping ────────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2 format.
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

// ─── HTML (Telegram Bot API subset) ─────────────────────────────────────────

/** Escape dynamic text inside Telegram HTML messages. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatAccountBalanceUsdc(): string {
  try {
    if (getEffectivePaperTrade()) {
      return getTotalPaperBalance().toFixed(2)
    }
    const v = getExchangeService().getCachedAccountValue()
    return v != null && Number.isFinite(v) ? v.toFixed(2) : '—'
  } catch {
    return '—'
  }
}

// ─── Config Resolution ─────────────────────────────────────────────────────

/** Resolve Telegram config from environment. Returns null if not configured. */
function resolveConfig(): TelegramConfig | null {
  const botToken = process.env[TELEGRAM.tokenEnv]
  const chatId = process.env[TELEGRAM.chatIdEnv]
  if (!botToken || !chatId) return null
  return { botToken, chatId }
}

/** Check if Telegram alerts are configured. Log WARN if not. Call once at startup. */
export function checkTelegramConfig(): boolean {
  const config = resolveConfig()
  if (!config) {
    log.warn('telegram', `Alerts disabled — set ${TELEGRAM.tokenEnv} and ${TELEGRAM.chatIdEnv} env vars`)
    return false
  }
  log.info('telegram', 'Alerts enabled')
  return true
}

// ─── Send ───────────────────────────────────────────────────────────────────

/**
 * Send a message to the configured Telegram chat.
 * Fire-and-forget: errors are logged, never thrown.
 *
 * @param message - Body text (escaped for the chosen parse mode)
 * @param fetchFn - Injectable fetch for testing (defaults to global fetch)
 */
export async function sendTelegramAlert(
  message: string,
  fetchFn: FetchFn = globalThis.fetch,
  options?: SendTelegramOptions,
): Promise<boolean> {
  const config = resolveConfig()
  if (!config) return false

  const parseMode = options?.parseMode ?? 'MarkdownV2'
  const url = `${TELEGRAM.apiBase}/bot${config.botToken}/sendMessage`

  const body: Record<string, unknown> = {
    chat_id: config.chatId,
    text: message,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  }
  if (options?.replyMarkup) {
    body.reply_markup = options.replyMarkup
  }

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM.timeoutMs),
    })

    if (!res.ok) {
      const resBody = await res.text().catch(() => '<unreadable>')

      // Entity parse error → retry as plain text (strip formatting)
      if (res.status === 400 && resBody.includes("can't parse entities")) {
        log.warn('telegram', `${parseMode} parse error — retrying as plain text`)
        let plain = message
        if (parseMode === 'MarkdownV2') {
          plain = message.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
        } else {
          plain = message.replace(/<[^>]+>/g, '')
        }
        const retryRes = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text: plain,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TELEGRAM.timeoutMs),
        })
        if (retryRes.ok) return true
        log.error('telegram', `Plain text retry also failed: HTTP ${retryRes.status}`)
        return false
      }

      log.error('telegram', `Send failed: HTTP ${res.status} — ${resBody}`)
      return false
    }

    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('telegram', `Send failed: ${msg}`)
    return false
  }
}

// ─── Format ─────────────────────────────────────────────────────────────────

/** Pretty-print prices for signal alerts (matches backtest table heuristic). */
function formatSignalPriceHtml(value: unknown, esc: (s: string) => string): string {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) {
    return esc('—')
  }
  const n = value
  const s = n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6)
  return esc(s)
}

function formatSignalRiskReward(details: Record<string, unknown>): string | null {
  const entry = details.entryPrice
  const sl = details.slPrice
  const tp = details.tpPrice
  if (
    typeof entry !== 'number' ||
    typeof sl !== 'number' ||
    typeof tp !== 'number' ||
    !Number.isFinite(entry) ||
    !Number.isFinite(sl) ||
    !Number.isFinite(tp)
  ) {
    return null
  }
  const risk = Math.abs(entry - sl)
  if (risk === 0) return null
  const reward = Math.abs(tp - entry)
  return (reward / risk).toFixed(2)
}

function getLatestTimelineEntry(trace: DecisionTrace): DecisionTrace['timeline'][number] | null {
  return trace.timeline.length > 0 ? trace.timeline[trace.timeline.length - 1]! : null
}

function decisionTraceTitle(trace: DecisionTrace): string {
  if (trace.outcome.action === 'trail_sl' || trace.outcome.action === 'partial_close') {
    return 'GUARDIAN UPDATE'
  }
  return 'DELIBERATION'
}

function formatTimelineActor(actor: DecisionTrace['timeline'][number]['actor']): string {
  switch (actor) {
    case 'scanner':
      return 'Scanner'
    case 'judge':
      return 'Judge'
    case 'executor':
      return 'Executor'
    case 'guardian':
      return 'Guardian'
  }
}

export function getDecisionTraceAlertFingerprint(trace: DecisionTrace): string | null {
  const judge = trace.roles.judge
  if (judge == null) return null

  if (trace.outcome.action === 'watch') {
    if (trace.outcome.setupId == null || judge.verdict !== 'approve') return null
    return `deliberation:${trace.outcome.setupId}`
  }

  if (trace.outcome.action === 'trail_sl' || trace.outcome.action === 'partial_close') {
    const latest = getLatestTimelineEntry(trace)
    const subject = trace.outcome.positionId ?? trace.traceId
    const detail = latest?.summary ?? trace.outcome.summary
    return `guardian:${trace.outcome.action}:${subject}:${detail}`
  }

  return null
}

export function shouldSendDecisionTraceAlert(trace: DecisionTrace): boolean {
  return getDecisionTraceAlertFingerprint(trace) !== null
}

export function formatDecisionTraceAlert(trace: DecisionTrace): FormattedTelegramAlert | null {
  const h = escapeHtml
  const judge = trace.roles.judge
  if (judge == null) return null

  const bull = trace.roles.bull
  const bear = trace.roles.bear
  const risk = trace.roles.risk
  const guardian = trace.roles.guardian
  const timeline = trace.timeline.slice(-3)
  const lines = [
    `🧠 <b>${decisionTraceTitle(trace)}</b>`,
    ``,
    `Market: <code>${h(trace.coin)} ${h(trace.interval)}</code>`,
    `Strategy: <code>${h(trace.strategyId)}</code>`,
    `Verdict: <b>${h(judge.verdict.toUpperCase())}</b> | Action: <b>${h(trace.outcome.action.toUpperCase())}</b>`,
    `Confidence: <b>${h(String(Math.round(trace.outcome.confidence * 100)))}%</b>`,
    `Regime: <code>${h(trace.regime.state)} x${h(trace.regime.modifier.toFixed(2))}</code>`,
    `Summary: ${h(trace.outcome.summary)}`,
  ]

  if (bull != null) {
    lines.push(`Bull: <b>${h(String(Math.round(bull.confidence * 100)))}%</b> — ${h(bull.summary)}`)
  }
  if (bear != null) {
    lines.push(`Bear: <b>${h(String(Math.round(bear.confidence * 100)))}%</b> — ${h(bear.summary)}`)
  }
  if (risk != null) {
    lines.push(`Risk: <b>${h(String(Math.round(risk.confidence * 100)))}%</b> — ${h(risk.summary)}`)
  }
  if (guardian != null && (trace.outcome.action === 'trail_sl' || trace.outcome.action === 'partial_close')) {
    lines.push(`Guardian: ${h(guardian.summary)}`)
  }
  if (trace.outcome.setupId != null) {
    lines.push(`Setup: <code>${h(trace.outcome.setupId)}</code>`)
  }
  if (trace.outcome.positionId != null) {
    lines.push(`Position: <code>${h(trace.outcome.positionId)}</code>`)
  }
  if (timeline.length > 0) {
    lines.push('', '<b>Recent</b>')
    for (const item of timeline) {
      lines.push(`${h(formatTimelineActor(item.actor))}: ${h(item.summary)}`)
    }
  }

  return { text: lines.join('\n'), parseMode: 'HTML' }
}

/**
 * Format an AgentAction into a Telegram message (HTML for trade flow).
 * Returns null if the action should not generate an alert.
 */
export function formatAlert(action: AgentAction): FormattedTelegramAlert | null {
  if (action.type !== 'log_journal') return null

  const { eventType, coin, details } = action
  const h = escapeHtml

  switch (eventType) {
    case 'signal': {
      const grade = details.grade as string | undefined
      if (grade !== 'A' && grade !== 'A+') return null
      const setupId = h(String(details.setupId ?? ''))
      const confidence = details.confidence != null
        ? (Number(details.confidence) * 100).toFixed(0)
        : '?'
      const tf = details.interval != null ? h(String(details.interval)) : '—'
      const sideRaw = details.side != null ? String(details.side) : ''
      const sideLine = sideRaw !== '' ? `<b>${h(sideRaw.toUpperCase())}</b>` : '—'
      const patternLine =
        details.pattern != null
          ? `Pattern: <code>${h(String(details.pattern))}</code>`
          : null
      const entry = formatSignalPriceHtml(details.entryPrice, h)
      const sl = formatSignalPriceHtml(details.slPrice, h)
      const tp = formatSignalPriceHtml(details.tpPrice, h)
      const rr = formatSignalRiskReward(details)
      const rrLine = rr != null ? `R:R (TP1): <b>${h(rr)}</b>` : null
      const replacedLine =
        details.replaced != null ? `Replaces: <code>${h(String(details.replaced))}</code>` : null
      const text = [
        `🔍 <b>SETUP DETECTED</b>`,
        ``,
        `Coin: <code>${h(coin)}</code>`,
        `TF: <code>${tf}</code> | Side: ${sideLine}`,
        ...(patternLine ? [patternLine] : []),
        `Grade: <b>${h(grade ?? '')}</b>`,
        `Confidence: ${h(confidence)}%`,
        `Entry: <code>${entry}</code> | SL: <code>${sl}</code> | TP: <code>${tp}</code>`,
        ...(rrLine ? [rrLine] : []),
        `Setup: <code>${setupId}</code>`,
        ...(replacedLine ? [``, replacedLine] : []),
      ].join('\n')
      return { text, parseMode: 'HTML' }
    }

    case 'enter': {
      const side = details.side as string | undefined
      const fillPrice = details.fillPrice != null ? Number(details.fillPrice).toFixed(4) : '?'
      const positionId = details.positionId as string | undefined
      const arrow = side === 'short' ? '🔴' : '🟢'

      let sl = '—'
      let tp = '—'
      let value = '—'
      let size = '—'
      if (positionId) {
        try {
          const pos = getPositionMonitor().getPosition(positionId)
          if (pos) {
            sl = h(pos.slPrice.toFixed(2))
            tp = h(pos.tpPrice.toFixed(2))
            value = h((pos.currentSize * pos.entryPrice).toFixed(2))
            size = h(pos.currentSize.toFixed(4))
          }
        } catch {
          /* PM may be unavailable in tests */
        }
      }

      const text = [
        `${arrow} <b>POSITION OPEN</b>`,
        ``,
        `Coin: <code>${h(coin)}</code>`,
        `Side: <b>${h(String(side ?? 'unknown'))}</b>`,
        `Entry: <code>${h(fillPrice)}</code> USDC`,
        `Size: <code>${size}</code>`,
        `Value: <code>${value}</code> USDC`,
        `SL: <code>${sl}</code> | TP: <code>${tp}</code>`,
      ].join('\n')
      return { text, parseMode: 'HTML' }
    }

    case 'exit': {
      const pnl = details.pnl != null ? Number(details.pnl) : 0
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
      const emoji = pnl >= 0 ? '✅' : '❌'
      const reason = details.reason as string | undefined
      const balance = formatAccountBalanceUsdc()
      const text = [
        `${emoji} <b>POSITION CLOSED</b>`,
        ``,
        `Coin: <code>${h(coin)}</code>`,
        `PnL: <b>${h(pnlStr)} USDC</b>`,
        `Balance: <code>${h(balance)}</code> USDC`,
        `Reason: ${h(String(reason ?? 'unknown'))}`,
      ].join('\n')
      return { text, parseMode: 'HTML' }
    }

    case 'circuit_break': {
      const reason = details.reason as string | undefined
      const dailyPnl = details.dailyPnl != null ? Number(details.dailyPnl).toFixed(2) : '?'
      const text = [
        `🚨 <b>CIRCUIT BREAKER TRIPPED</b>`,
        ``,
        `Reason: ${h(String(reason ?? 'unknown'))}`,
        `Daily PnL: <code>${h(dailyPnl)} USDC</code>`,
      ].join('\n')
      return { text, parseMode: 'HTML' }
    }

    case 'invalidate': {
      if (!details.positionId) return null
      const reason = details.reason as string | undefined
      const text = [
        `⚠️ <b>PATTERN INVALIDATED</b>`,
        ``,
        `Coin: <code>${h(coin)}</code>`,
        `Reason: ${h(String(reason ?? 'unknown'))}`,
        `Position: <code>${h(String(details.positionId))}</code>`,
        `Action: closing position`,
      ].join('\n')
      return { text, parseMode: 'HTML' }
    }

    default:
      return null
  }
}

// ─── Daily Summary ──────────────────────────────────────────────────────────

/** Format a daily PnL summary for Telegram (MarkdownV2 — legacy / commands). */
export function formatDailySummary(summary: {
  date: string
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  largestWin: number
  largestLoss: number
}): string {
  const esc = escapeMarkdownV2
  const pnlStr = summary.totalPnl >= 0
    ? `+${summary.totalPnl.toFixed(2)}`
    : summary.totalPnl.toFixed(2)
  const emoji = summary.totalPnl >= 0 ? '📈' : '📉'
  const winRatePct = (summary.winRate * 100).toFixed(0)

  return [
    `${emoji} *DAILY SUMMARY* — ${esc(summary.date)}`,
    ``,
    `Trades: ${esc(String(summary.totalTrades))}`,
    `Win Rate: ${esc(winRatePct)}% \\(${esc(String(summary.wins))}W/${esc(String(summary.losses))}L\\)`,
    `PnL: *${esc(pnlStr)} USDC*`,
    `Largest Win: \`${esc(summary.largestWin.toFixed(2))}\``,
    `Largest Loss: \`${esc(summary.largestLoss.toFixed(2))}\``,
  ].join('\n')
}

/** HTML daily summary for scheduled morning/evening reports. */
export function formatDailySummaryHtml(
  title: string,
  summary: {
    date: string
    totalTrades: number
    wins: number
    losses: number
    winRate: number
    totalPnl: number
    largestWin: number
    largestLoss: number
    entryCount?: number
  },
): string {
  const h = escapeHtml
  const pnlStr = summary.totalPnl >= 0
    ? `+${summary.totalPnl.toFixed(2)}`
    : summary.totalPnl.toFixed(2)
  const emoji = summary.totalPnl >= 0 ? '📈' : '📉'
  const winRatePct = (summary.winRate * 100).toFixed(0)
  const lines = [
    `${emoji} <b>${h(title)}</b> — <code>${h(summary.date)}</code>`,
    ``,
    `Trades: <b>${h(String(summary.totalTrades))}</b>`,
    `Win rate: <b>${h(winRatePct)}%</b> (${h(String(summary.wins))}W / ${h(String(summary.losses))}L)`,
    `PnL: <b>${h(pnlStr)} USDC</b>`,
    `Largest win: <code>${h(summary.largestWin.toFixed(2))}</code>`,
    `Largest loss: <code>${h(summary.largestLoss.toFixed(2))}</code>`,
  ]
  if (summary.entryCount != null) {
    lines.push(`Journal rows: <code>${h(String(summary.entryCount))}</code>`)
  }
  return lines.join('\n')
}

export interface ScheduledBriefingOperatorItem {
  action: string
  target: string
  source: string
  at: string
}

export interface ScheduledBriefingLiveItem {
  coin: string
  interval: string
  action: string
  guardian: string
  executor: string
}

export interface ScheduledBriefingAttention {
  level: string
  summary: string
}

export interface ScheduledBriefingBucketItem {
  coin: string
  interval: string
  action: string
}

export interface ScheduledBriefingLiveBucket {
  label: string
  count: number
  items: ScheduledBriefingBucketItem[]
}

export interface ScheduledBriefingIncident {
  peakState: string
  status: string
  target?: string | null
  cause?: string | null
  recommendedAction?: string | null
}

function formatScheduledBriefingIncidentAction(
  incident: ScheduledBriefingIncident,
  h: (text: string) => string,
): string | null {
  if (incident.status !== 'ACTIVE') return null
  const severity = incident.peakState === 'CRITICAL' ? 'Immediate action' : 'Needs review'
  const cause =
    incident.cause != null && incident.cause.length > 0
      ? `<b>${h(incident.cause)}</b>`
      : '<b>Briefing health incident is still active.</b>'
  const action =
    incident.recommendedAction != null && incident.recommendedAction.length > 0
      ? h(incident.recommendedAction)
      : incident.target != null && incident.target.length > 0
        ? `Investigate <b>${h(incident.target)}</b> from the health controls below.`
        : 'Open the health controls below before acting on the recap.'

  return `${h(severity)}: ${cause} ${action}`
}

/** HTML scheduled recap for morning/evening bot briefings. */
export function formatScheduledBriefingHtml(
  title: string,
  summary: {
    date: string
    totalTrades: number
    wins: number
    losses: number
    winRate: number
    totalPnl: number
    largestWin: number
    largestLoss: number
    entryCount?: number
  },
  context: {
    openPositions: number
    attention?: ScheduledBriefingAttention | null
    incident?: ScheduledBriefingIncident | null
    liveBuckets?: ScheduledBriefingLiveBucket[]
    operatorRecent?: {
      totalActions: number
      submitted: number
      failed: number
      items: ScheduledBriefingOperatorItem[]
    }
    liveOversight?: ScheduledBriefingLiveItem[]
  },
): string {
  const h = escapeHtml
  const lines = [
    formatDailySummaryHtml(title, summary),
    ``,
    `Open positions: <b>${h(String(context.openPositions))}</b>`,
  ]

  if (context.attention != null) {
    lines.push(`${h(context.attention.level)}: <b>${h(context.attention.summary)}</b>`)
  }

  if (context.incident != null) {
    const actionLine = formatScheduledBriefingIncidentAction(context.incident, h)
    if (actionLine != null) {
      lines.push(actionLine)
    }
    const targetSuffix =
      context.incident.target != null && context.incident.target.length > 0
        ? ` — ${h(context.incident.target)}`
        : ''
    lines.push(
      `Incident: <b>${h(context.incident.peakState)} ${h(context.incident.status)}</b>${targetSuffix}`,
    )
  }

  if (context.operatorRecent != null && context.operatorRecent.totalActions > 0) {
    lines.push(``, `<b>Operator Recent</b>`)
    lines.push(
      `${h(String(context.operatorRecent.totalActions))} actions | ${h(String(context.operatorRecent.submitted))} submitted | ${h(String(context.operatorRecent.failed))} failed`,
    )
    for (const item of context.operatorRecent.items) {
      lines.push(
        `• <code>${h(item.action)}</code> ${h(item.target)} | ${h(item.source)} | <code>${h(item.at)}</code>`,
      )
    }
  }

  if (context.liveBuckets != null && context.liveBuckets.length > 0) {
    lines.push(``, `<b>Case Buckets</b>`)
    for (const bucket of context.liveBuckets) {
      const itemSummary = bucket.items
        .map(item => `${h(item.coin)} ${h(item.interval)} ${h(item.action)}`)
        .join(', ')
      lines.push(`• <b>${h(bucket.label)}</b> (${h(String(bucket.count))}): ${itemSummary}`)
    }
  }

  if (context.liveOversight != null && context.liveOversight.length > 0) {
    lines.push(``, `<b>Live Oversight</b>`)
    for (const item of context.liveOversight) {
      lines.push(
        `• <b>${h(item.coin)}</b> ${h(item.interval)} | ${h(item.action)} | G ${h(item.guardian)} | E ${h(item.executor)}`,
      )
    }
  }

  return lines.join('\n')
}
