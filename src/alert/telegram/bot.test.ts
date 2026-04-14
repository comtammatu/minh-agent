import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { _test, startBot, stopBot } from './bot.js'
import { resetCommands, registerBuiltinCommands, registerCommand, resetCloseAllState } from './commands.js'
import { getPositionMonitor } from '../../agent/position-monitor.js'
import type { TelegramUpdate, TelegramApiResponse } from './types.js'

const {
  parseCommand,
  routeUpdate,
  getUpdates,
  refreshBriefingMessage,
  getBriefingRefreshStats,
  getBriefingRefreshHealth,
  getBriefingRefreshHistory,
  getBriefingRefreshIncidents,
  resetState,
} = _test

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
  const chatId = 22345
  const config = { botToken: 'test-token', chatId, apiBase: 'https://api.telegram.org' }

  let sentBodies: Array<Record<string, unknown>>
  const mockFetch: typeof fetch = async (input, init) => {
    if (init?.body) {
      const body = JSON.parse(init.body as string)
      sentBodies.push(body)
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }

  beforeEach(() => {
    sentBodies = []
    resetState()
    resetCommands()
    registerBuiltinCommands()
    resetCloseAllState(chatId)
    const pm = getPositionMonitor()
    pm.closePositionTracking('pos-1')
    pm.openPosition({
      positionId: 'pos-1',
      coin: 'ETH',
      side: 'long',
      entryPrice: 3200.5,
      size: 0.5,
      slPrice: 3100,
      tpPrice: 3500,
      entryOrderId: 'ord-1',
      leverage: 3,
      strategyId: 'smc-sd',
    })
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_CHAT_ID = String(chatId)
  })

  afterEach(() => {
    getPositionMonitor().closePositionTracking('pos-1')
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

  function makeCallbackUpdate(
    data: string,
    fromChatId: number = chatId,
    messageText: string = 'button',
    messageId: number = 2,
  ): TelegramUpdate {
    return {
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: fromChatId, is_bot: false, first_name: 'Test' },
        data,
        message: {
          message_id: messageId,
          chat: { id: fromChatId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: messageText,
        },
      },
    }
  }

  it('routes /help to help handler and sends reply', async () => {
    await routeUpdate(makeUpdate('/help'), config, mockFetch)
    expect(sentBodies).toHaveLength(1)
    expect(String(sentBodies[0]?.text)).toContain('Minh')
    expect(String(sentBodies[0]?.text)).toContain('/help')
  })

  it('silently drops unauthorized chat ID', async () => {
    await routeUpdate(makeUpdate('/help', 99999), config, mockFetch)
    expect(sentBodies).toHaveLength(0)
  })

  it('sends unknown command message for unregistered command', async () => {
    await routeUpdate(makeUpdate('/nonexistent'), config, mockFetch)
    expect(sentBodies).toHaveLength(1)
    expect(String(sentBodies[0]?.text)).toContain('Unknown command')
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
    expect(sentBodies).toHaveLength(0)
  })

  it('ignores non-command text', async () => {
    await routeUpdate(makeUpdate('hello world'), config, mockFetch)
    expect(sentBodies).toHaveLength(0)
  })

  it('sends error message when handler throws', async () => {
    registerCommand({
      name: 'broken',
      description: 'Always fails',
      handler: () => { throw new Error('test error') },
    })
    await routeUpdate(makeUpdate('/broken'), config, mockFetch)
    expect(sentBodies).toHaveLength(1)
    expect(String(sentBodies[0]?.text)).toContain('failed')
  })

  it('attaches inline confirm buttons for remote operator actions', async () => {
    await routeUpdate(makeUpdate('/operator close pos-1'), config, mockFetch)
    expect(sentBodies).toHaveLength(1)
    expect(String(sentBodies[0]?.text)).toContain('Remote Operator Action')
    expect(sentBodies[0]?.reply_markup).toEqual({
      inline_keyboard: [[
        { text: '✅ Confirm Close ETH', callback_data: 'c:operator_confirm' },
        { text: '❌ Cancel', callback_data: 'c:operator_cancel' },
      ]],
    })
  })

  it('attaches trace action buttons for /trace position', async () => {
    await routeUpdate(makeUpdate('/trace position pos-1'), config, mockFetch)
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '➖ Reduce 25%', callback_data: 'c:trace_reduce25:pos-1' },
          { text: '➗ Reduce 50%', callback_data: 'c:trace_reduce50:pos-1' },
        ],
        [
          { text: '🛑 Close', callback_data: 'c:trace_close:pos-1' },
          { text: '🔄 Refresh', callback_data: 'c:trace_refresh:pos-1' },
        ],
      ],
    })
  })

  it('routes operator cancel callback and clears pending action', async () => {
    await routeUpdate(makeUpdate('/operator close pos-1'), config, mockFetch)
    sentBodies = []

    await routeUpdate(makeCallbackUpdate('c:operator_cancel'), config, mockFetch)
    expect(sentBodies).toHaveLength(2)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(String(sentBodies[1]?.text)).toContain('Cancelled pending operator action')
  })

  it('routes trace reduce callback into operator confirm flow', async () => {
    await routeUpdate(makeCallbackUpdate('c:trace_reduce25:pos-1'), config, mockFetch)
    expect(sentBodies).toHaveLength(2)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(String(sentBodies[1]?.text)).toContain('Remote Operator Action')
    expect(sentBodies[1]?.reply_markup).toEqual({
      inline_keyboard: [[
        { text: '✅ Confirm Reduce 25%', callback_data: 'c:operator_confirm' },
        { text: '❌ Cancel', callback_data: 'c:operator_cancel' },
      ]],
    })
  })

  it('routes briefing trace callback into focused position trace flow', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:briefing_trace_position:pos-1', chatId, 'Đầu ngày — hôm qua', 42),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(sentBodies[1]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '➖ Reduce 25%', callback_data: 'c:trace_reduce25:pos-1:b:42:morning' },
          { text: '➗ Reduce 50%', callback_data: 'c:trace_reduce50:pos-1:b:42:morning' },
        ],
        [
          { text: '🛑 Close', callback_data: 'c:trace_close:pos-1:b:42:morning' },
          { text: '🔄 Refresh', callback_data: 'c:trace_refresh:pos-1:b:42:morning' },
        ],
      ],
    })
    expect(sentBodies[2]?.message_id).toBe(42)
    expect(String(sentBodies[2]?.text)).toContain('Đầu ngày')
  })

  it('adds incident-aware trace narrative when the callback matches the active health target', async () => {
    const healthFetch: typeof fetch = async (_input, init) => {
      if (init?.body) {
        sentBodies.push(JSON.parse(init.body as string))
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    await Promise.all([
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:00Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:01Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:02Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:03Z')),
    ])

    sentBodies = []
    await routeUpdate(
      makeCallbackUpdate('c:briefing_trace_position:pos-1', chatId, 'Đầu ngày — hôm qua', 42),
      config,
      healthFetch,
    )

    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[1]?.text)).toContain('Health Trace Focus')
    expect(String(sentBodies[1]?.text)).toContain('Inspecting trace for Refresh storm around ETH / pos\\-1\\.')
  })

  it('routes briefing operator callback into focused operator audit flow', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:briefing_operator_position:pos-1', chatId, 'Đầu ngày — hôm qua', 42),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(String(sentBodies[1]?.text)).toContain('pos\\-1')
    expect(sentBodies[2]?.message_id).toBe(42)
    expect(String(sentBodies[2]?.text)).toContain('Đầu ngày')
  })

  it('adds incident-aware operator narrative when the callback matches the active health target', async () => {
    const healthFetch: typeof fetch = async (_input, init) => {
      if (init?.body) {
        sentBodies.push(JSON.parse(init.body as string))
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    await Promise.all([
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:00Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:01Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:02Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:03Z')),
    ])

    sentBodies = []
    await routeUpdate(
      makeCallbackUpdate('c:briefing_operator_position:pos-1', chatId, 'Đầu ngày — hôm qua', 42),
      config,
      healthFetch,
    )

    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[1]?.text)).toContain('Health Operator Focus')
    expect(String(sentBodies[1]?.text)).toContain('Checking operator path for Refresh storm around ETH / pos\\-1\\.')
  })

  it('refreshes the source briefing after a briefing coin trace callback', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:briefing_trace_coin:BTC', chatId, 'Cuối ngày — hôm nay', 55),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    const traceText = String(sentBodies[1]?.text)
    expect(
      traceText.includes('No decision trace found') || traceText.includes('Decision Trace'),
    ).toBe(true)
    expect(traceText).toContain('Target: BTC.')
    expect(sentBodies[2]?.message_id).toBe(55)
    expect(String(sentBodies[2]?.text)).toContain('Cuối ngày')
  })

  it('refreshes the source briefing after a briefing operator coin callback', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:briefing_operator_coin:BTC', chatId, 'Live Briefing', 66),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(String(sentBodies[1]?.text)).toContain('No operator audit entries found for BTC')
    expect(String(sentBodies[1]?.text)).toContain('Target: BTC.')
    expect(sentBodies[2]?.message_id).toBe(66)
    expect(String(sentBodies[2]?.text)).toContain('Live Briefing')
  })

  it('refreshes a scheduled briefing message in place with updated markup', async () => {
    await refreshBriefingMessage(
      config,
      chatId,
      42,
      'morning',
      mockFetch,
      new Date('2026-04-14T00:01:00Z'),
    )
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]?.message_id).toBe(42)
    expect(String(sentBodies[0]?.text)).toContain('Đầu ngày')
    expect(sentBodies[0]?.reply_markup).toBeDefined()
    expect((sentBodies[0]?.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]?.[0]?.text).toBe('🧠 Trace')
    expect(getBriefingRefreshStats()).toMatchObject({
      requested: 1,
      edited: 1,
      skippedIdentical: 0,
      coalesced: 0,
      failed: 0,
      lastOutcome: 'edited',
      lastKind: 'morning',
      lastKey: `${chatId}:42`,
    })
    expect(getBriefingRefreshHealth()).toMatchObject({
      lastCoin: 'ETH',
      lastPositionId: 'pos-1',
      lastTarget: 'ETH / pos-1',
      recoveredFrom: null,
    })
  })

  it('coalesces repeated briefing refreshes for the same message into one edit', async () => {
    await Promise.all([
      refreshBriefingMessage(
        config,
        chatId,
        42,
        'morning',
        mockFetch,
        new Date('2026-04-14T00:01:00Z'),
      ),
      refreshBriefingMessage(
        config,
        chatId,
        42,
        'morning',
        mockFetch,
        new Date('2026-04-14T00:01:01Z'),
      ),
    ])
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]?.message_id).toBe(42)
    expect(String(sentBodies[0]?.text)).toContain('Đầu ngày')
    expect(getBriefingRefreshStats()).toMatchObject({
      requested: 2,
      edited: 1,
      coalesced: 1,
      skippedIdentical: 0,
      failed: 0,
    })
  })

  it('skips briefing edit when payload is unchanged from the last refresh', async () => {
    await refreshBriefingMessage(
      config,
      chatId,
      42,
      'morning',
      mockFetch,
      new Date('2026-04-14T00:01:00Z'),
    )
    expect(sentBodies).toHaveLength(1)

    sentBodies = []
    await refreshBriefingMessage(
      config,
      chatId,
      42,
      'morning',
      mockFetch,
      new Date('2026-04-14T00:01:00Z'),
    )
    expect(sentBodies).toHaveLength(0)
    expect(getBriefingRefreshStats()).toMatchObject({
      requested: 2,
      edited: 1,
      skippedIdentical: 1,
      coalesced: 0,
      failed: 0,
      lastOutcome: 'skipped_identical',
      lastKind: 'morning',
      lastKey: `${chatId}:42`,
    })
  })

  it('announces degraded briefing health when coalesced refreshes dominate the window', async () => {
    const healthFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        sentBodies.push(JSON.parse(init.body as string))
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    await Promise.all([
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:00Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:01Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:02Z')),
      refreshBriefingMessage(config, chatId, 500, 'morning', healthFetch, new Date('2026-04-14T00:01:03Z')),
    ])

    const healthAlerts = sentBodies.filter(body => String(body.text).startsWith('<b>Briefing health'))
    expect(healthAlerts).toHaveLength(1)
    expect(String(healthAlerts[0]?.text)).toContain('Briefing health degraded')
    expect(String(healthAlerts[0]?.text)).toContain('coalesced')
    expect(String(healthAlerts[0]?.text)).toContain('Target:')
    expect(getBriefingRefreshHealth()).toMatchObject({
      state: 'degraded',
      failed: 0,
      coalesced: 3,
      lastCoin: 'ETH',
      lastPositionId: 'pos-1',
      lastTarget: 'ETH / pos-1',
      recoveredFrom: null,
    })
    expect(getBriefingRefreshHistory(1)).toMatchObject([
      { from: 'healthy', to: 'degraded', target: 'ETH / pos-1' },
    ])
    expect(getBriefingRefreshIncidents(1)).toMatchObject([
      { peakState: 'degraded', status: 'active', target: 'ETH / pos-1' },
    ])

    sentBodies = []
    await refreshBriefingMessage(
      config,
      chatId,
      501,
      'morning',
      healthFetch,
      new Date('2026-04-14T00:01:04Z'),
    )
    const prioritizedEdit = sentBodies.find(body => Number(body.message_id) === 501)
    expect((prioritizedEdit?.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]?.[0]?.text)
      .toBe('⚠️ Inspect Health Trace')
    expect((prioritizedEdit?.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]?.[1]?.text)
      .toBe('🧾 Check Operator')
    expect(String(prioritizedEdit?.text)).toContain('Refresh storm around ETH / pos-1')
    expect(String(prioritizedEdit?.text)).toContain('Open Health Trace first, then use Health Operator only if the case still needs manual intervention.')

  })

  it('announces critical briefing health after repeated coalesced anomalies and recovers back to healthy', async () => {
    const healthFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        sentBodies.push(JSON.parse(init.body as string))
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    await Promise.all([
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:00Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:01Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:02Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:03Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:04Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:05Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:06Z')),
      refreshBriefingMessage(config, chatId, 600, 'morning', healthFetch, new Date('2026-04-14T00:02:07Z')),
    ])

    let healthAlerts = sentBodies.filter(body => String(body.text).startsWith('<b>Briefing health'))
    expect(healthAlerts).toHaveLength(2)
    expect(String(healthAlerts[0]?.text)).toContain('Briefing health degraded')
    expect(String(healthAlerts[1]?.text)).toContain('Briefing health critical')
    expect(getBriefingRefreshHealth()).toMatchObject({
      state: 'critical',
      coalesced: 7,
    })

    sentBodies = []

    for (const [index, messageId] of [605, 606, 607, 608].entries()) {
      await refreshBriefingMessage(
        config,
        chatId,
        messageId,
        'morning',
        healthFetch,
        new Date(`2026-04-14T00:03:0${index}Z`),
      )
    }

    healthAlerts = sentBodies.filter(body => String(body.text).startsWith('<b>Briefing health'))
    expect(healthAlerts).toHaveLength(1)
    expect(String(healthAlerts[0]?.text)).toContain('Briefing health recovered')
    expect(String(healthAlerts[0]?.text)).toContain('Recovered: ETH / pos-1')
    expect(getBriefingRefreshHealth()).toMatchObject({
      state: 'healthy',
      requested: 12,
      edited: 5,
      coalesced: 7,
      samples: 8,
      lastCoin: 'ETH',
      lastPositionId: 'pos-1',
      lastTarget: 'ETH / pos-1',
      recoveredFrom: 'degraded',
      recoveredCoin: 'ETH',
      recoveredPositionId: 'pos-1',
      recoveredTarget: 'ETH / pos-1',
    })
    expect(getBriefingRefreshHistory(3)).toMatchObject([
      { from: 'degraded', to: 'healthy', target: 'ETH / pos-1' },
      { from: 'critical', to: 'degraded', target: 'ETH / pos-1' },
      { from: 'degraded', to: 'critical' },
    ])
    expect(getBriefingRefreshIncidents(1)).toMatchObject([
      { peakState: 'critical', status: 'recovered', target: 'ETH / pos-1' },
    ])
  })

  it('routes briefing refresh callback into edit-message recap refresh', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:briefing_refresh:morning', chatId, 'Đầu ngày — hôm qua', 42),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(2)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(sentBodies[1]?.message_id).toBe(42)
    expect(String(sentBodies[1]?.text)).toContain('Đầu ngày')
    expect(sentBodies[1]?.reply_markup).toBeDefined()
  })

  it('refreshes the source briefing after a briefing-origin trace refresh callback', async () => {
    await routeUpdate(
      makeCallbackUpdate('c:trace_refresh:pos-1:b:42:morning', chatId, 'Position trace', 77),
      config,
      mockFetch,
    )
    expect(sentBodies).toHaveLength(3)
    expect(String(sentBodies[0]?.callback_query_id)).toContain('cb-1')
    expect(String(sentBodies[1]?.text)).toContain('No decision trace found for position pos\\-1')
    expect(sentBodies[1]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '➖ Reduce 25%', callback_data: 'c:trace_reduce25:pos-1:b:42:morning' },
          { text: '➗ Reduce 50%', callback_data: 'c:trace_reduce50:pos-1:b:42:morning' },
        ],
        [
          { text: '🛑 Close', callback_data: 'c:trace_close:pos-1:b:42:morning' },
          { text: '🔄 Refresh', callback_data: 'c:trace_refresh:pos-1:b:42:morning' },
        ],
      ],
    })
    expect(sentBodies[2]?.message_id).toBe(42)
    expect(String(sentBodies[2]?.text)).toContain('Đầu ngày')
    expect(sentBodies[2]?.reply_markup).toBeDefined()
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
