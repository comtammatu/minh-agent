# Dead-Man-Switch — Operations Guide

Two-track safety system that auto-cancels open orders if the bot freezes or crashes between health checks.

| Track | Exchange | Mechanism | Owned by |
|---|---|---|---|
| HL DMS | Hyperliquid | Native `scheduleCancel` API (exchange-side) | `src/runtime/app.ts` |
| BB Watchdog | Bybit | External process polling heartbeat file | `scripts/bb-watchdog.ts` |

Both tracks gate on `PAPER_TRADE=false` — paper-mode processes never arm them.

---

## Why BB needs a separate watchdog

Hyperliquid offers a native `scheduleCancel(deadlineMs)` endpoint. The exchange cancels everything on its side N minutes after the last refresh — no bot involvement needed.

Bybit has **no equivalent** in their REST or WS API (`bybit-exchange-service.ts:611` returns explicit failure). The graceful-shutdown handler in `app.ts:cleanup()` runs `cancelAllOpenOrders()` on SIGTERM/SIGINT but is **never reached on**:

- `kill -9` (SIGKILL — bypasses signal handlers)
- Power loss / kernel panic / OOM kill
- Bun process freeze (deadlock, GC pathological case, infinite loop)
- Container OOM-killed by orchestrator

A BB-only operator running live therefore has **zero crash protection** without an external process. This guide covers what that process is and how to deploy it.

---

## Design decision — standalone Bun script (Option A)

Three approaches were considered before settling:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Standalone Bun script polling heartbeat file** | Works on macOS dev + Linux prod. No external deps. Same Bun runtime, same `.env` loading, same Bybit SDK as main process. One process supervisor surface (systemd / pm2 / container). | Has to be supervised itself. Two processes to deploy instead of one. | **Chosen.** |
| B. systemd `Watchdog=` directive | Native to Linux. Mature semantics. No code to maintain. | Linux-only — useless on macOS dev. `WatchdogSec=` requires `sd_notify` Bun bindings. Restarts the main process; it does NOT call Bybit on its behalf. | Rejected. We need the cancel, not a restart, and we need it on macOS too. |
| C. Container healthcheck → restart trigger | Free with Docker/k8s. | Still doesn't cancel orders — restart only. Couples the safety story to a specific deploy target. | Rejected. Same reason as B. |

**Why A wins:** the watchdog's job is "if main process is silent, call Bybit `cancelAllOpenOrders`." That is action, not restart. A and only A executes the cancel. B and C re-arm the bot, but the bot may not come back up healthy — orders stay open in the meantime.

A also has the smallest deploy surface: one script, one `.env`, one supervisor. Supervisor choice (systemd / pm2 / container restart policy) is operator-preference and documented at the bottom of this file.

---

## Architecture

```text
main process (src/index.ts)
  └─ runtime/heartbeat.ts
       └─ writes {pid, ts} to BB_HEARTBEAT_PATH every BB_HEARTBEAT_WRITE_MS

  on graceful shutdown:
       └─ deletes BB_HEARTBEAT_PATH (signals "stopped intentionally")

watchdog process (scripts/bb-watchdog.ts) — separate Bun process
  loop every BB_HEARTBEAT_WRITE_MS:
    read BB_HEARTBEAT_PATH
      missing  → main process shut down cleanly → do nothing
      present  → check (now - ts) and kill(pid, 0)
        fresh + alive  → healthy → sleep
        stale          → wait for full BB_HEARTBEAT_THRESHOLD_MS
        stale + alive  → freeze suspected (process up but not writing)
                          → call cancelAllOpenOrders, log, exit non-zero
        stale + dead   → crash → call cancelAllOpenOrders, log, exit non-zero
```

`kill(pid, 0)` is the standard liveness probe — sends signal 0, which only checks whether the PID is owned by us, never delivers a real signal. Combined with the `(pid, ts)` tuple in the file, it survives PID reuse (a new process takes the same PID): the new heartbeat overwrites the file with the new PID, so the watchdog's stored PID is always whatever it last read.

---

## Configuration

All constants live in [src/config.ts](../../src/config.ts):

| Constant | Default | Meaning |
|---|---|---|
| `BB_HEARTBEAT_PATH` | `/tmp/minh-heartbeat.json` | Where the writer puts `{pid, ts}` |
| `BB_HEARTBEAT_WRITE_MS` | `30_000` (30 s) | Writer cadence in main process |
| `BB_HEARTBEAT_THRESHOLD_MS` | `300_000` (5 min) | Watchdog triggers if file older than this |
| `BB_WATCHDOG_ENABLED` | derived | `ACTIVE_EXCHANGE=BB && PAPER_TRADE=false` |

Margin: 5 min threshold / 30 s write cadence = **10× safety factor**. A normal slow operation (DB compaction, backfill stall, GC pause) does not trigger the watchdog. Only a multi-minute freeze does.

Override `BB_HEARTBEAT_PATH` in environments where `/tmp` is per-process (some container runtimes). The watchdog and main process MUST agree on the path — pass the same env var to both.

---

## Run the watchdog

```bash
ACTIVE_EXCHANGE=BB PAPER_TRADE=false BYBIT_API_KEY=… BYBIT_API_SECRET=… \
  bun run scripts/bb-watchdog.ts
```

The watchdog reads the same `.env` as the main process, since both run in the same project directory.

**It must be supervised** — if the watchdog dies, the bot is unprotected with no alert. Below are two supervisor setups.

### systemd (Linux prod)

`/etc/systemd/system/minh.service` (main process):

```ini
[Unit]
Description=Minh trading runtime
After=network.target postgresql.service

[Service]
Type=simple
User=minh
WorkingDirectory=/srv/minh
EnvironmentFile=/srv/minh/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/minh-watchdog.service`:

```ini
[Unit]
Description=Minh Bybit dead-man-switch watchdog
After=minh.service
PartOf=minh.service

[Service]
Type=simple
User=minh
WorkingDirectory=/srv/minh
EnvironmentFile=/srv/minh/.env
ExecStart=/usr/local/bin/bun run scripts/bb-watchdog.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minh.service minh-watchdog.service
sudo systemctl status minh-watchdog.service
journalctl -u minh-watchdog.service -f   # follow watchdog logs
```

`PartOf=minh.service` makes the watchdog stop when the main service stops cleanly (avoids the watchdog firing on operator-driven shutdowns). The main process also deletes the heartbeat file on graceful shutdown as a second guard.

### pm2 (macOS dev / single-host prod)

```bash
pm2 start src/index.ts          --name minh           --interpreter bun
pm2 start scripts/bb-watchdog.ts --name minh-watchdog  --interpreter bun
pm2 save
pm2 startup    # then run the printed command
```

`pm2 logs minh-watchdog` to follow.

### Container (Docker / k8s)

Run two containers from the same image, each with its own command:

```yaml
services:
  minh:
    image: minh:latest
    command: ["bun", "run", "src/index.ts"]
    env_file: .env
    restart: always
    volumes:
      - heartbeat:/tmp

  minh-watchdog:
    image: minh:latest
    command: ["bun", "run", "scripts/bb-watchdog.ts"]
    env_file: .env
    restart: always
    depends_on: [minh]
    volumes:
      - heartbeat:/tmp   # MUST share the heartbeat file

volumes:
  heartbeat:
```

The two containers must **share the heartbeat path** (named volume or bind mount). Otherwise each container sees its own `/tmp` and the watchdog reads nothing.

---

## What happens on a real freeze

1. T+0: main process freezes (deadlock / OOM / kernel page fault). Heartbeat file ages.
2. T+30s: watchdog reads file, sees ts is ~30s old → still under threshold → sleep.
3. T+30s through T+5min: each watchdog tick sees increasing staleness, but still under 5 min.
4. T+5min01s: watchdog sees ts > 5 min old. Calls `cancelAllOpenOrders()`. Logs the event to stderr. Exits non-zero (supervisor restarts it; loop resumes).
5. Supervisor restart policy restarts the main process. The bot comes back up, writes a fresh heartbeat (new PID). Watchdog (restarted by its own supervisor) reads the fresh heartbeat, resumes normal polling.

Worst-case order exposure: **~5 min** (the threshold) plus however long `cancelAllOpenOrders()` takes on Bybit (typically <2 s).

This is intentionally conservative. Crypto SL/TP are usually 0.5–3 % away from entry — a 5-minute window of unattended exposure on a position that already has SL/TP at the exchange is bounded loss, not blow-up.

## What happens on graceful shutdown

1. Operator runs `systemctl stop minh.service` (or `pm2 stop minh`, or Ctrl-C).
2. Main process receives SIGTERM → `cleanup('shutdown')`.
3. `cleanup` calls `cancelAllOpenOrders()` itself.
4. Heartbeat writer is stopped; heartbeat file is **deleted**.
5. Watchdog's next tick sees missing file → treats it as intentional stop → sleeps without action.
6. With `PartOf=minh.service` (systemd) or operator-driven `pm2 stop minh-watchdog`, the watchdog stops too.

No double-cancel, no spurious watchdog trigger on operator shutdown.

## Testing the watchdog without losing money

1. Run with `BYBIT_DEMO=true` (Bybit Demo Trading) so cancels hit virtual balance.
2. Place a few demo orders manually.
3. Start `bb-watchdog.ts`.
4. Send `kill -STOP <main-pid>` to simulate a freeze (the process is paused but PID stays alive — best-case test of "process up but not heartbeating").
5. Wait `BB_HEARTBEAT_THRESHOLD_MS` (default 5 min). Watchdog logs the cancel and exits.
6. `kill -CONT <main-pid>` to resume the main process.
7. Verify demo orders are gone in the Bybit Demo UI.

To shorten the wait for testing, export `BB_HEARTBEAT_THRESHOLD_MS=15000` and `BB_HEARTBEAT_WRITE_MS=3000` for both processes.
