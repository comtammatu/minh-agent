import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  escapeMarkdownV2,
  sendTelegramAlert,
  formatAlert,
  formatDailySummary,
  checkTelegramConfig,
} from './telegram.js'
import type { AgentAction } from '../agent/types.js'

// ─── escapeMarkdownV2 ───────────────────────────────────────────────────────

describe('escapeMarkdownV2', () => {
  it('escapes all special characters', () => {
    const input = 'hello_world *bold* [link](url) ~strike~ `code` >quote #tag +plus -minus =eq |pipe {brace} .dot !bang'
    const result = escapeMarkdownV2(input)
    expect(result).toContain('\\_')
    expect(result).toContain('\\*')
    expect(result).toContain('\\[')
    expect(result).toContain('\\]')
    expect(result).toContain('\\(')
    expect(result).toContain('\\)')
    expect(result).toContain('\\~')
    expect(result).toContain('\\`')
    expect(result).toContain('\\>')
    expect(result).toContain('\\#')
    expect(result).toContain('\\+')
    expect(result).toContain('\\-')
    expect(result).toContain('\\=')
    expect(result).toContain('\\|')
    expect(result).toContain('\\{')
    expect(result).toContain('\\}')
    expect(result).toContain('\\.')
    expect(result).toContain('\\!')
  })

  it('returns plain text unchanged', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world')
  })

  it('handles empty string', () => {
    expect(escapeMarkdownV2('')).toBe('')
  })

  it('escapes backslashes', () => {
    expect(escapeMarkdownV2('a\\b')).toBe('a\\\\b')
  })
})

// ─── sendTelegramAlert ──────────────────────────────────────────────────────

describe('sendTelegramAlert', () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN
  const origChat = process.env.TELEGRAM_CHAT_ID

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-123'
    process.env.TELEGRAM_CHAT_ID = 'test-chat-456'
  })

  afterEach(() => {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken
    else delete process.env.TELEGRAM_BOT_TOKEN
    if (origChat !== undefined) process.env.TELEGRAM_CHAT_ID = origChat
    else delete process.env.TELEGRAM_CHAT_ID
  })

  it('sends message via fetch and returns true on success', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const result = await sendTelegramAlert('hello', mockFetch)
    expect(result).toBe(true)
    expect(capturedUrl).toContain('/bottest-token-123/sendMessage')
    expect(capturedBody.chat_id).toBe('test-chat-456')
    expect(capturedBody.text).toBe('hello')
    expect(capturedBody.parse_mode).toBe('MarkdownV2')
  })

  it('returns false and logs on HTTP error', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('Bad Request', { status: 400 })
    }

    const result = await sendTelegramAlert('hello', mockFetch)
    expect(result).toBe(false)
  })

  it('returns false and logs on network error', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error('Network failure')
    }

    const result = await sendTelegramAlert('hello', mockFetch)
    expect(result).toBe(false)
  })

  it('returns false when env vars not set', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID

    const mockFetch: typeof fetch = async () => {
      throw new Error('Should not be called')
    }

    const result = await sendTelegramAlert('hello', mockFetch)
    expect(result).toBe(false)
  })

  it('returns false when only token is set (no chat ID)', async () => {
    delete process.env.TELEGRAM_CHAT_ID

    const mockFetch: typeof fetch = async () => {
      throw new Error('Should not be called')
    }

    const result = await sendTelegramAlert('hello', mockFetch)
    expect(result).toBe(false)
  })
})

// ─── formatAlert ────────────────────────────────────────────────────────────

describe('formatAlert', () => {
  it('returns null for non-journal actions', () => {
    const action: AgentAction = { type: 'none' }
    expect(formatAlert(action)).toBeNull()
  })

  it('returns null for watch action', () => {
    const action: AgentAction = {
      type: 'watch',
      setup: {} as AgentAction extends { type: 'watch'; setup: infer S } ? S : never,
    }
    expect(formatAlert(action)).toBeNull()
  })

  // ── Signal ──

  it('formats signal alert for grade A', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'BTC',
      details: { grade: 'A', confidence: 0.85, setupId: 'BTC:1h:order-block:long' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('SETUP DETECTED')
    expect(msg).toContain('BTC')
    expect(msg).toContain('A')
    expect(msg).toContain('85')
  })

  it('formats signal alert for grade A+', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'ETH',
      details: { grade: 'A+', confidence: 0.92, setupId: 'ETH:4h:fvg:short' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('SETUP DETECTED')
    expect(msg).toContain('ETH')
    expect(msg).toContain('A\\+')
  })

  it('returns null for signal with grade B', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'SOL',
      details: { grade: 'B', confidence: 0.6, setupId: 'SOL:15m:spring:long' },
    }
    expect(formatAlert(action)).toBeNull()
  })

  it('returns null for signal with grade C', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'signal',
      coin: 'DOGE',
      details: { grade: 'C', confidence: 0.4 },
    }
    expect(formatAlert(action)).toBeNull()
  })

  // ── Enter ──

  it('formats enter alert', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'enter',
      coin: 'BTC',
      details: { fillPrice: 67500.1234, side: 'long', orderId: 'o1' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('ORDER FILLED')
    expect(msg).toContain('BTC')
    expect(msg).toContain('67500\\.1234')
    expect(msg).toContain('long')
  })

  it('formats enter alert for short side', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'enter',
      coin: 'ETH',
      details: { fillPrice: 3200, side: 'short' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('🔴')
    expect(msg).toContain('short')
  })

  // ── Exit ──

  it('formats exit alert with positive PnL', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'exit',
      coin: 'BTC',
      details: { pnl: 150.5, reason: 'tp_hit' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('POSITION CLOSED')
    expect(msg).toContain('✅')
    expect(msg).toContain('\\+150\\.50')
    expect(msg).toContain('tp\\_hit')
  })

  it('formats exit alert with negative PnL', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'exit',
      coin: 'SOL',
      details: { pnl: -42.3, reason: 'sl_hit' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('❌')
    expect(msg).toContain('\\-42\\.30')
  })

  // ── Circuit Break ──

  it('formats circuit_break alert', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'circuit_break',
      coin: '*',
      details: { reason: 'daily_loss_limit', dailyPnl: -300 },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('CIRCUIT BREAKER TRIPPED')
    expect(msg).toContain('daily\\_loss\\_limit')
    expect(msg).toContain('\\-300\\.00')
  })

  // ── Invalidate ──

  it('formats invalidate alert when position is affected', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'invalidate',
      coin: 'BTC',
      details: { reason: 'zone-broken', positionId: 'pos-123', setupId: 's1' },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg).toContain('PATTERN INVALIDATED')
    expect(msg).toContain('zone\\-broken')
    expect(msg).toContain('pos\\-123')
  })

  it('returns null for invalidate without position', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'invalidate',
      coin: 'BTC',
      details: { reason: 'zone-broken', setupId: 's1' },
    }
    expect(formatAlert(action)).toBeNull()
  })

  // ── Skip / Other ──

  it('returns null for skip events', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'skip',
      coin: 'BTC',
      details: { reason: 'Grade C below B' },
    }
    expect(formatAlert(action)).toBeNull()
  })

  it('returns null for pause events', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'pause',
      coin: 'BTC',
      details: { reason: 'manual' },
    }
    expect(formatAlert(action)).toBeNull()
  })

  it('returns null for resume events', () => {
    const action: AgentAction = {
      type: 'log_journal',
      eventType: 'resume',
      coin: 'BTC',
      details: {},
    }
    expect(formatAlert(action)).toBeNull()
  })
})

// ─── formatDailySummary ─────────────────────────────────────────────────────

describe('formatDailySummary', () => {
  it('formats positive day', () => {
    const msg = formatDailySummary({
      date: '2026-03-30',
      totalTrades: 5,
      wins: 3,
      losses: 2,
      winRate: 0.6,
      totalPnl: 250.75,
      largestWin: 180.0,
      largestLoss: -45.5,
    })
    expect(msg).toContain('DAILY SUMMARY')
    expect(msg).toContain('2026\\-03\\-30')
    expect(msg).toContain('📈')
    expect(msg).toContain('60%')
    expect(msg).toContain('3W')
    expect(msg).toContain('2L')
    expect(msg).toContain('\\+250\\.75')
  })

  it('formats negative day', () => {
    const msg = formatDailySummary({
      date: '2026-03-30',
      totalTrades: 3,
      wins: 0,
      losses: 3,
      winRate: 0,
      totalPnl: -120.0,
      largestWin: 0,
      largestLoss: -80.0,
    })
    expect(msg).toContain('📉')
    expect(msg).toContain('\\-120\\.00')
    expect(msg).toContain('0%')
  })

  it('formats zero-trade day', () => {
    const msg = formatDailySummary({
      date: '2026-03-30',
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      largestWin: 0,
      largestLoss: 0,
    })
    expect(msg).toContain('DAILY SUMMARY')
    expect(msg).toContain('0')
  })
})

// ─── checkTelegramConfig ────────────────────────────────────────────────────

describe('checkTelegramConfig', () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN
  const origChat = process.env.TELEGRAM_CHAT_ID

  afterEach(() => {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken
    else delete process.env.TELEGRAM_BOT_TOKEN
    if (origChat !== undefined) process.env.TELEGRAM_CHAT_ID = origChat
    else delete process.env.TELEGRAM_CHAT_ID
  })

  it('returns true when both env vars set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token'
    process.env.TELEGRAM_CHAT_ID = 'chat'
    expect(checkTelegramConfig()).toBe(true)
  })

  it('returns false when token missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    process.env.TELEGRAM_CHAT_ID = 'chat'
    expect(checkTelegramConfig()).toBe(false)
  })

  it('returns false when chat ID missing', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token'
    delete process.env.TELEGRAM_CHAT_ID
    expect(checkTelegramConfig()).toBe(false)
  })

  it('returns false when both missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_CHAT_ID
    expect(checkTelegramConfig()).toBe(false)
  })
})
