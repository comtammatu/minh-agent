import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { _test, startBot, stopBot } from './bot.js'
import { resetCommands, registerBuiltinCommands, registerCommand } from './commands.js'
import type { TelegramUpdate, TelegramApiResponse } from './types.js'

const { parseCommand, routeUpdate, getUpdates, resetState } = _test

// ─── parseCommand ──────────────────────────────────────────────────────────

describe('parseCommand', () => {
  it('parses simple command', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: '' })
  })

  it('parses command with args', () => {
    expect(parseCommand('/pause BTC 4h')).toEqual({ name: 'pause', args: 'BTC 4h' })
  })

  it('strips @BotName suffix', () => {
    expect(parseCommand('/help@MinhBot')).toEqual({ name: 'help', args: '' })
  })

  it('strips @BotName with args', () => {
    expect(parseCommand('/status@MinhBot details')).toEqual({ name: 'status', args: 'details' })
  })

  it('lowercases command name', () => {
    expect(parseCommand('/HELP')).toEqual({ name: 'help', args: '' })
  })

  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull()
  })

  it('handles leading whitespace', () => {
    expect(parseCommand('  /help')).toEqual({ name: 'help', args: '' })
  })
})

// ─── routeUpdate ───────────────────────────────────────────────────────────

describe('routeUpdate', () => {
  const chatId = 12345
  const config = { botToken: 'test-token', chatId, apiBase: 'https://api.telegram.org' }

  let sentMessages: string[]
  const mockFetch: typeof fetch = async (input, init) => {
    if (init?.body) {
      const body = JSON.parse(init.body as string)
      sentMessages.push(body.text)
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }

  beforeEach(() => {
    sentMessages = []
    resetCommands()
    registerBuiltinCommands()
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_CHAT_ID = String(chatId)
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
  })

  function makeUpdate(text: string, fromChatId: number = chatId): TelegramUpdate {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: fromChatId, type: 'private' },
        from: { id: fromChatId, is_bot: false, first_name: 'Test' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }
  }

  it('routes /help to help handler and sends reply', async () => {
    await routeUpdate(makeUpdate('/help'), config, mockFetch)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('Minh')
    expect(sentMessages[0]).toContain('/help')
  })

  it('silently drops unauthorized chat ID', async () => {
    await routeUpdate(makeUpdate('/help', 99999), config, mockFetch)
    expect(sentMessages).toHaveLength(0)
  })

  it('sends unknown command message for unregistered command', async () => {
    await routeUpdate(makeUpdate('/nonexistent'), config, mockFetch)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('Unknown command')
  })

  it('ignores updates without text', async () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
      },
    }
    await routeUpdate(update, config, mockFetch)
    expect(sentMessages).toHaveLength(0)
  })

  it('ignores non-command text', async () => {
    await routeUpdate(makeUpdate('hello world'), config, mockFetch)
    expect(sentMessages).toHaveLength(0)
  })

  it('sends error message when handler throws', async () => {
    registerCommand({
      name: 'broken',
      description: 'Always fails',
      handler: () => { throw new Error('test error') },
    })
    await routeUpdate(makeUpdate('/broken'), config, mockFetch)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]).toContain('failed')
  })
})

// ─── getUpdates ────────────────────────────────────────────────────────────

describe('getUpdates', () => {
  const config = { botToken: 'test-token', chatId: 12345, apiBase: 'https://api.telegram.org' }

  it('returns updates from API response', async () => {
    const mockUpdates: TelegramUpdate[] = [
      { update_id: 100, message: { message_id: 1, chat: { id: 12345, type: 'private' }, date: 0, text: '/help' } },
    ]
    const mockFetch: typeof fetch = async () => {
      const body: TelegramApiResponse<TelegramUpdate[]> = { ok: true, result: mockUpdates }
      return new Response(JSON.stringify(body), { status: 200 })
    }

    const result = await getUpdates(config, mockFetch)
    expect(result).toHaveLength(1)
    expect(result[0].update_id).toBe(100)
  })

  it('throws on HTTP error', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('Unauthorized', { status: 401 })
    }

    expect(getUpdates(config, mockFetch)).rejects.toThrow('getUpdates HTTP 401')
  })

  it('throws on API error', async () => {
    const mockFetch: typeof fetch = async () => {
      const body: TelegramApiResponse<TelegramUpdate[]> = { ok: false, result: [], description: 'Bad token' }
      return new Response(JSON.stringify(body), { status: 200 })
    }

    expect(getUpdates(config, mockFetch)).rejects.toThrow('Bad token')
  })
})

// ─── startBot / stopBot ────────────────────────────────────────────────────

describe('startBot / stopBot', () => {
  beforeEach(() => {
    resetState()
    resetCommands()
  })

  afterEach(() => {
    stopBot()
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
  })

  it('does nothing when env vars are missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    // Should not throw
    await startBot()
  })

  it('registers builtin commands on start', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_CHAT_ID = '12345'

    // Mock fetch that returns empty updates then blocks
    let fetchCount = 0
    const mockFetch: typeof fetch = async () => {
      fetchCount++
      if (fetchCount > 1) {
        // Stop after first poll to avoid infinite loop in test
        stopBot()
      }
      const body: TelegramApiResponse<TelegramUpdate[]> = { ok: true, result: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }

    await startBot(mockFetch)
    // Give polling loop a tick to start
    await new Promise(r => setTimeout(r, 50))
    stopBot()

    // Commands should be registered
    const { findCommand } = await import('./commands.js')
    expect(findCommand('help')).not.toBeNull()
  })
})
