# Hyperliquid (HL) — Keep surface

Mainnet: `https://api.hyperliquid.xyz` · WS `wss://api.hyperliquid.xyz/ws`

## Info RPC (`POST /info`) — Keep

`candleSnapshot`, `meta`, `metaAndAssetCtxs`, `perpDexs`, `allMids`, `openOrders` / `frontendOpenOrders`, `orderStatus`, `userFills`, `userFillsByTime`, `clearinghouseState`, `spotClearinghouseState`, `fundingHistory`

## Exchange RPC (`POST /exchange`) — Keep

`order`, `cancel`, `cancelByCloid`, `modify`, `updateLeverage`, `scheduleCancel` (DMS)

## WebSocket — Keep

`candle`, `l2Book`, `allDexsAssetCtxs`  
Module (optional later): `trades`

## Auth / rate

- `PRIVATE_KEY` (+ optional `ACCOUNT_ADDRESS`)
- 1200 weight/min IP — all REST via rate-limiter
- CrashGuard: native `scheduleCancel`

## Adapter path

`src/adapters/feed/hl/`, `src/adapters/exchange/hl/`
