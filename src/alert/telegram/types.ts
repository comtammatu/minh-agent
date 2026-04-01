/**
 * Telegram Bot API types — minimal subset for getUpdates long-polling.
 *
 * Only types we actually use are defined here. Not a full Telegram Bot API binding.
 */

// ─── Telegram Bot API Response Types ───────────────────────────────────────

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramApiResponse<T> {
  ok: boolean
  result: T
  description?: string
}

// ─── Bot Command Types ─────────────────────────────────────────────────────

/** Handler function for a bot command. Returns the reply text (MarkdownV2). */
export type CommandHandler = (args: string, chatId: number) => Promise<string> | string

/** Registered command definition. */
export interface CommandDef {
  /** Command name without slash (e.g., 'help', 'status'). */
  name: string
  /** Short description for /help listing. */
  description: string
  /** Handler function. */
  handler: CommandHandler
}
