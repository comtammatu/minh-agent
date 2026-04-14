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
import { sendTelegramAlert, formatScheduledBriefingHtml, escapeMarkdownV2 } from './alerts.js'
import {
  type BriefingRefreshContext,
  type BriefingRefreshIncident,
  getBriefingRefreshIncidents,
  getBriefingRefreshStats,
  getBriefingRefreshHealth,
  getBriefingRefreshHistory,
  type BriefingRefreshHealthSnapshot,
  type BriefingRefreshHealthTransition,
  recordBriefingRefreshOutcome,
  recordBriefingRefreshRequested,
  resetBriefingRefreshStats,
} from './briefing-refresh-stats.js'
import {
  findCommand,
  registerBuiltinCommands,
  getCommands,
  executeCommandByName,
  getMainMenuKeyboard,
  getPendingOperatorActionReplyMarkup,
  cancelPendingOperatorAction,
  getPendingOperatorBriefingSource,
  getTracePositionReplyMarkup,
  parseTracePositionArgs,
  requestRemoteOperatorActionWithContext,
  getBriefingReplyMarkup,
} from './commands.js'
import { getDailySummaryForLocalDate, getJournalEntries } from '../../agent/journal.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import { getDecisionTraces } from '../../strategy/orchestrator.js'
import type { TelegramUpdate, TelegramApiResponse } from './types.js'
import type { DecisionTrace } from '../../types.js'

// ─── State ─────────────────────────────────────────────────────────────────

let running = false
let lastUpdateId = 0
let dayReportInterval: ReturnType<typeof setInterval> | null = null
let lastMorningReportForYmd: string | null = null
let lastEveningReportForYmd: string | null = null
const briefingMessageCache = new Map<string, {
  text: string
  replyMarkupJson: string
}>()
const briefingRefreshJobs = new Map<string, {
  timer: ReturnType<typeof setTimeout>
  latest: {
    config: BotConfig
    chatId: number
    messageId: number
    kind: 'morning' | 'evening' | 'live'
    fetchFn: FetchFn
    now: Date
  }
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}>()

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

async function editBotMessage(
  config: BotConfig,
  chatId: number,
  messageId: number,
  text: string,
  fetchFn: FetchFn,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  await postBotApi(config, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }, fetchFn)
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

function formatRoleState(value: string): string {
  return value.replace(/_/g, ' ').toUpperCase()
}

function hasGuardianExitReady(trace: DecisionTrace): boolean {
  return trace.roles.guardian?.state === 'exit_ready'
}

function computeBriefingSeverity(trace: DecisionTrace): number {
  if (hasGuardianExitReady(trace)) return 100
  switch (trace.outcome.action) {
    case 'exit':
      return 100
    case 'trail_sl':
    case 'partial_close':
      return 90
    case 'hold':
      return 75
    case 'enter':
      return 70
    case 'watch':
      return 50
    case 'skip':
      return 10
    default:
      return 40
  }
}

function formatBriefingAttention(trace: DecisionTrace): { level: string; summary: string } {
  const base = `${trace.coin} ${trace.interval} — ${trace.outcome.summary}`
  if (hasGuardianExitReady(trace)) {
    return { level: 'ALERT', summary: base }
  }
  switch (trace.outcome.action) {
    case 'exit':
      return { level: 'ALERT', summary: base }
    case 'trail_sl':
    case 'partial_close':
      return { level: 'ACTIVE', summary: base }
    case 'hold':
    case 'enter':
      return { level: 'WATCH', summary: base }
    default:
      return { level: 'STEADY', summary: base }
  }
}

function summarizeBriefingIncident(
  incident: BriefingRefreshIncident,
  snapshot: BriefingRefreshHealthSnapshot,
): {
  cause: string
  recommendedAction: string
  preferredHealthAction: 'trace' | 'operator'
  healthButtonLabels: { trace: string; operator: string }
} {
  const failed = Math.max(
    snapshot.failureStreak,
    incident.transitions.filter(transition => transition.outcome === 'failed').length,
  )
  const coalesced = Math.max(
    snapshot.coalesced,
    incident.transitions.filter(transition => transition.outcome === 'coalesced').length,
  )
  const skippedIdentical = Math.max(
    snapshot.skippedIdentical,
    incident.transitions.filter(transition => transition.outcome === 'skipped_identical').length,
  )

  if (failed > 0 && failed >= coalesced) {
    return {
      cause: incident.target != null
        ? `Edit failure streak around ${incident.target}`
        : 'Edit failure streak in the briefing pipeline',
      recommendedAction: 'Open Health Operator first, then refresh the briefing after the failing action path is clear.',
      preferredHealthAction: 'operator',
      healthButtonLabels: {
        trace: '🧠 Inspect Trace',
        operator: '⚠️ Fix Operator Path',
      },
    }
  }

  if (coalesced >= 2) {
    return {
      cause: incident.target != null
        ? `Refresh storm around ${incident.target}`
        : 'Refresh storm in the briefing pipeline',
      recommendedAction: 'Open Health Trace first, then use Health Operator only if the case still needs manual intervention.',
      preferredHealthAction: 'trace',
      healthButtonLabels: {
        trace: '⚠️ Inspect Health Trace',
        operator: '🧾 Check Operator',
      },
    }
  }

  if (skippedIdentical >= 1) {
    return {
      cause: incident.target != null
        ? `Identical refresh loop around ${incident.target}`
        : 'Identical refresh loop in the briefing pipeline',
      recommendedAction: 'Open Health Trace first, wait for the case to change state, then refresh the briefing once.',
      preferredHealthAction: 'trace',
      healthButtonLabels: {
        trace: '⚠️ Inspect Health Trace',
        operator: '🧾 Check Operator',
      },
    }
  }

  return {
    cause: incident.target != null
      ? `Health drift around ${incident.target}`
      : 'Health drift in the briefing pipeline',
    recommendedAction: 'Open Health Trace first, then use Health Operator if the target needs manual intervention.',
    preferredHealthAction: 'trace',
    healthButtonLabels: {
      trace: '⚠️ Inspect Health Trace',
      operator: '🧾 Check Operator',
    },
  }
}

function classifyBriefingBucket(
  trace: DecisionTrace,
): { label: string; priority: number } {
  if (hasGuardianExitReady(trace) || trace.outcome.action === 'exit') {
    return { label: 'Needs Action', priority: 0 }
  }
  switch (trace.outcome.action) {
    case 'trail_sl':
    case 'partial_close':
    case 'hold':
    case 'enter':
      return { label: 'Guardian Active', priority: 1 }
    case 'watch':
      return { label: 'Watching', priority: 2 }
    default:
      return { label: 'Steady', priority: 3 }
  }
}

function buildBriefingBuckets(liveTraces: DecisionTrace[]): Array<{
  label: string
  count: number
  coin: string
  positionId?: string
  items: Array<{ coin: string; interval: string; action: string }>
}> {
  type BriefingBucketState = {
    priority: number
    coin: string
    positionId?: string
    items: Array<{ coin: string; interval: string; action: string }>
  }
  const bucketMap = new Map<string, BriefingBucketState>()

  for (const trace of liveTraces.slice(1)) {
    const bucket = classifyBriefingBucket(trace)
    const current: BriefingBucketState = bucketMap.get(bucket.label) ?? {
      priority: bucket.priority,
      coin: trace.coin,
      items: [],
      ...(trace.outcome.positionId != null ? { positionId: trace.outcome.positionId } : {}),
    }
    current.items.push({
      coin: trace.coin,
      interval: trace.interval,
      action: trace.outcome.action.toUpperCase(),
    })
    bucketMap.set(bucket.label, current)
  }

  return [...bucketMap.entries()]
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([label, value]) => ({
      label,
      count: value.items.length,
      coin: value.coin,
      items: value.items,
      ...(value.positionId != null ? { positionId: value.positionId } : {}),
    }))
}

function getLiveOversightTraces(): DecisionTrace[] {
  return [...getDecisionTraces()]
    .filter(trace => trace.strategyId !== 'system' || trace.outcome.positionId != null)
    .sort((a, b) => {
      const severityDelta = computeBriefingSeverity(b) - computeBriefingSeverity(a)
      if (severityDelta !== 0) return severityDelta
      return b.ts - a.ts
    })
    .slice(0, 3)
}

function resolveBriefingFocus(liveTraces: DecisionTrace[]): { positionId?: string; coin?: string } {
  const hottestPosition = liveTraces.find(trace => trace.outcome.positionId != null)
  if (hottestPosition?.outcome.positionId != null) {
    return {
      positionId: hottestPosition.outcome.positionId,
      coin: hottestPosition.coin,
    }
  }

  const hottestTrace = liveTraces[0]
  if (hottestTrace != null) {
    return { coin: hottestTrace.coin }
  }

  const firstTracked = getPositionMonitor().getPositions().values().next().value
  if (firstTracked != null) {
    return {
      positionId: firstTracked.positionId,
      coin: firstTracked.coin,
    }
  }

  return {}
}

async function buildScheduledBriefing(
  title: string,
  summary: Awaited<ReturnType<typeof getDailySummaryForLocalDate>>,
): Promise<{
  html: string
  focus: {
    positionId?: string
    coin?: string
    buckets?: Array<{ label: string; positionId?: string; coin?: string }>
  }
}> {
  const operatorEntries = await getJournalEntries({
    eventType: 'operator',
    limit: 5,
  })
  const liveTraces = getLiveOversightTraces()
  const focus = resolveBriefingFocus(liveTraces)
  const leadTrace = liveTraces[0] ?? null
  const liveBuckets = buildBriefingBuckets(liveTraces)
  const leadIncident = getBriefingRefreshIncidents(1)[0] ?? null
  const healthSnapshot = getBriefingRefreshHealth()

  const html = formatScheduledBriefingHtml(title, {
    ...summary,
    entryCount: summary.entryCount,
  }, {
    openPositions: getPositionMonitor().getPositions().size,
    attention: leadTrace != null ? formatBriefingAttention(leadTrace) : null,
    incident: leadIncident != null
      ? (() => {
          const summary = summarizeBriefingIncident(leadIncident, healthSnapshot)
          return {
          peakState: leadIncident.peakState.toUpperCase(),
          status: leadIncident.status.toUpperCase(),
          target: leadIncident.target,
            cause: summary.cause,
            recommendedAction: summary.recommendedAction,
          }
        })()
      : null,
    liveBuckets,
    operatorRecent: {
      totalActions: operatorEntries.length,
      submitted: operatorEntries.filter(entry => entry.details.status === 'submitted').length,
      failed: operatorEntries.filter(entry => entry.details.status === 'failed').length,
      items: operatorEntries.slice(0, 3).map(entry => ({
        action: typeof entry.details.action === 'string' ? entry.details.action : 'manual',
        target: typeof entry.details.target === 'string' ? entry.details.target : (entry.coin ?? 'unknown'),
        source: typeof entry.details.operatorSource === 'string' ? entry.details.operatorSource.toUpperCase() : 'MANUAL',
        at: entry.ts.toISOString().slice(11, 19),
      })),
    },
    liveOversight: liveTraces.map(trace => ({
      coin: trace.coin,
      interval: trace.interval,
      action: trace.outcome.action.toUpperCase(),
      guardian: trace.roles.guardian != null ? formatRoleState(trace.roles.guardian.state) : 'WAITING',
      executor: trace.roles.executor != null ? formatRoleState(trace.roles.executor.state) : 'IDLE',
    })),
  })

  return {
    html,
    focus: {
      ...focus,
      buckets: liveBuckets.map(bucket => ({
        label: bucket.label,
        coin: bucket.coin,
        ...(bucket.positionId != null ? { positionId: bucket.positionId } : {}),
      })),
    },
  }
}

function inferBriefingKind(text: string | undefined): 'morning' | 'evening' | 'live' {
  if (text?.includes('Đầu ngày')) return 'morning'
  if (text?.includes('Cuối ngày')) return 'evening'
  return 'live'
}

function formatBriefingTargetLabel(focus: {
  positionId?: string
  coin?: string
}): string | null {
  if (focus.positionId != null && focus.coin != null) {
    return `${focus.coin} / ${focus.positionId}`
  }
  if (focus.positionId != null) return focus.positionId
  if (focus.coin != null) return focus.coin
  return null
}

function formatBriefingAttentionLabel(trace: DecisionTrace): string {
  return `${trace.coin} ${trace.interval}`
}

function isBriefingKind(value: string): value is 'morning' | 'evening' | 'live' {
  return value === 'morning' || value === 'evening' || value === 'live'
}

function getCallbackBriefingSource(
  cq: TelegramUpdate['callback_query'],
): { messageId: number; kind: 'morning' | 'evening' | 'live' } | null {
  const messageId = cq?.message?.message_id
  if (messageId == null) return null
  return {
    messageId,
    kind: inferBriefingKind(cq?.message?.text),
  }
}

async function buildBriefingRefreshPayload(
  kind: 'morning' | 'evening' | 'live',
  now: Date,
): Promise<{
  html: string
  replyMarkup: ReturnType<typeof getBriefingReplyMarkup>
  context: BriefingRefreshContext
}> {
  const tz = TELEGRAM_BOT.reportTimezone
  const todayYmd = getYmdInTimeZone(now, tz)
  const yesterdayYmd = getYmdInTimeZone(new Date(now.getTime() - 86_400_000), tz)

  const title =
    kind === 'morning'
      ? 'Đầu ngày — hôm qua'
      : kind === 'evening'
        ? 'Cuối ngày — hôm nay'
        : 'Live Briefing'
  const summaryDate = kind === 'morning' ? yesterdayYmd : todayYmd
  const summary = await getDailySummaryForLocalDate(summaryDate, tz)
  const { html, focus } = await buildScheduledBriefing(title, summary)
  const liveTraces = getLiveOversightTraces()
  const leadTrace = liveTraces[0] ?? null
  const healthSnapshot = getBriefingRefreshHealth()
  const healthTargetSnapshot = resolveBriefingHealthTarget(healthSnapshot)
  const healthTarget = {
    positionId: healthTargetSnapshot.positionId ?? focus.positionId ?? null,
    coin: healthTargetSnapshot.coin ?? focus.coin ?? leadTrace?.coin ?? null,
  }
  const leadIncident = getBriefingRefreshIncidents(1)[0] ?? null
  const prioritizeHealthTarget = leadIncident?.status === 'active'
  const incidentSummary = leadIncident != null ? summarizeBriefingIncident(leadIncident, healthSnapshot) : null
  const preferredHealthAction = incidentSummary?.preferredHealthAction ?? null
  return {
    html,
    replyMarkup: getBriefingReplyMarkup({
      ...focus,
      briefingKind: kind,
      prioritizeHealthTarget,
      preferredHealthAction,
      healthButtonLabels: incidentSummary?.healthButtonLabels ?? null,
      healthTarget,
    }),
    context: {
      coin: focus.coin ?? leadTrace?.coin ?? null,
      positionId: focus.positionId ?? null,
      target: formatBriefingTargetLabel(focus),
      attention: leadTrace != null ? `${formatBriefingAttentionLabel(leadTrace)} ${leadTrace.outcome.action.toUpperCase()}` : null,
    },
  }
}

function shouldSkipBriefingEdit(
  cacheKey: string,
  html: string,
  replyMarkup: ReturnType<typeof getBriefingReplyMarkup>,
): boolean {
  const previousPayload = briefingMessageCache.get(cacheKey)
  if (previousPayload == null) return false
  return previousPayload.text === html && previousPayload.replyMarkupJson === JSON.stringify(replyMarkup)
}

function cacheBriefingPayload(
  cacheKey: string,
  html: string,
  replyMarkup: ReturnType<typeof getBriefingReplyMarkup>,
): void {
  briefingMessageCache.set(cacheKey, {
    text: html,
    replyMarkupJson: JSON.stringify(replyMarkup),
  })
}

function logBriefingRefreshOutcome(
  outcome: 'coalesced' | 'skipped_identical' | 'edited' | 'failed',
  key: string,
  kind: 'morning' | 'evening' | 'live',
): void {
  log.info('bot', `Briefing refresh ${outcome} (${kind} ${key})`)
}

function shouldAnnounceBriefingHealthTransition(
  transition: BriefingRefreshHealthTransition,
): boolean {
  if (transition.to === 'healthy') {
    return transition.from !== 'healthy'
  }

  return transition.from === 'healthy' || transition.to === 'critical'
}

function formatBriefingHealthSummary(snapshot: BriefingRefreshHealthSnapshot): string {
  const editPct = Math.round(snapshot.editRatio * 100)
  const pieces = [
    `${snapshot.samples} sample${snapshot.samples === 1 ? '' : 's'}`,
    `${editPct}% edits`,
  ]

  if (snapshot.failed > 0) pieces.push(`${snapshot.failed} failed`)
  if (snapshot.coalesced > 0) pieces.push(`${snapshot.coalesced} coalesced`)
  if (snapshot.failureStreak > 0) pieces.push(`${snapshot.failureStreak} fail streak`)
  if (snapshot.coalescedStreak > 0) pieces.push(`${snapshot.coalescedStreak} coalesced streak`)

  return pieces.slice(0, 4).join(' · ')
}

function resolveBriefingHealthTarget(snapshot: BriefingRefreshHealthSnapshot): {
  coin: string | null
  positionId: string | null
  target: string | null
  attention: string | null
} {
  if (snapshot.state === 'healthy' && snapshot.recoveredFrom != null) {
    return {
      coin: snapshot.recoveredCoin,
      positionId: snapshot.recoveredPositionId,
      target: snapshot.recoveredTarget,
      attention: snapshot.recoveredAttention,
    }
  }

  return {
    coin: snapshot.lastCoin,
    positionId: snapshot.lastPositionId,
    target: snapshot.lastTarget,
    attention: snapshot.lastAttention,
  }
}

function matchesBriefingHealthTarget(
  target: {
    positionId?: string | null
    coin?: string | null
  },
  healthTarget: {
    coin: string | null
    positionId: string | null
  },
): boolean {
  const normalizedCoin = target.coin?.trim().toUpperCase() ?? null
  const healthCoin = healthTarget.coin?.trim().toUpperCase() ?? null

  if (
    target.positionId != null &&
    healthTarget.positionId != null &&
    target.positionId.length > 0 &&
    healthTarget.positionId.length > 0
  ) {
    return target.positionId === healthTarget.positionId
  }

  if (normalizedCoin != null && healthCoin != null) {
    return normalizedCoin === healthCoin
  }

  return false
}

function formatBriefingHealthFollowupIntro(
  mode: 'trace' | 'operator',
  target: {
    positionId?: string | null
    coin?: string | null
  },
): string | null {
  const normalizedTarget = (target.coin ?? target.positionId ?? '').trim()
  const normalizedCoin = target.coin?.trim().toUpperCase() ?? null
  const normalizedCoinForMatch = target.coin?.trim().toUpperCase() ?? null
  const normalizedPositionId = target.positionId?.trim() ?? null
  const targetLabel =
    normalizedCoin != null && normalizedPositionId != null
      ? `${normalizedCoin} / ${normalizedPositionId}`
      : normalizedTarget
      ? normalizedTarget
      : null

  const leadIncident = getBriefingRefreshIncidents(1)[0] ?? null
  const healthSnapshot = getBriefingRefreshHealth()
  const healthTarget = resolveBriefingHealthTarget(healthSnapshot)

  if (targetLabel == null || targetLabel.length === 0) return null

  const isCoinMatch =
    normalizedCoinForMatch != null &&
    healthTarget.coin != null &&
    normalizedCoinForMatch === healthTarget.coin.toUpperCase()

  const contextLines: string[] = [
    `Target: ${escapeMarkdownV2(targetLabel)}.`,
  ]
  if (isCoinMatch && healthTarget.attention != null) {
    contextLines.push(`Attention: ${escapeMarkdownV2(healthTarget.attention)}.`)
  }

  if (leadIncident == null || !matchesBriefingHealthTarget(target, healthTarget)) {
    const title =
      mode === 'trace'
        ? '🧭 *Trace Focus*'
        : '🧭 *Operator Focus*'
    return [title, ...contextLines].join('\n')
  }

  const incidentSummary = summarizeBriefingIncident(leadIncident, healthSnapshot)
  const esc = escapeMarkdownV2
  const title =
    leadIncident.status === 'active'
      ? (mode === 'trace' ? '⚠️ *Health Trace Focus*' : '⚠️ *Health Operator Focus*')
      : (mode === 'trace' ? '✅ *Recovered Trace Check*' : '✅ *Recovered Operator Check*')
  const lead =
    mode === 'trace'
      ? `Inspecting trace for ${esc(incidentSummary.cause)}\\.`
      : `Checking operator path for ${esc(incidentSummary.cause)}\\.`
  const hint =
    mode === 'trace'
      ? `Use this view to verify whether the case already changed state before acting\\.`
      : `Use this view to confirm whether manual intervention is still needed\\.`

  return [
    title,
    lead,
    ...contextLines,
    hint,
  ].join('\n')
}

function prependBriefingHealthIntro(reply: string, intro: string | null): string {
  if (intro == null || intro.length === 0) return reply
  const hasTarget = reply.includes('Target:')
  if (!hasTarget) return `${intro}\n\n${reply}`

  const isBasicFocus = intro.startsWith('🧭 *Trace Focus*') || intro.startsWith('🧭 *Operator Focus*')
  if (isBasicFocus) return reply

  const isIncidentFocused = intro.includes('Health Trace Focus')
    || intro.includes('Health Operator Focus')
    || intro.includes('Recovered Trace Check')
    || intro.includes('Recovered Operator Check')

  if (!isIncidentFocused) return reply

  const compactIntro = intro
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('Target:') && !line.startsWith('Attention:'))
    .join('\n')

  return compactIntro.length === 0 ? reply : `${compactIntro}\n\n${reply}`
}

async function announceBriefingHealthTransition(
  transition: BriefingRefreshHealthTransition,
  fetchFn: FetchFn,
): Promise<void> {
  if (!shouldAnnounceBriefingHealthTransition(transition)) return

  const summary = formatBriefingHealthSummary(transition.snapshot)
  const label =
    transition.to === 'healthy'
      ? 'recovered'
      : transition.to === 'critical'
        ? 'critical'
        : 'degraded'
  const lastKind = transition.snapshot.lastKind ?? 'live'
  const lastOutcome = transition.snapshot.lastOutcome ?? 'unknown'
  const message = [
    `<b>Briefing health ${label}</b>`,
    `State: ${transition.from} → ${transition.to}`,
    `Window: ${summary}`,
    `Last: ${lastKind} · ${lastOutcome}`,
    ...(
      transition.to === 'healthy' && transition.snapshot.recoveredTarget != null
        ? [`Recovered: ${transition.snapshot.recoveredTarget}`]
        : transition.snapshot.lastTarget != null
          ? [`Target: ${transition.snapshot.lastTarget}`]
          : []
    ),
    ...(
      transition.to === 'healthy' && transition.snapshot.recoveredAttention != null
        ? [`Recovered attention: ${transition.snapshot.recoveredAttention}`]
        : transition.snapshot.lastAttention != null
          ? [`Attention: ${transition.snapshot.lastAttention}`]
          : []
    ),
  ].join('\n')

  try {
    const ok = await sendTelegramAlert(message, fetchFn, { parseMode: 'HTML' })
    if (ok) {
      if (transition.to === 'healthy') {
        log.info('bot', `Briefing health recovered (${summary})`)
      } else {
        log.warn('bot', `Briefing health ${transition.to} (${summary})`)
      }
    } else {
      log.warn('bot', `Briefing health alert failed (${transition.from} → ${transition.to})`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn('bot', `Briefing health alert failed: ${msg}`)
  }
}

async function recordBriefingRefreshOutcomeAndMaybeAlert(
  outcome: 'coalesced' | 'skipped_identical' | 'edited' | 'failed',
  key: string,
  kind: 'morning' | 'evening' | 'live',
  fetchFn: FetchFn,
  context?: BriefingRefreshContext,
): Promise<void> {
  const transition = recordBriefingRefreshOutcome(outcome, key, kind, context)
  logBriefingRefreshOutcome(outcome, key, kind)
  if (transition != null) {
    await announceBriefingHealthTransition(transition, fetchFn)
  }
}

async function refreshBriefingMessage(
  config: BotConfig,
  chatId: number,
  messageId: number,
  kind: 'morning' | 'evening' | 'live',
  fetchFn: FetchFn,
  now: Date = new Date(),
): Promise<void> {
  const key = `${chatId}:${messageId}`
  recordBriefingRefreshRequested()
  const existing = briefingRefreshJobs.get(key)

  if (existing != null) {
    await recordBriefingRefreshOutcomeAndMaybeAlert('coalesced', key, kind, fetchFn)
    clearTimeout(existing.timer)
    existing.latest = { config, chatId, messageId, kind, fetchFn, now }
    existing.timer = setTimeout(async () => {
      const job = briefingRefreshJobs.get(key)
      if (job == null) return
      try {
        const { html, replyMarkup, context } = await buildBriefingRefreshPayload(job.latest.kind, job.latest.now)
        const cacheKey = `${job.latest.chatId}:${job.latest.messageId}`
        if (shouldSkipBriefingEdit(cacheKey, html, replyMarkup)) {
          await recordBriefingRefreshOutcomeAndMaybeAlert(
            'skipped_identical',
            cacheKey,
            job.latest.kind,
            job.latest.fetchFn,
            context,
          )
          job.resolve()
          return
        }
        await editBotMessage(
          job.latest.config,
          job.latest.chatId,
          job.latest.messageId,
          html,
          job.latest.fetchFn,
          replyMarkup,
        )
        cacheBriefingPayload(cacheKey, html, replyMarkup)
        await recordBriefingRefreshOutcomeAndMaybeAlert(
          'edited',
          cacheKey,
          job.latest.kind,
          job.latest.fetchFn,
          context,
        )
        job.resolve()
      } catch (err) {
        await recordBriefingRefreshOutcomeAndMaybeAlert(
          'failed',
          key,
          job.latest.kind,
          job.latest.fetchFn,
        )
        job.reject(err)
      } finally {
        briefingRefreshJobs.delete(key)
      }
    }, TELEGRAM_BOT.briefingRefreshDebounceMs)
    return existing.promise
  }

  let resolvePromise: () => void = () => {}
  let rejectPromise: (err: unknown) => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const job = {
    timer: setTimeout(async () => {
      const currentJob = briefingRefreshJobs.get(key)
      if (currentJob == null) return
      try {
        const { html, replyMarkup, context } = await buildBriefingRefreshPayload(currentJob.latest.kind, currentJob.latest.now)
        const cacheKey = `${currentJob.latest.chatId}:${currentJob.latest.messageId}`
        if (shouldSkipBriefingEdit(cacheKey, html, replyMarkup)) {
          await recordBriefingRefreshOutcomeAndMaybeAlert(
            'skipped_identical',
            cacheKey,
            currentJob.latest.kind,
            currentJob.latest.fetchFn,
            context,
          )
          currentJob.resolve()
          return
        }
        await editBotMessage(
          currentJob.latest.config,
          currentJob.latest.chatId,
          currentJob.latest.messageId,
          html,
          currentJob.latest.fetchFn,
          replyMarkup,
        )
        cacheBriefingPayload(cacheKey, html, replyMarkup)
        await recordBriefingRefreshOutcomeAndMaybeAlert(
          'edited',
          cacheKey,
          currentJob.latest.kind,
          currentJob.latest.fetchFn,
          context,
        )
        currentJob.resolve()
      } catch (err) {
        await recordBriefingRefreshOutcomeAndMaybeAlert(
          'failed',
          key,
          currentJob.latest.kind,
          currentJob.latest.fetchFn,
        )
        currentJob.reject(err)
      } finally {
        briefingRefreshJobs.delete(key)
      }
    }, TELEGRAM_BOT.briefingRefreshDebounceMs),
    latest: { config, chatId, messageId, kind, fetchFn, now },
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
  briefingRefreshJobs.set(key, job)
  return promise
}

async function tickDayReports(config: BotConfig, fetchFn: FetchFn, now: Date = new Date()): Promise<void> {
  const tz = TELEGRAM_BOT.reportTimezone
  const todayYmd = getYmdInTimeZone(now, tz)
  const yesterdayYmd = getYmdInTimeZone(new Date(now.getTime() - 86_400_000), tz)
  const { h, m } = getHourMinuteInTz(now, tz)

  if (h === 0 && m <= 3 && lastMorningReportForYmd !== todayYmd) {
    lastMorningReportForYmd = todayYmd
    try {
      const summary = await getDailySummaryForLocalDate(yesterdayYmd, tz)
      const { html, focus } = await buildScheduledBriefing('Đầu ngày — hôm qua', summary)
      await sendTelegramAlert(html, fetchFn, {
        parseMode: 'HTML',
        replyMarkup: getBriefingReplyMarkup({ ...focus, briefingKind: 'morning' }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Morning report failed: ${msg}`)
    }
  }

  if (h === 23 && m >= 55 && lastEveningReportForYmd !== todayYmd) {
    lastEveningReportForYmd = todayYmd
    try {
      const summary = await getDailySummaryForLocalDate(todayYmd, tz)
      const { html, focus } = await buildScheduledBriefing('Cuối ngày — hôm nay', summary)
      await sendTelegramAlert(html, fetchFn, {
        parseMode: 'HTML',
        replyMarkup: getBriefingReplyMarkup({ ...focus, briefingKind: 'evening' }),
      })
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

function isRemoteOperatorActionArgs(args: string): boolean {
  const head = args.trim().split(/\s+/)[0]?.toLowerCase()
  return head === 'close' || head === 'reduce'
}

function sendMarkdownReply(
  message: string,
  fetchFn: FetchFn,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  return sendTelegramAlert(message, fetchFn, {
    parseMode: 'MarkdownV2',
    ...(replyMarkup ? { replyMarkup } : {}),
  })
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
  if (rest === 'operator_confirm') {
    const briefingSource = getPendingOperatorBriefingSource(chatId)
    try {
      const reply = await executeCommandByName('confirm', '', chatId)
      await sendTelegramAlert(reply, fetchFn, { parseMode: 'MarkdownV2' })
      if (briefingSource != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingSource.messageId,
          briefingSource.kind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest === 'operator_cancel') {
    const briefingSource = getPendingOperatorBriefingSource(chatId)
    const reply = cancelPendingOperatorAction(chatId)
    await sendTelegramAlert(reply, fetchFn, { parseMode: 'MarkdownV2' })
    if (briefingSource != null) {
      await refreshBriefingMessage(
        config,
        chatId,
        briefingSource.messageId,
        briefingSource.kind,
        fetchFn,
      )
    }
    return
  }
  if (rest.startsWith('trace_close:') || rest.startsWith('trace_reduce25:') || rest.startsWith('trace_reduce50:')) {
    const match = rest.match(/^(trace_close|trace_reduce25|trace_reduce50):(.+?)(?::b:(\d+):(morning|evening|live))?$/)
    if (match == null) {
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
      return
    }
    const [, kind, positionId, briefingMessageIdRaw, briefingKindRaw] = match
    const operatorArgs =
      kind === 'trace_close'
        ? `close ${positionId}`
        : kind === 'trace_reduce25'
          ? `reduce ${positionId} 25`
          : `reduce ${positionId} 50`
    try {
      const briefingSource =
        briefingMessageIdRaw != null && briefingKindRaw != null && isBriefingKind(briefingKindRaw)
          ? {
              messageId: parseInt(briefingMessageIdRaw, 10),
              kind: briefingKindRaw,
            }
          : undefined
      const reply =
        briefingSource != null
          ? await requestRemoteOperatorActionWithContext(operatorArgs, chatId, briefingSource)
          : await executeCommandByName('operator', operatorArgs, chatId)
      await sendMarkdownReply(reply, fetchFn, getPendingOperatorActionReplyMarkup(chatId) ?? undefined)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('trace_refresh:')) {
    const match = rest.match(/^trace_refresh:(.+?)(?::b:(\d+):(morning|evening|live))?$/)
    if (match == null) {
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
      return
    }
    const [, positionId, briefingMessageIdRaw, briefingKindRaw] = match
    if (positionId == null) {
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
      return
    }
    try {
      const reply = await executeCommandByName('trace', `position ${positionId}`, chatId)
      const briefingContext =
        briefingMessageIdRaw != null && briefingKindRaw != null && isBriefingKind(briefingKindRaw)
          ? {
              briefingMessageId: parseInt(briefingMessageIdRaw, 10),
              briefingKind: briefingKindRaw,
            }
          : undefined
      await sendMarkdownReply(
        reply,
        fetchFn,
        getTracePositionReplyMarkup(positionId, briefingContext) ?? undefined,
      )
      if (briefingContext != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingContext.briefingMessageId,
          briefingContext.briefingKind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('briefing_trace_position:')) {
    const positionId = rest.slice('briefing_trace_position:'.length)
    try {
      const reply = await executeCommandByName('trace', `position ${positionId}`, chatId)
      const prefacedReply = prependBriefingHealthIntro(
        reply,
        formatBriefingHealthFollowupIntro('trace', { positionId }),
      )
      const briefingSource = getCallbackBriefingSource(cq)
      const briefingContext =
        briefingSource != null
          ? {
              briefingMessageId: briefingSource.messageId,
              briefingKind: briefingSource.kind,
            }
          : undefined
      await sendMarkdownReply(
        prefacedReply,
        fetchFn,
        getTracePositionReplyMarkup(positionId, briefingContext) ?? undefined,
      )
      if (briefingSource != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingSource.messageId,
          briefingSource.kind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('briefing_refresh:')) {
    const rawKind = rest.slice('briefing_refresh:'.length)
    const kind = isBriefingKind(rawKind) ? rawKind : inferBriefingKind(cq.message?.text)
    const messageId = cq.message?.message_id
    if (messageId == null) return
    try {
      await refreshBriefingMessage(config, chatId, messageId, kind, fetchFn)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('briefing_trace_coin:')) {
    const coin = rest.slice('briefing_trace_coin:'.length).trim().toUpperCase()
    try {
      const briefingSource = getCallbackBriefingSource(cq)
      const reply = await executeCommandByName('trace', coin, chatId)
      const prefacedReply = prependBriefingHealthIntro(
        reply,
        formatBriefingHealthFollowupIntro('trace', { coin }),
      )
      await sendMarkdownReply(prefacedReply, fetchFn)
      if (briefingSource != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingSource.messageId,
          briefingSource.kind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('briefing_operator_position:')) {
    const positionId = rest.slice('briefing_operator_position:'.length)
    try {
      const briefingSource = getCallbackBriefingSource(cq)
      const reply = await executeCommandByName('operator', `position ${positionId}`, chatId)
      const prefacedReply = prependBriefingHealthIntro(
        reply,
        formatBriefingHealthFollowupIntro('operator', { positionId }),
      )
      await sendMarkdownReply(prefacedReply, fetchFn)
      if (briefingSource != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingSource.messageId,
          briefingSource.kind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
    return
  }
  if (rest.startsWith('briefing_operator_coin:')) {
    const coin = rest.slice('briefing_operator_coin:'.length).trim().toUpperCase()
    try {
      const briefingSource = getCallbackBriefingSource(cq)
      const reply = await executeCommandByName('operator', coin, chatId)
      const prefacedReply = prependBriefingHealthIntro(
        reply,
        formatBriefingHealthFollowupIntro('operator', { coin }),
      )
      await sendMarkdownReply(prefacedReply, fetchFn)
      if (briefingSource != null) {
        await refreshBriefingMessage(
          config,
          chatId,
          briefingSource.messageId,
          briefingSource.kind,
          fetchFn,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('bot', `Callback c:${rest} failed: ${errMsg}`)
      await sendTelegramAlert(`Command failed\\. Check logs\\.`, fetchFn)
    }
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
    const tracePositionId = parsed.name === 'trace' ? parseTracePositionArgs(parsed.args) : null
    const replyMarkup =
      parsed.name === 'operator' && isRemoteOperatorActionArgs(parsed.args)
        ? getPendingOperatorActionReplyMarkup(msg.chat.id) ?? undefined
        : parsed.name === 'trace' && tracePositionId != null
          ? getTracePositionReplyMarkup(tracePositionId) ?? undefined
        : isMenu
          ? getMainMenuKeyboard()
          : undefined
    await sendTelegramAlert(reply, fetchFn, {
      parseMode: isMenu ? 'HTML' : 'MarkdownV2',
      ...(replyMarkup ? { replyMarkup } : {}),
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
  refreshBriefingMessage,
  getBriefingRefreshStats,
  getBriefingRefreshHealth,
  getBriefingRefreshHistory,
  getBriefingRefreshIncidents,
  resetState: () => {
    running = false
    lastUpdateId = 0
    stopDayReportScheduler()
    lastMorningReportForYmd = null
    lastEveningReportForYmd = null
    resetBriefingRefreshStats()
    briefingMessageCache.clear()
    for (const job of briefingRefreshJobs.values()) {
      clearTimeout(job.timer)
    }
    briefingRefreshJobs.clear()
  },
  getYmdInTimeZone,
  getHourMinuteInTz,
  tickDayReports,
}
