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
 * /confirm   — confirm pending /closeall
 */

import { escapeMarkdownV2 } from './alerts.js'
import { getAgent } from '../../agent/trading-agent.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import { getHealthMonitor } from '../../agent/self-healing.js'
import { getLiveMetrics } from '../../analytics/metrics-service.js'
import { closeAllPositions } from '../../agent/close-all.js'
import { TELEGRAM_BOT } from '../../config.js'
import type { CommandDef } from './types.js'

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

    return [
      `*Status*`,
      `Agent: ${paused}`,
      `Health: ${esc(health.overall)}`,
      `Uptime: ${esc(`${uptimeH}h ${uptimeM}m`)}`,
      `Daily PnL: ${esc(snap.global.dailyPnl.toFixed(2))} USDC`,
      `Positions: ${esc(String(posCount))}`,
      `Coins: ${esc(String(coinStates.length))} \\(${esc(String(watching))} watching, ${esc(String(inPos))} in\\-position\\)`,
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

  const coin = parts[0].toUpperCase()
  const durationStr = parts[1].toLowerCase()
  const match = durationStr.match(/^(\d+)(m|h|d)$/)
  if (!match) return null

  const value = parseInt(match[1], 10)
  if (value <= 0 || isNaN(value)) return null

  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  const durationMs = value * multipliers[match[2]]
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

// ─── /closeall state machine ─────────────────────────────────────────────

interface CloseAllState {
  chatId: number
  requestedAt: number
}

/** Pending /closeall confirmation. null = IDLE state. */
let pendingCloseAll: CloseAllState | null = null

/** Expose for testing. */
export function getPendingCloseAll(): CloseAllState | null {
  return pendingCloseAll
}

/** Reset state (for testing). */
export function resetCloseAllState(): void {
  pendingCloseAll = null
}

function closeallHandler(_args: string, chatId: number): string {
  const esc = escapeMarkdownV2
  const timeoutSec = TELEGRAM_BOT.closeallConfirmTimeoutSec

  if (pendingCloseAll) {
    const elapsed = (Date.now() - pendingCloseAll.requestedAt) / 1000
    if (elapsed < timeoutSec) {
      return `A /closeall is already pending\\. Send /confirm within ${esc(String(Math.ceil(timeoutSec - elapsed)))}s\\.`
    }
    // Expired — allow new request
    pendingCloseAll = null
  }

  pendingCloseAll = { chatId, requestedAt: Date.now() }

  // Auto-cancel after timeout
  setTimeout(() => {
    if (pendingCloseAll && Date.now() - pendingCloseAll.requestedAt >= timeoutSec * 1000) {
      pendingCloseAll = null
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
  const timeoutSec = TELEGRAM_BOT.closeallConfirmTimeoutSec

  if (!pendingCloseAll) {
    return `No pending /closeall to confirm\\.`
  }

  // Check same chat ID
  if (pendingCloseAll.chatId !== chatId) {
    return `No pending /closeall to confirm\\.`
  }

  // Check timeout
  const elapsed = (Date.now() - pendingCloseAll.requestedAt) / 1000
  if (elapsed >= timeoutSec) {
    pendingCloseAll = null
    return `Confirmation expired\\. Send /closeall again\\.`
  }

  // Execute
  pendingCloseAll = null
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

// ─── Register Built-in Commands ────────────────────────────────────────────

/** Register all built-in commands. Safe to call multiple times (idempotent). */
export function registerBuiltinCommands(): void {
  if (commands.length > 0) return
  registerCommand({ name: 'help', description: 'Show this help message', handler: helpHandler })
  registerCommand({ name: 'status', description: 'Agent state, health, uptime', handler: statusHandler })
  registerCommand({ name: 'positions', description: 'Open positions list', handler: positionsHandler })
  registerCommand({ name: 'pnl', description: 'PnL summary (daily/weekly/monthly)', handler: pnlHandler })
  registerCommand({ name: 'pause', description: 'Pause agent or coin (/pause BTC 4h)', handler: pauseHandler })
  registerCommand({ name: 'resume', description: 'Resume agent', handler: resumeHandler })
  registerCommand({ name: 'risk', description: 'Risk dashboard (PnL, CB, losses)', handler: riskHandler })
  registerCommand({ name: 'closeall', description: 'Emergency close all (requires /confirm)', handler: closeallHandler })
  registerCommand({ name: 'confirm', description: 'Confirm pending /closeall', handler: confirmHandler })
}
