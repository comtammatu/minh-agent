/**
 * Bybit dynamic coin selection based on open interest.
 *
 * fetchBybitRankedCoins(): fetch all qualifying linear perp coins from Bybit
 *   sorted by openInterestValue (OI in USDT) descending.
 *
 * Mirrors fetchRankedCoins() for HL but uses Bybit's /v5/market/tickers endpoint.
 * No HIP-3 equivalent on Bybit.
 */

import { RestClientV5, type GetTickersParamsV5 } from 'bybit-api'
import { acquire } from './bybit-rate-limiter.js'
import {
  BYBIT_TOP_COINS_LIMIT,
  BYBIT_MIN_24H_VOLUME,
  BYBIT_STATIC_COINS,
} from '../../config.js'
import { log } from '../../lib/logger.js'

const client = new RestClientV5({ testnet: false })

/**
 * Extract coin name from a Bybit linear perp symbol.
 * BTCUSDT → BTC, 1000SHIBUSDT → 1000SHIB, ETHUSDT → ETH.
 * Returns null for symbols that don't end in USDT (unexpected format).
 */
function symbolToCoin(symbol: string): string | null {
  if (!symbol.endsWith('USDT')) return null
  return symbol.slice(0, -4)
}

/**
 * Fetch all qualifying Bybit linear perp coins ranked by OI descending.
 * Filters coins below BYBIT_MIN_24H_VOLUME.
 * Returns full ranked list. Falls back to BYBIT_STATIC_COINS on error.
 */
export async function fetchBybitRankedCoins(
  minVolume: number = BYBIT_MIN_24H_VOLUME,
): Promise<string[]> {
  try {
    await acquire()
    const params: GetTickersParamsV5<'linear' | 'inverse'> = { category: 'linear' }
    const res = await client.getTickers(params)

    if (res.retCode !== 0) {
      throw new Error(`Bybit API error retCode=${res.retCode}: ${res.retMsg}`)
    }

    const tickers = res.result?.list ?? []
    const coins: { name: string; oi: number }[] = []

    for (const t of tickers) {
      // Only USDT-margined perpetuals (no delivery contracts like BTC-28MAR25)
      const coin = symbolToCoin(t.symbol)
      if (!coin) continue

      // openInterestValue = OI in USDT (USD value), NOT openInterest which is in coin units
      const oi = parseFloat(t.openInterestValue ?? '0')
      if (isNaN(oi) || oi <= 0) continue

      const vol = parseFloat(t.turnover24h ?? '0')
      if (isNaN(vol) || vol < minVolume) continue

      coins.push({ name: coin, oi })
    }

    coins.sort((a, b) => b.oi - a.oi)
    return coins.map(c => c.name)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('bybit-coin-sel', `fetchBybitRankedCoins failed: ${msg}`)
    return []
  }
}

/**
 * Fetch top N Bybit coins ranked by OI.
 * Falls back to BYBIT_STATIC_COINS if fetch fails and current list is empty.
 */
export async function fetchBybitTopCoins(
  limit: number = BYBIT_TOP_COINS_LIMIT,
  minVolume: number = BYBIT_MIN_24H_VOLUME,
): Promise<string[]> {
  const ranked = await fetchBybitRankedCoins(minVolume)
  if (ranked.length === 0) {
    log.warn('bybit-coin-sel', `fetchBybitRankedCoins returned empty — using static fallback (${BYBIT_STATIC_COINS.length} coins)`)
    return BYBIT_STATIC_COINS.slice(0, limit)
  }
  return ranked.slice(0, limit)
}

/**
 * Returns a fetchRankedFn compatible with createCoinSelector for Bybit mode.
 * Fetches the full ranked list (not sliced) — CoinSelector applies TOP_COINS_LIMIT internally.
 * Falls back to static coins on error so startup is never blocked.
 */
export function makeBybitFetchRankedFn(): () => Promise<string[]> {
  return async () => {
    const ranked = await fetchBybitRankedCoins()
    if (ranked.length === 0) {
      log.warn('bybit-coin-sel', 'ranked fetch failed — returning static fallback')
      return BYBIT_STATIC_COINS
    }
    return ranked
  }
}
