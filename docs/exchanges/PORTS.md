# Ports — Feed / Exchange / CrashGuard

Domain and Presence program against these ports only.

## FeedPort

```ts
interface FeedPort {
  readonly exchange: "HL" | "BB";
  connect(): Promise<void>;
  backfill(...): Promise<BackfillResult[]>;
  subscribeCandles(...): Promise<void>;
  subscribeMarketCtx(...): Promise<void>;
  checkStaleness(now: number): StalenessReport;
  close(): Promise<void>;
}
```

## ExchangePort

Unified ops: `init`, `reloadInstruments`, `setLeverage`, `placeOrder`, `placeTrigger`, `cancel(OrderRef)`, `modifyTrigger` / `updatePositionStop`, `getAccount`, `getPositions`, `getOpenOrders`, `getFillAggregate`, `cancelAllOpenOrders`.

- `OrderRef`: string (cloid preferred; else exchange id string)
- No public `getAssetId` (HL-internal only)

## CrashGuardPort

```ts
interface CrashGuardPort {
  arm(): Promise<void>;
  refresh(): Promise<void>;
  disarm(): Promise<void>;
}
```

| | HL | BB |
|---|---|---|
| arm/refresh | `scheduleCancel` | heartbeat ± DCP |
| disarm | clear + cancelAll | stop heartbeat + cancelAll |

## Lifecycle

```text
feed.connect → subscribe → [live] exchange.init → CrashGuard.arm
shutdown → CrashGuard.disarm → feed.close
```
