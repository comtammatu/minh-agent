/**
 * Telegram module — re-exports for alerts and bot.
 */

// Alerts (fire-and-forget notifications)
export {
  checkTelegramConfig,
  escapeHtml,
  escapeMarkdownV2,
  formatAlert,
  formatDailySummary,
  formatDailySummaryHtml,
  sendTelegramAlert,
} from "./alerts.js";

// Bot (command interface)
export { startBot, stopBot } from "./bot.js";

// Commands (registry)
export {
  executeCommandByName,
  findCommand,
  getCommands,
  getMainMenuKeyboard,
  registerCommand,
} from "./commands.js";

// Types
export type {
  CommandDef,
  CommandHandler,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";
