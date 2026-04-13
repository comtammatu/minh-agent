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

import { TELEGRAM, TELEGRAM_BOT, setPaperTradeRuntimeOverride } from '../../config.js'
import { log } from '../../lib/logger.js'
import { sendTelegramAlert, formatDailySummaryHtml } from './alerts.js'
import {
  findCommand,
  registerBuiltinCommands,
  getCommands,
  executeCommandByName,
  getMainMenuKeyboard,
} from './commands.js'
import { getDailySummaryForLocalDate } from '../../agent/journal.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import type { TelegramUpdate, TelegramApiResponse } from './types.js'

// ─── State ─────────────────────────────────────────────────────────────────

let running = false
let lastUpdateId = 0
let dayReportInterval: ReturnType<typeof setInterval> | null = null
let lastMorningReportForYmd: string | null = null
let lastEveningReportForYmd: string | null = null

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

// ─── Bot API helpers ───────────────────────────────────────────────────────

/** POST Telegram Bot API (JSON body). */
async function postBotApi(
  config: BotConfig,
  method: string,
  body: Record<string, unknown>,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<boolean> {
  const url = `${config.apiBase}/bot${config.botToken}/${method}`
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM.timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Register slash commands shown in Telegram command menu. */
async function registerBotCommands(config: BotConfig, fetchFn: FetchFn): Promise<void> {
  const cmds = getCommands().map(c => ({
    command: c.name,
    description: c.description.length > 96 ? c.description.slice(0, 93) + '...' : c.description,
  }))
  const ok = await postBotApi(config, 'setMyCommands', { commands: cmds }, fetchFn)
  if (ok) {
    log.info('bot', `setMyCommands OK (${cmds.length} commands)`)
  } else {
    log.warn('bot', 'setMyCommands failed — check token / network')
  }
}

async function answerCallbackQuery(config: BotConfig, queryId: string, fetchFn: FetchFn): Promise<void> {
  await postBotApi(config, 'answerCallbackQuery', { callback_query_id: queryId }, fetchFn)
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
      allowed_updates: ['message', 'callback_query'],
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

  const firstSpace = trimmed.indexOf(' ')
  const cmdPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  const atIdx = cmdPart.indexOf('@')
  const name = atIdx === -1 ? cmdPart : cmdPart.slice(0, atIdx)

  return { name: name.toLowerCase(), args }
}

function getYmdInTimeZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value
  return `${y}-${m}-${day}`
}

function getHourMinuteInTz(d: Date, tz: string): { h: number; m: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const ho = parts.find(p => p.type === 'hour')?.value
  const mo = parts.find(p => p.type === 'minute')?.value
  return { h: parseInt(ho ?? '0', 10), m: parseInt(mo ?? '0', 10) }
}

async function tickDayReports(config: BotConfig, fetchFn: FetchFn): Promise<void> {
  const tz = TELEGRAM_BOT.reportTimezone
  const now = new Date()
  const todayYmd = getYmdInTimeZone(now, tz)
  const yesterdayYmd = getYmdInTimeZone(new Date(now.getTime() - 86_400_000), tz)
  const { h, m } = getHourMinuteInTz(now, tz)

  if (h === 0 && m <= 3 && lastMorningReportForYmd !== todayYmd) {
    lastMorningReportForYmd = todayYmd
    try {
      const summary = await getDailySummaryForLocalDate(yesterdayYmd, tz)
      const posCount = getPositionMonitor().getPositions().size
      const base = formatDailySummaryHtml('Đầu ngày — hôm qua', {
        ...summary,
        entryCount: summary.entryCount,
      })
      const html = `${base}\n\nOpen positions: <b>${posCount}</b>`
      await sendTelegramAlert(html, fetchFn, { parseMode: 'HTML' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Morning report failed: ${msg}`)
    }
  }

  if (h === 23 && m >= 55 && lastEveningReportForYmd !== todayYmd) {
    lastEveningReportForYmd = todayYmd
    try {
      const summary = await getDailySummaryForLocalDate(todayYmd, tz)
      const html = formatDailySummaryHtml('Cuối ngày — hôm nay', {
        ...summary,
        entryCount: summary.entryCount,
      })
      await sendTelegramAlert(html, fetchFn, { parseMode: 'HTML' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Evening report failed: ${msg}`)
    }
  }
}

function startDayReportScheduler(config: BotConfig, fetchFn: FetchFn): void {
  if (!TELEGRAM_BOT.dayReportsEnabled) {
    log.info('bot', 'Day reports disabled (TELEGRAM_DAY_REPORTS=false)')
    return
  }
  if (dayReportInterval) return
  dayReportInterval = setInterval(() => {
    void tickDayReports(config, fetchFn)
  }, 45_000)
  log.info('bot', `Day report scheduler (${TELEGRAM_BOT.reportTimezone}, every 45s tick)`)
}

function stopDayReportScheduler(): void {
  if (dayReportInterval) {
    clearInterval(dayReportInterval)
    dayReportInterval = null
  }
}

/** Route callback_query (inline keyboard). */
async function routeCallback(
  update: TelegramUpdate,
  config: BotConfig,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  const cq = update.callback_query
  if (!cq?.data || !cq.from) return

  const chatId = cq.message?.chat.id
  if (chatId !== config.chatId) {
    log.warn('bot', `Unauthorized callback chat ${chatId} — dropping`)
    return
  }

  await answerCallbackQuery(config, cq.id, fetchFn)

  const data = cq.data.trim()
  if (!data.startsWith('c:')) return

  const rest = data.slice(2)
  if (rest === 'paper_on') {
    setPaperTradeRuntimeOverride(true)
    await sendTelegramAlert('Paper trade: *ON* \\(runtime\\)\\.', fetchFn, { parseMode: 'MarkdownV2' })
    return
  }
  if (rest === 'paper_off') {
    setPaperTradeRuntimeOverride(false)
    await sendTelegramAlert(
      'Paper trade: *OFF* \\(live\\)\\. \\/paper reset để khôi phục override\\.',
      fetchFn,
      { parseMode: 'MarkdownV2' },
    )
    return
  }

  try {
    const reply = await executeCommandByName(rest, '', chatId)
    const isMenu = rest === 'menu'
    await sendTelegramAlert(reply, fetchFn, {
      parseMode: isMenu ? 'HTML' : 'MarkdownV2',
      ...(isMenu ? { replyMarkup: getMainMenuKeyboard() } : {}),
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
    await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
  }
}

/** Route a single update: auth check → parse command → execute handler → send reply. */
async function routeUpdate(
  update: TelegramUpdate,
  config: BotConfig,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  if (update.callback_query) {
    await routeCallback(update, config, fetchFn)
    return
  }

  const msg = update.message
  if (!msg?.text) return

  if (msg.chat.id !== config.chatId) {
    log.warn('bot', `Unauthorized chat ID ${msg.chat.id} from ${msg.from?.username ?? 'unknown'} — dropping`)
    return
  }

  const parsed = parseCommand(msg.text)
  if (!parsed) return

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
    const isMenu = parsed.name === 'menu'
    await sendTelegramAlert(reply, fetchFn, {
      parseMode: isMenu ? 'HTML' : 'MarkdownV2',
      ...(isMenu ? { replyMarkup: getMainMenuKeyboard() } : {}),
    })
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

  registerBuiltinCommands()

  running = true
  lastUpdateId = 0

  await registerBotCommands(config, fetchFn)
  startDayReportScheduler(config, fetchFn)

  const cmdNames = getCommands().map(c => `/${c.name}`).join(', ')
  log.info('bot', `Telegram bot started (long-polling, ${getCommands().length} commands: ${cmdNames})`)

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

      const backoff = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), TELEGRAM_BOT.maxBackoffMs)
      await new Promise(r => setTimeout(r, backoff))
    }
  }
}

/** Stop the polling loop gracefully. */
export function stopBot(): void {
  if (!running) return
  running = false
  stopDayReportScheduler()
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
    stopDayReportScheduler()
    lastMorningReportForYmd = null
    lastEveningReportForYmd = null
  },
  getYmdInTimeZone,
  getHourMinuteInTz,
}
