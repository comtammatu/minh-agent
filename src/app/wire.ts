import { createBbCrashGuard, createBbExchangePort } from "../adapters/exchange/bb/index.js";
import { createHlCrashGuard, createHlExchangePort } from "../adapters/exchange/hl/index.js";
import { createPaperExchangePort } from "../adapters/exchange/paper/index.js";
import { createBbFeedPort } from "../adapters/feed/bb/index.js";
import { createHlFeedPort } from "../adapters/feed/hl/index.js";
import {
  getActiveExchange,
  isPaperMode,
} from "../config.js";
import type { CrashGuardPort } from "../ports/crash-guard.js";
import type { ExchangePort } from "../ports/exchange.js";
import type { FeedPort } from "../ports/feed.js";
import type { OperatorPort } from "../ports/operator.js";
import { createOperatorPort } from "../presence/operator-facade.js";

export interface WiredPorts {
  feed: FeedPort;
  exchange: ExchangePort;
  crashGuard: CrashGuardPort;
  operator: OperatorPort;
}

/** Wire Greenfield ports for the active exchange (paper or live). */
export function wirePorts(): WiredPorts {
  const active = getActiveExchange();
  const feed = active === "BB" ? createBbFeedPort() : createHlFeedPort();

  const exchange = isPaperMode()
    ? createPaperExchangePort(active)
    : active === "BB"
      ? createBbExchangePort()
      : createHlExchangePort();

  const crashGuard =
    active === "BB" ? createBbCrashGuard() : createHlCrashGuard();

  return {
    feed,
    exchange,
    crashGuard,
    operator: createOperatorPort(),
  };
}
