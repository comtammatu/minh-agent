# 07 — API Contracts

> **TARGET / ASPIRATIONAL (2026-06 note):** This document describes the planned `/api/v1` + JWT auth + WS + owner/viewer model (multi-panel workspace vision in DESIGN 05/06). 
> **Current implementation:** `src/server/` uses `Bun.serve` with unauthenticated `/api/dashboard/*` and `/api/operator/{flatten,pause,resume}` (polling reads + hold-to-confirm writes with `{ confirm: true }`; no JWT, no WS, no v1 prefix). See `src/server/handlers.ts`, `operator-actions.ts`, `contracts.ts`, and task-contract open decision Q1.
> Do not edit code to match this doc until owner decision + follow-on plan. If implementing, update DESIGN status table + this header in same PR.
> For now, this is the contract *to evolve toward*.

HTTP and WebSocket interface between the dashboard (browser) and the trading runtime (Bun process). Auth flow, endpoint shapes, message contracts.

The HTTP server is in `src/server/`. It exists ONLY to serve the dashboard and accept operator commands. It is not the primary input to the system (the primary inputs are exchange feeds and Telegram).

---

## Versioning

- All endpoints under `/api/v1/...`.
- All WS messages carry a `version: 1` field.
- Breaking changes bump to `v2`, with `v1` kept alongside for one minor release.

---

## Auth model

Two roles: **owner** and **viewer**. Both authenticated via JWT in `HttpOnly Secure SameSite=Strict` cookies.

### Token shapes

```ts
interface OwnerToken {
  v: 1
  sub: 'owner'
  iat: number   // issued-at, unix seconds
  exp: number   // expiry, owner = 30 days
}

interface ViewerToken {
  v: 1
  sub: 'viewer'
  vid: string   // viewer ID (uuid), so individual tokens can be revoked
  label: string // human label like "partner-2026"
  iat: number
  exp: number   // viewer = 7 days default, configurable
}
```

Signing: HS256 with secret from `JWT_SECRET` env var. Secret MUST be ≥ 32 bytes. On startup, abort if missing or shorter.

### Owner flow

1. Owner navigates to `https://dashboard/login`.
2. Page prompts for the **owner secret** (single string from `OWNER_SECRET` env var, never persisted in DB).
3. POST `/api/v1/auth/owner` with `{ secret }`.
4. On match: server sets `auth=<owner-jwt>` cookie. 30-day expiry.
5. Subsequent requests carry the cookie automatically.
6. Logout: DELETE `/api/v1/auth/session` clears the cookie.

There is **no password DB**, **no email verification**, **no OAuth provider**. One owner per process, configured via env.

### Viewer flow

1. Owner generates a viewer token via `POST /api/v1/admin/viewer-tokens` (owner-only).
   - Server signs a viewer JWT, stores `(vid, label, created_at, last_used_at)` in a small `viewer_tokens` table.
   - Server returns `{ token: '<jwt>', url: 'https://dashboard/?vt=<jwt>' }`.
2. Owner shares the URL with the viewer (out of band — Telegram, Signal, etc.).
3. Viewer opens the URL.
4. Page detects `?vt=` query param, POSTs to `/api/v1/auth/viewer-claim` with the token.
5. Server validates the JWT, checks `vid` against `viewer_tokens` (not revoked), sets `auth=<viewer-jwt>` cookie.
6. Page strips `?vt=` from URL and reloads cleanly.
7. Viewer is in viewer mode (see [05-ui-layout.md](05-ui-layout.md#viewer-mode-rules)).

Revocation: owner can DELETE `/api/v1/admin/viewer-tokens/{vid}` to invalidate immediately. Server checks `viewer_tokens` on every viewer request — JWT validity alone is not enough.

### Authorization matrix

| Endpoint group | Owner | Viewer |
|---|---|---|
| `GET /api/v1/auth/me` | ✅ | ✅ |
| `POST /api/v1/auth/owner` | ✅ (unauth) | ❌ |
| `POST /api/v1/auth/viewer-claim` | n/a | ✅ (unauth-to-auth) |
| `DELETE /api/v1/auth/session` | ✅ | ✅ |
| `GET /api/v1/...` (reads) | ✅ | ✅ |
| `POST/PUT/DELETE /api/v1/...` (writes) | ✅ | ❌ |
| `GET /api/v1/admin/...` | ✅ | ❌ |
| WS `subscribe:public` | ✅ | ✅ |
| WS `subscribe:private` | ✅ | ✅ |
| WS `command:*` | ✅ | ❌ |

Server-side: every write endpoint and every WS command checks `role === 'owner'`. Viewer messages on write endpoints return `403`. Viewer WS commands return `error: forbidden`.

---

## HTTP endpoints

All bodies are JSON. All errors return:

```json
{ "error": { "code": "STRING_CODE", "message": "human readable" } }
```

with HTTP status reflecting the class (`400` validation, `401` unauth, `403` forbidden, `404` not found, `409` conflict, `429` rate-limited, `500` server).

### Auth

```
GET    /api/v1/auth/me                 → { role, vid?, label?, exp }
POST   /api/v1/auth/owner              → sets cookie
POST   /api/v1/auth/viewer-claim       → sets cookie
DELETE /api/v1/auth/session            → clears cookie
```

### Precision metadata (cached at dashboard mount)

```
GET /api/v1/precision                  → { [coin]: PrecisionMeta }
```

See `PrecisionMeta` shape in [04-component-patterns.md](04-component-patterns.md#numbers). Refresh on dashboard mount and every 1h. Server-side: refresh from exchange metadata daily, serve from in-memory cache.

### Market data (reads)

```
GET /api/v1/coins                                  → { coins: [{ coin, exchange, rank }] }
GET /api/v1/candles?coin=BTC&interval=15m&limit=500 → { candles: [{ t, o, h, l, c, v }] }
GET /api/v1/orderbook?coin=BTC&depth=20            → { bids, asks, ts }
GET /api/v1/asset-ctx?coin=BTC                     → { funding, openInterest, premium, dayNtlVlm }
```

### Trading state (reads)

```
GET /api/v1/positions?status=open               → { positions: [...] }
GET /api/v1/orders?status=active                → { orders: [...] }
GET /api/v1/setups?status=pending|approved|all  → { setups: [...] }
GET /api/v1/journal?limit=100&event_type=...    → { entries: [...] }
GET /api/v1/risk                                → RiskSnapshot
GET /api/v1/performance/daily?days=30           → { rows: [...] }
GET /api/v1/performance/pattern?weeks=12        → { rows: [...] }
GET /api/v1/equity?days=30                      → { points: [{ ts, equity }] }
GET /api/v1/decisions?limit=200&coin=...        → { entries: [...] }
GET /api/v1/agent/status                        → { state, since, breaker, last_decision_at }
```

### Operator actions (writes — owner only)

```
POST   /api/v1/orders                  body: PlaceOrderRequest    → { order_id }
DELETE /api/v1/orders/{id}             → { cancelled: true }
DELETE /api/v1/orders                  body: { coin?: string }    → { cancelled_count }
POST   /api/v1/positions/{id}/close    body: { confirm: true }    → { closing: true }
POST   /api/v1/positions/flatten       body: { exchange?: 'HL'|'BB' } → { closing: number }
POST   /api/v1/setups/{id}/approve     → { approved: true }
POST   /api/v1/setups/{id}/reject      body: { reason: string }   → { rejected: true }
POST   /api/v1/agent/pause             body: { coin?: string, timeframe?: string } → { paused: true }
POST   /api/v1/agent/resume            → { resumed: true }
```

### Admin (owner only)

```
GET    /api/v1/admin/viewer-tokens                  → { tokens: [{ vid, label, created_at, last_used_at }] }
POST   /api/v1/admin/viewer-tokens                  body: { label, expires_in_days? }  → { token, url, vid }
DELETE /api/v1/admin/viewer-tokens/{vid}            → { revoked: true }
GET    /api/v1/admin/build                          → { version, commit, started_at, uptime_s }
GET    /api/v1/admin/config                         → { exchange, paper_mode, coins, intervals }
```

### Hold-to-confirm enforcement on server?

The 700ms hold lives on the client. The server does NOT enforce a hold — it accepts the request once submitted. **Defense in depth**: dangerous write endpoints require an explicit `{ confirm: true }` field in the body, distinguishing "I clicked the button" from "I held the button to completion". Clients without confirm:true get `400 missing_confirm`.

This protects against accidental curl/script submissions. It does not protect against deliberate ones, but the system has one trusted operator, so the threat model is operator misclick, not adversary.

---

## WebSocket protocol

Single endpoint: `wss://dashboard/ws`. JWT cookie sent automatically on connect (browser does this). Server upgrades or rejects based on auth.

### Connection lifecycle

```
client → server: WS upgrade (cookie auto-attached)
server: validates cookie, accepts or 401 + close
server → client: { type: 'welcome', version: 1, role: 'owner'|'viewer', server_time: <ms> }
client → server: { type: 'subscribe', topics: ['positions', 'orders', 'setups', 'candles:BTC:15m'] }
server → client: { type: 'snapshot', topic: 'positions', data: [...] }
server → client: { type: 'event', topic: 'positions', data: { ... } }   // streaming updates
...
client → server: { type: 'ping' }   // every 25s
server → client: { type: 'pong', server_time: <ms> }
```

### Topics

| Topic | Payload shape | Cadence |
|---|---|---|
| `candles:<coin>:<tf>` | `{ t, o, h, l, c, v }` | On each WS tick from exchange |
| `orderbook:<coin>` | `{ bids, asks, ts }` | On each book update |
| `asset-ctx:<coin>` | `{ funding, openInterest, premium }` | ~5s |
| `positions` | Position row (whole shape) | On open / update / close |
| `orders` | Order row (whole shape) | On state transition |
| `setups` | Setup row | On detect / approve / reject / invalidate |
| `agent` | `{ state, since, breaker, last_decision_at }` | On state change |
| `risk` | RiskSnapshot | On material change (PnL, CB, exposure) |
| `journal` | New entry | On each new journal write |
| `decisions` | Same as journal but filtered to decision-class events | On each |
| `system` | `{ kind: 'ws_state' | 'matview_refreshed' | 'build_info' | ... }` | As needed |

### Subscription model

- Client sends `{ type: 'subscribe', topics: [...] }`.
- Server responds with `{ type: 'snapshot', topic, data }` for each topic — the current full state.
- Then sends `{ type: 'event', topic, data }` for each subsequent change.
- Client can `{ type: 'unsubscribe', topics: [...] }`.
- Disconnect = all subscriptions cleared.

### Commands (owner only)

The dashboard MAY send commands over WS for actions that need low latency. Same auth rules — viewer cannot send. Mirror of HTTP write endpoints; both paths invoke the same agent handler.

```
client → server: { type: 'command', id: '<uuid>', cmd: 'cancel_order', args: { id, confirm: true } }
server → client: { type: 'command_result', id: '<uuid>', ok: true } | { ok: false, error: {...} }
```

**Recommended default**: use HTTP for mutations (simpler error handling, retry, idempotency). Use WS for read streams. Add WS commands only if HTTP latency is a measured problem.

### Reconnect

Client implements exponential backoff: 1s, 2s, 4s, 8s, max 30s. On reconnect, re-subscribe to last set of topics. Header strip shows `WS ✕` during disconnect, status bar shows "Reconnecting in Xs".

---

## Rate limits

Server-side budgets:
- `GET` reads: 60 req/s per JWT.
- `POST/PUT/DELETE` writes: 10 req/s per JWT.
- WS messages from client: 30 msg/s.

On exceed: HTTP `429 rate_limited` with `Retry-After` header. WS: server sends `{ type: 'error', code: 'rate_limited' }` and rate-throttles for 5 seconds.

These are pessimistic — dashboard should never hit them in normal use.

---

## CORS

- Default: no CORS. Dashboard is served from the same origin as the API (Bun.serve serves static + API together).
- If split origins ever needed (e.g., dashboard CDN-hosted), CORS allow-list specific origin only, `credentials: true`.

---

## Error codes

Stable enum, used in `error.code` field:

| Code | When |
|---|---|
| `unauthenticated` | No / invalid auth cookie |
| `forbidden` | Viewer attempted owner action |
| `not_found` | Resource missing |
| `validation_failed` | Request body invalid |
| `missing_confirm` | Write request without `confirm: true` |
| `conflict` | State precondition failed (e.g., cancel an already-filled order) |
| `rate_limited` | Hit server rate limit |
| `exchange_error` | Upstream exchange returned error (HL/BB) |
| `internal` | Unhandled server error |
| `paper_mode` | Live action attempted in paper mode (or vice versa) |

Add new codes here in the same PR that introduces them.

---

## Health / readiness

```
GET /healthz   → 200 "ok"          (always, regardless of auth)
GET /readyz    → 200 { ws_ok, db_ok, exchange_ok, last_tick_ts }   (auth required)
```

Used by external monitoring (uptime checks, future canary). `/readyz` includes enough state to detect a process that's running but blocked on a dead feed.
