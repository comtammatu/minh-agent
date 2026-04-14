import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  escapeMarkdownV2,
  escapeHtml,
  sendTelegramAlert,
  formatAlert,
  formatDecisionTraceAlert,
  getDecisionTraceAlertFingerprint,
  formatDailySummary,
  formatScheduledBriefingHtml,
  checkTelegramConfig,
  shouldSendDecisionTraceAlert,
} from './alerts.js'
import type { AgentAction } from '../../agent/types.js'
import type { DecisionTrace } from '../../types.js'

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

  it('sends HTML when parseMode HTML is set', async () => {
    let capturedBody: Record<string, unknown> = {}
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    await sendTelegramAlert('<b>Hi</b>', mockFetch, { parseMode: 'HTML' })
    expect(capturedBody.parse_mode).toBe('HTML')
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

// ─── escapeHtml ─────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersand and angle brackets', () => {
    expect(escapeHtml('a & b <tag>')).toBe('a &amp; b &lt;tag&gt;')
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
      details: {
        grade: 'A',
        confidence: 0.85,
        setupId: 'BTC:1h:order-block:long',
        side: 'long',
        interval: '1h',
        entryPrice: 100_000,
        slPrice: 99_000,
        tpPrice: 103_000,
        pattern: 'pin_bar',
      },
    }
    const msg = formatAlert(action)
    expect(msg).not.toBeNull()
    expect(msg!.parseMode).toBe('HTML')
    expect(msg!.text).toContain('SETUP DETECTED')
    expect(msg!.text).toContain('BTC')
    expect(msg!.text).toContain('A')
    expect(msg!.text).toContain('85')
    expect(msg!.text).toContain('LONG')
    expect(msg!.text).toContain('1h')
    expect(msg!.text).toContain('pin_bar')
    expect(msg!.text).toContain('100000.00')
    expect(msg!.text).toContain('99000.00')
    expect(msg!.text).toContain('103000.00')
    expect(msg!.text).toContain('R:R')
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
    expect(msg!.text).toContain('SETUP DETECTED')
    expect(msg!.text).toContain('ETH')
    expect(msg!.text).toContain('A+')
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
    expect(msg!.text).toContain('POSITION OPEN')
    expect(msg!.text).toContain('BTC')
    expect(msg!.text).toContain('67500.1234')
    expect(msg!.text).toContain('long')
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
    expect(msg!.text).toContain('🔴')
    expect(msg!.text).toContain('short')
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
    expect(msg!.text).toContain('POSITION CLOSED')
    expect(msg!.text).toContain('✅')
    expect(msg!.text).toContain('+150.50')
    expect(msg!.text).toContain('tp_hit')
    expect(msg!.text).toContain('Balance')
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
    expect(msg!.text).toContain('❌')
    expect(msg!.text).toContain('-42.30')
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
    expect(msg!.text).toContain('CIRCUIT BREAKER TRIPPED')
    expect(msg!.text).toContain('daily_loss_limit')
    expect(msg!.text).toContain('-300.00')
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
    expect(msg!.text).toContain('PATTERN INVALIDATED')
    expect(msg!.text).toContain('zone-broken')
    expect(msg!.text).toContain('pos-123')
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

describe('formatDecisionTraceAlert', () => {
  function makeTrace(): DecisionTrace {
    return {
      traceId: 'smc-sd:BTC|1h|setup|1710',
      coin: 'BTC',
      interval: '1h',
      strategyId: 'smc-sd',
      exchange: 'HL',
      ts: 1_710_000_000_000,
      regime: {
        state: 'BULL',
        confidence: 0.74,
        modifier: 1,
      },
      roles: {
        bull: {
          role: 'Bull Analyst',
          stance: 'bullish',
          confidence: 0.78,
          summary: 'Bullish structure is aligned.',
          evidence: ['BOS', 'CHoCH'],
        },
        bear: {
          role: 'Bear Analyst',
          stance: 'bearish',
          confidence: 0.15,
          summary: 'Bear case is weaker here.',
          evidence: ['No breakdown'],
        },
        risk: {
          role: 'Risk Manager',
          stance: 'neutral',
          confidence: 0.7,
          summary: 'Risk is acceptable if execution stays clean.',
          evidence: ['R:R 1:2.00'],
        },
        judge: {
          role: 'judge',
          verdict: 'approve',
          confidence: 0.74,
          summary: 'Setup is approved for watch/execution.',
          reasonsFor: ['Confluence A'],
          reasonsAgainst: ['Execution pending'],
        },
      },
      timeline: [
        {
          ts: 1_710_000_000_000,
          actor: 'judge',
          action: 'approve',
          summary: 'Setup is approved for watch/execution.',
        },
      ],
      outcome: {
        action: 'watch',
        confidence: 0.74,
        summary: 'Setup is approved for watch/execution.',
        setupId: 'smc-sd:BTC|1h|smc-sd',
      },
    }
  }

  it('formats a decision trace as HTML', () => {
    const msg = formatDecisionTraceAlert(makeTrace())
    expect(msg).not.toBeNull()
    expect(msg?.parseMode).toBe('HTML')
    expect(msg?.text).toContain('DELIBERATION')
    expect(msg?.text).toContain('BTC')
    expect(msg?.text).toContain('APPROVE')
    expect(msg?.text).toContain('WATCH')
    expect(msg?.text).toContain('Recent')
    expect(msg?.text).toContain('Judge:')
  })

  it('returns null when judge card is missing', () => {
    const trace = makeTrace()
    delete trace.roles.judge
    expect(formatDecisionTraceAlert(trace)).toBeNull()
  })

  it('formats guardian updates with timeline context', () => {
    const trace = makeTrace()
    trace.roles.guardian = {
      role: 'guardian',
      state: 'trail_sl',
      summary: 'Guardian moved stop to 4200.00.',
      actions: ['trail_sl:4200.00'],
    }
    trace.timeline.push({
      ts: 1_710_000_100_000,
      actor: 'guardian',
      action: 'trail_sl',
      summary: 'Guardian moved stop to 4200.00.',
    })
    trace.outcome.action = 'trail_sl'
    trace.outcome.positionId = 'pos-1'
    trace.outcome.summary = 'Stop updated to 4200.00.'

    const msg = formatDecisionTraceAlert(trace)
    expect(msg?.text).toContain('GUARDIAN UPDATE')
    expect(msg?.text).toContain('Position: <code>pos-1</code>')
    expect(msg?.text).toContain('Guardian moved stop to 4200.00.')
  })
})

describe('decision trace alert gating', () => {
  function makeTrace(): DecisionTrace {
    return {
      traceId: 'smc-sd:BTC|1h|setup|1710',
      coin: 'BTC',
      interval: '1h',
      strategyId: 'smc-sd',
      exchange: 'HL',
      ts: 1_710_000_000_000,
      regime: {
        state: 'BULL',
        confidence: 0.74,
        modifier: 1,
      },
      roles: {
        judge: {
          role: 'judge',
          verdict: 'approve',
          confidence: 0.74,
          summary: 'Setup is approved for watch/execution.',
          reasonsFor: ['Confluence A'],
          reasonsAgainst: ['Execution pending'],
        },
      },
      timeline: [
        {
          ts: 1_710_000_000_000,
          actor: 'judge',
          action: 'approve',
          summary: 'Setup is approved for watch/execution.',
        },
      ],
      outcome: {
        action: 'watch',
        confidence: 0.74,
        summary: 'Setup is approved for watch/execution.',
        setupId: 'smc-sd:BTC|1h|smc-sd',
      },
    }
  }

  it('sends approved deliberation alerts once per setup fingerprint', () => {
    const trace = makeTrace()
    expect(shouldSendDecisionTraceAlert(trace)).toBe(true)
    expect(getDecisionTraceAlertFingerprint(trace)).toBe('deliberation:smc-sd:BTC|1h|smc-sd')
  })

  it('suppresses non-approved watch traces', () => {
    const trace = makeTrace()
    trace.roles.judge = {
      ...trace.roles.judge!,
      verdict: 'watch',
    }
    expect(shouldSendDecisionTraceAlert(trace)).toBe(false)
    expect(getDecisionTraceAlertFingerprint(trace)).toBeNull()
  })

  it('sends guardian updates with summary-sensitive fingerprint', () => {
    const trace = makeTrace()
    trace.roles.guardian = {
      role: 'guardian',
      state: 'partial_tp',
      summary: 'Guardian scaled out 50% of the position.',
      actions: ['partial_close:50%'],
    }
    trace.timeline.push({
      ts: 1_710_000_200_000,
      actor: 'guardian',
      action: 'partial_close',
      summary: 'Guardian scaled out 50% of the position.',
    })
    trace.outcome.action = 'partial_close'
    trace.outcome.positionId = 'pos-1'
    trace.outcome.summary = 'Scaled out 50% of the position.'

    expect(shouldSendDecisionTraceAlert(trace)).toBe(true)
    expect(getDecisionTraceAlertFingerprint(trace)).toBe(
      'guardian:partial_close:pos-1:Guardian scaled out 50% of the position.',
    )
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

describe('formatScheduledBriefingHtml', () => {
  it('adds needs-action wording when the incident is still active', () => {
    const html = formatScheduledBriefingHtml('Live Briefing', {
      date: '2026-04-14',
      totalTrades: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      totalPnl: 25,
      largestWin: 40,
      largestLoss: -15,
    }, {
      openPositions: 1,
      incident: {
        peakState: 'CRITICAL',
        status: 'ACTIVE',
        target: 'ETH / pos-1',
        cause: 'Refresh storm around ETH / pos-1',
        recommendedAction: 'Open Health Trace first, then use Health Operator only if the case still needs manual intervention.',
      },
    })

    expect(html).toContain('Open positions: <b>1</b>')
    expect(html).toContain('Immediate action: <b>Refresh storm around ETH / pos-1</b> Open Health Trace first, then use Health Operator only if the case still needs manual intervention.')
    expect(html).toContain('Incident: <b>CRITICAL ACTIVE</b> — ETH / pos-1')
  })

  it('renders operator and live oversight sections for scheduled reports', () => {
    const html = formatScheduledBriefingHtml('Đầu ngày — hôm qua', {
      date: '2026-04-14',
      totalTrades: 4,
      wins: 3,
      losses: 1,
      winRate: 0.75,
      totalPnl: 180.25,
      largestWin: 120,
      largestLoss: -35,
      entryCount: 18,
    }, {
      openPositions: 2,
      attention: {
        level: 'ACTIVE',
        summary: 'BTC 1h — Guardian scaled out 50% of the position.',
      },
      incident: {
        peakState: 'CRITICAL',
        status: 'RECOVERED',
        target: 'BTC / pos-1',
      },
      liveBuckets: [
        {
          label: 'Guardian Active',
          count: 1,
          items: [{ coin: 'ETH', interval: '15m', action: 'HOLD' }],
        },
        {
          label: 'Watching',
          count: 1,
          items: [{ coin: 'SOL', interval: '5m', action: 'WATCH' }],
        },
      ],
      operatorRecent: {
        totalActions: 3,
        submitted: 2,
        failed: 1,
        items: [
          { action: 'reduce 25%', target: 'BTC', source: 'TELEGRAM', at: '09:15:10' },
          { action: 'close', target: 'ETH', source: 'TUI', at: '09:18:44' },
        ],
      },
      liveOversight: [
        { coin: 'BTC', interval: '1h', action: 'TRAIL_SL', guardian: 'TRAIL SL', executor: 'FILLED' },
      ],
    })

    expect(html).toContain('Đầu ngày — hôm qua')
    expect(html).toContain('Open positions: <b>2</b>')
    expect(html).toContain('ACTIVE: <b>BTC 1h — Guardian scaled out 50% of the position.</b>')
    expect(html).toContain('Incident: <b>CRITICAL RECOVERED</b> — BTC / pos-1')
    expect(html).toContain('<b>Operator Recent</b>')
    expect(html).toContain('3 actions | 2 submitted | 1 failed')
    expect(html).toContain('reduce 25%')
    expect(html).toContain('<b>Case Buckets</b>')
    expect(html).toContain('<b>Guardian Active</b> (1): ETH 15m HOLD')
    expect(html).toContain('<b>Watching</b> (1): SOL 5m WATCH')
    expect(html).toContain('<b>Live Oversight</b>')
    expect(html).toContain('<b>BTC</b> 1h | TRAIL_SL | G TRAIL SL | E FILLED')
  })

  it('omits optional sections when there is no operator or live context', () => {
    const html = formatScheduledBriefingHtml('Cuối ngày — hôm nay', {
      date: '2026-04-14',
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      largestWin: 0,
      largestLoss: 0,
    }, {
      openPositions: 0,
    })

    expect(html).toContain('Open positions: <b>0</b>')
    expect(html).not.toContain('ACTIVE:')
    expect(html).not.toContain('Operator Recent')
    expect(html).not.toContain('Case Buckets')
    expect(html).not.toContain('Live Oversight')
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
