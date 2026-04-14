# Go-Live Checklist

Date: 2026-04-14

This is the short promotion ladder for paper and supervised live.

Bybit staging reference:

- [Bybit Demo Trading](./bybit-demo-trading.md)

## 1. Current Verdict

| Stage | Status | Why |
|---|---|---|
| `paper` | ready | startup, recovery, and operator controls exist |
| `bybit demo` | recommended next | validates execution/account flow without real-money risk |
| `supervised live` | conditionally ready | tiny-size rollout only, with human oversight |
| `unattended live` | blocked | validation is still too weak |

## 2. Paper Checklist

- `bun run typecheck` passes
- `bun test --run` passes
- startup reaches `ARMED`
- exchange bootstrap succeeds
- tracked positions and exchange positions match
- restart and shutdown drills are captured

## 3. Supervised Live Checklist

- use `BTC`, `ETH`, `SOL` only
- keep size minimum practical
- stay present for startup, restart, and shutdown
- capture one evidence block per session
- review TUI, Telegram, and exchange together

Recommended sheet:

- [Supervised Live Operator Sheet](./supervised-live-operator-sheet.md)

## 4. Unattended Live Checklist

- holdout PF is comfortably above breakeven
- OOS PF is above breakeven on enough trades
- restart and shutdown drills have repeated clean passes
- no unresolved ownership ambiguity remains
- incident handling is written and rehearsed

Gate reference:

- [Unattended Live Release Gate](./unattended-live-release-gate.md)
