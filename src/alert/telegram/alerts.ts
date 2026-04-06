/**
 * Telegram Alerts — fire-and-forget notifications via Telegram Bot API.
 *
 * S14: Sends alerts for key agent events (setup, fill, close, circuit breaker).
 *
 * Design:
 *   - Fire-and-forget: errors are caught + logged, never bubble up.
 *   - MarkdownV2 formatting with proper escaping.
 *   - Injected fetch for testability (defaults to global fetch).
 *   - Logs WARN on startup if env vars missing (alerts disabled).
 *
 * Integration:
 *   agent.onAction(action => {
 *     const msg = formatAlert(action)
 *     if (msg) sendTelegramAlert(msg)
 *   })
 */

import { TELEGRAM } from '../../config.js'
import { log } from '../../lib/logger.js'
import type { AgentAction } from '../../agent/types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch

interface TelegramConfig {
  botToken: string
  chatId: string
}

// ─── MarkdownV2 Escaping ────────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2 format.
 * Characters that must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
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
 * Send a MarkdownV2-formatted message to the configured Telegram chat.
 * Fire-and-forget: errors are logged, never thrown.
 *
 * @param message - Already-escaped MarkdownV2 text
 * @param fetchFn - Injectable fetch for testing (defaults to global fetch)
 */
export async function sendTelegramAlert(
  message: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<boolean> {
  const config = resolveConfig()
  if (!config) return false

  const url = `${TELEGRAM.apiBase}/bot${config.botToken}/sendMessage`

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM.timeoutMs),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>')

      // MarkdownV2 parse error → retry as plain text (strip formatting)
      if (res.status === 400 && body.includes("can't parse entities")) {
        log.warn('telegram', `MarkdownV2 parse error — retrying as plain text`)
        const plain = message.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
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

      log.error('telegram', `Send failed: HTTP ${res.status} — ${body}`)
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

/**
 * Format an AgentAction into a Telegram MarkdownV2 message.
 * Returns null if the action should not generate an alert.
 */
export function formatAlert(action: AgentAction): string | null {
  if (action.type !== 'log_journal') return null

  const { eventType, coin, details } = action
  const esc = escapeMarkdownV2

  switch (eventType) {
    case 'signal': {
      const grade = details.grade as string | undefined
      // Only alert for high-grade setups (A, A+)
      if (grade !== 'A' && grade !== 'A+') return null
      const setupId = esc(String(details.setupId ?? ''))
      const confidence = details.confidence != null
        ? (Number(details.confidence) * 100).toFixed(0)
        : '?'
      return [
        `🔍 *SETUP DETECTED*`,
        ``,
        `Coin: \`${esc(coin)}\``,
        `Grade: *${esc(grade)}*`,
        `Confidence: ${esc(confidence)}%`,
        `Setup: \`${setupId}\``,
      ].join('\n')
    }

    case 'enter': {
      const side = details.side as string | undefined
      const fillPrice = details.fillPrice != null ? Number(details.fillPrice).toFixed(4) : '?'
      const arrow = side === 'short' ? '🔴' : '🟢'
      return [
        `${arrow} *ORDER FILLED*`,
        ``,
        `Coin: \`${esc(coin)}\``,
        `Side: *${esc(String(side ?? 'unknown'))}*`,
        `Price: \`${esc(fillPrice)}\``,
      ].join('\n')
    }

    case 'exit': {
      const pnl = details.pnl != null ? Number(details.pnl) : 0
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2)
      const emoji = pnl >= 0 ? '✅' : '❌'
      const reason = details.reason as string | undefined
      return [
        `${emoji} *POSITION CLOSED*`,
        ``,
        `Coin: \`${esc(coin)}\``,
        `PnL: *${esc(pnlStr)} USDC*`,
        `Reason: ${esc(String(reason ?? 'unknown'))}`,
      ].join('\n')
    }

    case 'circuit_break': {
      const reason = details.reason as string | undefined
      const dailyPnl = details.dailyPnl != null ? Number(details.dailyPnl).toFixed(2) : '?'
      return [
        `🚨 *CIRCUIT BREAKER TRIPPED*`,
        ``,
        `Reason: ${esc(String(reason ?? 'unknown'))}`,
        `Daily PnL: \`${esc(dailyPnl)} USDC\``,
      ].join('\n')
    }

    case 'invalidate': {
      // Only alert if a position is affected (not just watching)
      if (!details.positionId) return null
      const reason = details.reason as string | undefined
      return [
        `⚠️ *PATTERN INVALIDATED*`,
        ``,
        `Coin: \`${esc(coin)}\``,
        `Reason: ${esc(String(reason ?? 'unknown'))}`,
        `Position: \`${esc(String(details.positionId))}\``,
        `Action: closing position`,
      ].join('\n')
    }

    default:
      return null
  }
}

// ─── Daily Summary ──────────────────────────────────────────────────────────

/** Format a daily PnL summary for Telegram. */
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
