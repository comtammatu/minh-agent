# Bybit Demo Trading

Date: 2026-04-14

This repo should use Bybit Demo Trading as the staging lane before real-money live sessions.

## Why This Lane Exists

- It exercises the real Bybit execution and account model without risking cash.
- It lets us validate UTA balance, positions, order rejections, and operator workflow.
- It is a better rehearsal target than Bybit testnet because market data stays close to production.

## Bybit-Specific Notes

- Demo trading is an isolated Bybit environment with its own account and API key pair.
- Public market data should stay on mainnet.
- Demo trading private APIs use `api-demo.bybit.com`.
- Demo trading private WS uses `stream-demo.bybit.com/v5/private`.
- WS trade is not supported on demo trading, but this repo does not depend on Bybit trade WS for execution.

## Repo Behavior

- `BYBIT_DEMO_TRADING=true` routes Bybit execution/account calls to demo trading.
- Public Bybit market data remains on mainnet so setups are based on real market conditions.
- Startup will log:

```text
MODE  | BYBIT DEMO TRADING — demo orders on Bybit with mainnet market data
```

## Required Env

```bash
ACTIVE_EXCHANGE=BB
PAPER_TRADE=false
BYBIT_DEMO_TRADING=true
BYBIT_TESTNET=false
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
FOCUSED_TRACKED_COINS=BTC,ETH
```

## First Session Checklist

- create or switch to a Bybit Demo Trading account in mainnet UI
- generate demo account API keys from the Demo Trading environment
- add demo funds to the demo UTA before startup
- keep the universe narrow: `BTC,ETH`
- ensure only one bot process is running before Telegram long-polling starts

## Promotion Rule

- pass demo trading first
- then pass tiny-size supervised live
- only then consider real-money live
