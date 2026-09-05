# Bybit (BB) — Keep surface

Mainnet REST: `https://api.bybit.com` · Demo: `https://api-demo.bybit.com`  
WS public linear: `wss://stream.bybit.com/v5/public/linear` · private: `…/v5/private`

`BYBIT_DEMO` = demoTrading host — **not** testnet.

## REST public — Keep

`GET /v5/market/kline`, `tickers`, `instruments-info` (+ `risk-limit` if needed)

## REST private — Keep

`order/create|cancel|cancel-all`, `order/realtime|history`, `position/list`, `position/set-leverage`, `position/trading-stop`, `account/wallet-balance` (UNIFIED)

Optional later: `order/disconnected-cancel-all` (DCP)

## WebSocket — Keep

`kline.{interval}.{symbol}`, `tickers.{symbol}`  
Module (optional): `publicTrade.{symbol}`

## Auth / rate

- `BYBIT_API_KEY` + `BYBIT_API_SECRET`
- Market + exec rate limiters in adapter
- CrashGuard: heartbeat + `scripts/bb-watchdog.ts` (no native DMS)

## Adapter path

`src/adapters/feed/bb/`, `src/adapters/exchange/bb/`
