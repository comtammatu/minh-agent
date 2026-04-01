/**
 * Telegram Bot Commands — command handlers.
 *
 * Each command returns a MarkdownV2-formatted reply string.
 * I/O (sending messages) happens in bot.ts.
 *
 * /help     — built-in, pure
 * /status   — reads agent snapshot + health report
 * /positions — reads position monitor
 * /pnl      — reads live metrics (async, hits DB)
 * /pause    — mutates agent state (pauseAll)
 * /resume   — mutates agent state (resumeAll)
 */

import { escapeMarkdownV2 } from './alerts.js'
import { getAgent } from '../../agent/trading-agent.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import { getHealthMonitor } from '../../agent/self-healing.js'
import { getLiveMetrics } from '../../analytics/metrics-service.js'
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

function pauseHandler(args: string): string {
  const esc = escapeMarkdownV2
  try {
    const reason = args.trim() || 'manual via Telegram'
    getAgent().pauseAll(reason)
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

// ─── Register Built-in Commands ────────────────────────────────────────────

/** Register all built-in commands. Safe to call multiple times (idempotent). */
export function registerBuiltinCommands(): void {
  if (commands.length > 0) return
  registerCommand({ name: 'help', description: 'Show this help message', handler: helpHandler })
  registerCommand({ name: 'status', description: 'Agent state, health, uptime', handler: statusHandler })
  registerCommand({ name: 'positions', description: 'Open positions list', handler: positionsHandler })
  registerCommand({ name: 'pnl', description: 'PnL summary (daily/weekly/monthly)', handler: pnlHandler })
  registerCommand({ name: 'pause', description: 'Pause agent (optional reason)', handler: pauseHandler })
  registerCommand({ name: 'resume', description: 'Resume agent', handler: resumeHandler })
}
