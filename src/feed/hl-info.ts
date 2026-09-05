/**
 * HL /info queries — rate-limited entry point.
 * Uses InfoClient for main perp; raw POST only for dex-scoped HIP-3 calls.
 */

import { acquire } from "./rate-limiter.js";
import { info } from "./rest.js";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

async function postInfo<T>(body: unknown): Promise<T> {
  await acquire();
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HL /info HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface PerpDexInfo {
  name: string;
  fullName?: string;
}

export interface PerpMetaUniverseAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: true;
  onlyIsolated?: true;
  marginMode?: "strictIsolated" | "noCross";
}

export interface PerpMeta {
  universe: PerpMetaUniverseAsset[];
  marginTables: unknown[];
  collateralToken?: number;
}

export interface PerpAssetCtx {
  dayNtlVlm?: string;
  dayBaseVlm?: string;
  funding: string;
  openInterest: string;
  prevDayPx?: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
}

/** All perpetual DEXes (first entry may be null for the main perp dex). */
export async function fetchAllPerpDexNames(): Promise<string[]> {
  await acquire();
  const dexs = await info.perpDexs();
  const names: string[] = [""];
  for (const d of dexs) {
    if (!d?.name) continue;
    names.push(d.name);
  }
  return [...new Set(names)];
}

export async function fetchMetaAndAssetCtxs(
  dex: string = "",
): Promise<[PerpMeta, PerpAssetCtx[]]> {
  if (dex === "") {
    await acquire();
    return info.metaAndAssetCtxs() as Promise<[PerpMeta, PerpAssetCtx[]]>;
  }
  return postInfo<[PerpMeta, PerpAssetCtx[]]>({
    type: "metaAndAssetCtxs",
    dex,
  });
}

export async function fetchAllMids(
  dex: string = "",
): Promise<Record<string, string>> {
  if (dex === "") {
    await acquire();
    return info.allMids();
  }
  return postInfo<Record<string, string>>({ type: "allMids", dex });
}

export interface OpenOrder {
  coin: string;
  limitPx: string;
  oid: number;
  side: string;
  sz: string;
  timestamp: number;
}

export async function fetchOpenOrders(
  user: string,
  dex: string = "",
): Promise<OpenOrder[]> {
  if (dex === "") {
    await acquire();
    return info.openOrders({ user }) as Promise<OpenOrder[]>;
  }
  return postInfo<OpenOrder[]>({ type: "openOrders", user, dex });
}
