# Voice contract — Telegram Bot API

Presence **Voice** = remote organ of Minh. Not a Business-bot, Mini App, or LLM agent.

## Transport

- Long-poll `getUpdates` (`allowed_updates: message, callback_query`)
- Methods: `sendMessage`, `editMessageText`, `answerCallbackQuery`
- Inline keyboards + `callback_data` prefix `c:`
- `parse_mode=HTML`

## Auth

Whitelist `TELEGRAM_CHAT_ID` only. Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_REPORT_TZ`, `TELEGRAM_DAY_REPORTS`.

## Ports

| Port | Voice may |
|---|---|
| `QueryPort` | status, positions, pnl, advisor, traces/cases |
| `OperatorPort` | pause, resume, flatten, close, reduce (confirm-gated) |
| `CaseBus` | push Case cards, briefing digest |

Voice **must not** import `getAgent` / `OrderManager` / exchange services directly.

## UX

```text
Case Card push → Trace / Reduce / Close
Destructive → Confirm TTL → OperatorPort.execute
Ritual → morning/evening briefing
```

## Agent on Telegram

Means TradingAgent / Case Gate controlled via Voice — not Telegram Business Agents.
