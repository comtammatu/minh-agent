/**
 * Telegram Bot Commands — pure command handlers.
 *
 * Each command returns a MarkdownV2-formatted reply string.
 * No I/O here — handlers are pure functions that format responses.
 * I/O (sending messages) happens in bot.ts.
 */

import { escapeMarkdownV2 } from './alerts.js'
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

// ─── Register Built-in Commands ────────────────────────────────────────────

/** Register all built-in commands. Safe to call multiple times (idempotent). */
export function registerBuiltinCommands(): void {
  if (commands.length > 0) return
  registerCommand({
    name: 'help',
    description: 'Show this help message',
    handler: helpHandler,
  })
}
