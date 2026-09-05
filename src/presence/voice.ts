/**
 * Presence Voice — Telegram Bot API surface.
 */
export {
  formatAlert,
  sendTelegramAlert,
  startBot,
  stopBot,
} from "../alert/telegram/index.js";
export { createOperatorPort } from "./operator-facade.js";
export {
  formatCaseCardHtml,
  formatCaseCardText,
} from "./case-card.js";
