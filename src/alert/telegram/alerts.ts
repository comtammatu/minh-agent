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

import { TELEGRAM } from '../../config.js'
import { log } from '../../lib/logger.js'
import type { AgentAction } from '../../agent/types.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
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

/** HTML scheduled briefing with live context (positions, oversight, operator activity). */
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
    attention: { level: string; summary: string } | null
    incident: {
      peakState: string
      status: string
      target: string | null
      cause: string
      recommendedAction: string
    } | null
    liveBuckets: Array<{
      label: string
      count: number
      coin: string
      items: Array<{ coin: string; interval: string; action: string }>
    }>
    operatorRecent: {
      totalActions: number
      submitted: number
      failed: number
      items: Array<{ action: string; target: string; source: string; at: string }>
    }
    liveOversight: Array<{
      coin: string
      interval: string
      action: string
      guardian: string
      executor: string
    }>
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
    `Trades: <b>${h(String(summary.totalTrades))}</b> · Open: <b>${h(String(context.openPositions))}</b>`,
    `Win rate: <b>${h(winRatePct)}%</b> (${h(String(summary.wins))}W / ${h(String(summary.losses))}L)`,
    `PnL: <b>${h(pnlStr)} USDC</b>`,
  ]

  if (context.attention != null) {
    lines.push(``, `⚠️ <b>${h(context.attention.level)}</b>: ${h(context.attention.summary)}`)
  }

  if (context.incident != null) {
    lines.push(
      ``,
      `🔴 <b>Incident</b> (${h(context.incident.peakState)} ${h(context.incident.status)})`,
      `  Cause: ${h(context.incident.cause)}`,
      `  Action: ${h(context.incident.recommendedAction)}`,
    )
    if (context.incident.target != null) {
      lines.push(`  Target: ${h(context.incident.target)}`)
    }
  }

  if (context.liveOversight.length > 0) {
    lines.push(``, `<b>Live Oversight</b>`)
    for (const trace of context.liveOversight) {
      lines.push(
        `  ${h(trace.coin)} ${h(trace.interval)} — ${h(trace.action)} (G:${h(trace.guardian)} E:${h(trace.executor)})`,
      )
    }
  }

  if (context.liveBuckets.length > 0) {
    lines.push(``, `<b>Decision Buckets</b>`)
    for (const bucket of context.liveBuckets) {
      lines.push(`  ${h(bucket.label)}: ${h(String(bucket.count))} (${h(bucket.coin)})`)
    }
  }

  if (context.operatorRecent.totalActions > 0) {
    lines.push(
      ``,
      `<b>Operator</b>: ${h(String(context.operatorRecent.submitted))} ok / ${h(String(context.operatorRecent.failed))} fail`,
    )
    for (const item of context.operatorRecent.items) {
      lines.push(`  ${h(item.action)} → ${h(item.target)} (${h(item.source)} ${h(item.at)})`)
    }
  }

  return lines.join('\n')
}
