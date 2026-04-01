/**
 * Telegram Bot — long-polling getUpdates loop + command router.
 *
 * Design decisions:
 *   - U1: Long-polling with 30s timeout (no webhook, no public URL needed)
 *   - U2: Chat ID whitelist — only TELEGRAM_CHAT_ID can issue commands, silent drop for others
 *   - E20: startBot() called from index.ts (I/O at edges)
 *   - E22: All telegram code in src/alert/telegram/
 *
 * The polling loop is non-blocking: uses fetch with timeout, yields between iterations.
 */

import { TELEGRAM, TELEGRAM_BOT } from '../../config.js'
import { log } from '../../lib/logger.js'
import { sendTelegramAlert } from './alerts.js'
import { findCommand, registerBuiltinCommands, getCommands } from './commands.js'
import type { TelegramUpdate, TelegramApiResponse } from './types.js'

// ─── State ─────────────────────────────────────────────────────────────────

let running = false
let lastUpdateId = 0

type FetchFn = typeof globalThis.fetch

// ─── Config Resolution ─────────────────────────────────────────────────────

interface BotConfig {
  botToken: string
  chatId: number
  apiBase: string
}

function resolveBotConfig(): BotConfig | null {
  const botToken = process.env[TELEGRAM.tokenEnv]
  const chatIdStr = process.env[TELEGRAM.chatIdEnv]
  if (!botToken || !chatIdStr) return null

  const chatId = parseInt(chatIdStr, 10)
  if (isNaN(chatId)) {
    log.warn('bot', `Invalid ${TELEGRAM.chatIdEnv}: "${chatIdStr}" — must be a number`)
    return null
  }

  return { botToken, chatId, apiBase: TELEGRAM.apiBase }
}

// ─── getUpdates ────────────────────────────────────────────────────────────

/** Fetch updates from Telegram Bot API (long-polling). */
async function getUpdates(
  config: BotConfig,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<TelegramUpdate[]> {
  const url = `${config.apiBase}/bot${config.botToken}/getUpdates`

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset: lastUpdateId + 1,
      timeout: TELEGRAM_BOT.pollingTimeoutSec,
      allowed_updates: ['message'],
    }),
    signal: AbortSignal.timeout(
      (TELEGRAM_BOT.pollingTimeoutSec + TELEGRAM_BOT.pollingExtraTimeoutSec) * 1000,
    ),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>')
    throw new Error(`getUpdates HTTP ${res.status}: ${body}`)
  }

  const data = (await res.json()) as TelegramApiResponse<TelegramUpdate[]>
  if (!data.ok) {
    throw new Error(`getUpdates API error: ${data.description ?? 'unknown'}`)
  }

  return data.result
}

// ─── Command Router ────────────────────────────────────────────────────────

/** Parse command text: "/help arg1 arg2" → { name: "help", args: "arg1 arg2" } */
function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  // Handle "/command@BotName" format
  const firstSpace = trimmed.indexOf(' ')
  const cmdPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  // Strip @BotName suffix
  const atIdx = cmdPart.indexOf('@')
  const name = atIdx === -1 ? cmdPart : cmdPart.slice(0, atIdx)

  return { name: name.toLowerCase(), args }
}

/** Route a single update: auth check → parse command → execute handler → send reply. */
async function routeUpdate(
  update: TelegramUpdate,
  config: BotConfig,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  const msg = update.message
  if (!msg?.text) return

  // U2: Chat ID whitelist — silent drop for unauthorized senders
  if (msg.chat.id !== config.chatId) {
    log.warn('bot', `Unauthorized chat ID ${msg.chat.id} from ${msg.from?.username ?? 'unknown'} — dropping`)
    return
  }

  const parsed = parseCommand(msg.text)
  if (!parsed) return // Not a command — ignore

  const cmd = findCommand(parsed.name)
  if (!cmd) {
    await sendTelegramAlert(
      `Unknown command: /${parsed.name}\\. Use /help for available commands\\.`,
      fetchFn,
    )
    return
  }

  try {
    const reply = await cmd.handler(parsed.args, msg.chat.id)
    await sendTelegramAlert(reply, fetchFn)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.error('bot', `Command /${parsed.name} failed: ${errMsg}`)
    await sendTelegramAlert(`Command /${parsed.name} failed\\. Check logs\\.`, fetchFn)
  }
}

// ─── Polling Loop ──────────────────────────────────────────────────────────

/** Start the long-polling loop. Non-blocking, runs until stopBot() is called. */
export async function startBot(fetchFn: FetchFn = globalThis.fetch): Promise<void> {
  const config = resolveBotConfig()
  if (!config) {
    log.warn('bot', `Bot disabled — set ${TELEGRAM.tokenEnv} and ${TELEGRAM.chatIdEnv} env vars`)
    return
  }

  // Register commands before starting
  registerBuiltinCommands()

  running = true
  lastUpdateId = 0

  const cmdNames = getCommands().map(c => `/${c.name}`).join(', ')
  log.info('bot', `Telegram bot started (long-polling, ${getCommands().length} commands: ${cmdNames})`)

  // Fire-and-forget polling loop — don't block startup
  pollLoop(config, fetchFn).catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('bot', `Polling loop crashed: ${msg}`)
  })
}

/** Internal polling loop. Runs until `running` is set to false. */
async function pollLoop(config: BotConfig, fetchFn: FetchFn): Promise<void> {
  let consecutiveErrors = 0

  while (running) {
    try {
      const updates = await getUpdates(config, fetchFn)
      consecutiveErrors = 0

      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id)
        await routeUpdate(update, config, fetchFn)
      }
    } catch (err) {
      consecutiveErrors++
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `getUpdates failed (${consecutiveErrors}x): ${errMsg}`)

      // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
      const backoff = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), TELEGRAM_BOT.maxBackoffMs)
      await new Promise(r => setTimeout(r, backoff))
    }
  }
}

/** Stop the polling loop gracefully. */
export function stopBot(): void {
  if (!running) return
  running = false
  log.info('bot', 'Telegram bot stopping')
}

// ─── Test Helpers ──────────────────────────────────────────────────────────

/** Exposed for testing only. */
export const _test = {
  parseCommand,
  routeUpdate,
  getUpdates,
  resetState: () => {
    running = false
    lastUpdateId = 0
  },
}
