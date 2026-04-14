/**
 * Telegram module — re-exports for alerts and bot.
 */

// Alerts (fire-and-forget notifications)
export {
  sendTelegramAlert,
  escapeMarkdownV2,
  escapeHtml,
  formatAlert,
  formatDecisionTraceAlert,
  getDecisionTraceAlertFingerprint,
  shouldSendDecisionTraceAlert,
  formatDailySummary,
  formatDailySummaryHtml,
  formatScheduledBriefingHtml,
  checkTelegramConfig,
} from './alerts.js'

// Bot (command interface)
export { startBot, stopBot } from './bot.js'

// Commands (registry)
export { registerCommand, getCommands, findCommand, executeCommandByName, getMainMenuKeyboard } from './commands.js'

// Types
export type { CommandDef, CommandHandler, TelegramUpdate, TelegramMessage } from './types.js'
