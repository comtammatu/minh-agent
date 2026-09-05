# Codebase Map — Greenfield

SSOT narrative: [ARCHITECTURE.md](ARCHITECTURE.md). Features: [FEATURES.md](FEATURES.md).

## Overview

Single-process Bun: WS-first feed → store → **`minh`** → agent → ExchangePort → journal → **Presence Body (TUI) + Voice (Telegram)**.

Hubs: `src/types.ts`, `src/config.ts`, `src/app/wire.ts`, `src/presence/`, `src/strategy/orchestrator.ts`, `src/ports/`.

## Layout

| Path | Purpose |
|---|---|
| `src/app/` | Boot + `wirePorts()` |
| `src/presence/` | Body (TUI), Voice (Telegram), gate, operator facade |
| `src/ports/` + `src/adapters/` | FeedPort, ExchangePort, CrashGuardPort |
| `src/strategy/minh/` | Single strategy engine |
| `src/runtime/app.ts` | Bootstrap sequence |

## Operator surfaces

| Surface | Purpose |
|---|---|
| Ink TUI | Body — realtime monitor |
| Telegram Bot API | Voice — Case cards + confirm control |

## Highest-risk hubs

| Area | Why |
|---|---|
| `runtime/app.ts` / `app/boot.ts` | Boot order |
| `feed/store.ts` | Candle truth |
| `strategy/minh` + orchestrator | Signals |
| `agent/*` + `execution/*` | Money path |
| `ports/*` + adapters | Exchange boundaries |
