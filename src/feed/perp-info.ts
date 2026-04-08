import { acquire } from './rate-limiter.js'

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'

async function postInfo<T>(body: unknown): Promise<T> {
  await acquire()
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`HL /info HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export interface PerpDexInfo {
  name: string
  fullName?: string
}

/**
 * Retrieve all perpetual DEXes.
 *
 * HL returns an array where the first entry can be null for the "first perp dex".
 */
export async function fetchPerpDexs(): Promise<Array<PerpDexInfo | null>> {
  return postInfo<Array<PerpDexInfo | null>>({ type: 'perpDexs' })
}

/**
 * Returns a normalized list of perp dex identifiers:
 * - `''` for the first perp dex
 * - additional dex names for builder-deployed perps (HIP-3, etc)
 */
export async function fetchAllPerpDexNames(): Promise<string[]> {
  const dexs = await fetchPerpDexs()
  const names: string[] = ['']
  for (const d of dexs) {
    if (!d?.name) continue
    names.push(d.name)
  }
  // Dedup while preserving order
  return [...new Set(names)]
}

export interface PerpMetaUniverseAsset {
  name: string
  szDecimals: number
  maxLeverage: number
  isDelisted?: true
  onlyIsolated?: true
  marginMode?: 'strictIsolated' | 'noCross'
}

export interface PerpMeta {
  universe: PerpMetaUniverseAsset[]
  marginTables: unknown[]
  collateralToken?: number
}

export interface PerpAssetCtx {
  dayNtlVlm?: string
  dayBaseVlm?: string
  funding: string
  openInterest: string
  prevDayPx?: string
  premium: string | null
  oraclePx: string
  markPx: string
  midPx: string | null
  impactPxs: string[] | null
}

export async function fetchMeta(dex: string = ''): Promise<PerpMeta> {
  return postInfo<PerpMeta>({ type: 'meta', dex })
}

export async function fetchMetaAndAssetCtxs(dex: string = ''): Promise<[PerpMeta, PerpAssetCtx[]]> {
  return postInfo<[PerpMeta, PerpAssetCtx[]]>({ type: 'metaAndAssetCtxs', dex })
}

export async function fetchAllMids(dex: string = ''): Promise<Record<string, string>> {
  return postInfo<Record<string, string>>({ type: 'allMids', dex })
}

export interface OpenOrder {
  coin: string
  limitPx: string
  oid: number
  side: string
  sz: string
  timestamp: number
}

export async function fetchOpenOrders(user: string, dex: string = ''): Promise<OpenOrder[]> {
  return postInfo<OpenOrder[]>({ type: 'openOrders', user, dex })
}

export interface OrderStatusResponse {
  status: 'order' | 'unknownOid'
  order?: {
    order: Record<string, unknown>
    status: string
    statusTimestamp: number
  }
}

export async function fetchOrderStatus(
  user: string,
  oidOrCloid: number | string,
): Promise<OrderStatusResponse> {
  return postInfo<OrderStatusResponse>({ type: 'orderStatus', user, oid: oidOrCloid })
}

export interface UserFill {
  coin: string
  px: string
  sz: string
  side: string
  time: number
  oid: number
  dir: string
  closedPnl: string
  crossed: boolean
  fee?: string
  feeToken?: string
  builderFee?: string
  tid?: number
  hash?: string
  cloid?: string | null
}

/**
 * Paginate user fills by time.
 * HL returns at most 2000 fills per response; use the last fill time + 1 as the next startTime.
 */
export async function fetchUserFillsByTimePaged(params: {
  user: string
  startTime: number
  endTime?: number
  aggregateByTime?: boolean
  pageLimit?: number
}): Promise<UserFill[]> {
  const out: UserFill[] = []
  let start = params.startTime
  const endTime = params.endTime
  const pageLimit = params.pageLimit ?? 2000
  for (;;) {
    const page = await postInfo<UserFill[]>({
      type: 'userFillsByTime',
      user: params.user,
      startTime: start,
      ...(endTime !== undefined ? { endTime } : {}),
      ...(params.aggregateByTime !== undefined ? { aggregateByTime: params.aggregateByTime } : {}),
    })
    out.push(...page)
    if (page.length < pageLimit) break
    const last = page[page.length - 1]
    if (!last || typeof last.time !== 'number') break
    start = last.time + 1
    if (endTime !== undefined && start > endTime) break
  }
  return out
}

