/**
 * Golden test fixture generator.
 * Runs Tuệ's indicators on 200 real BTC 4H candles (fetched from HL REST)
 * and saves the output as JSON to test/fixtures/*.json.
 *
 * Usage: bun run scripts/gen-fixtures.ts
 *
 * IMPORTANT: Requires gettueapp at ../../gettueapp/ (relative to minh-agent/).
 * This script is dev-only and never runs in production.
 */

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Import Tuệ indicators as the reference implementation
// These are the spec — Minh's output must match these exactly.
import { sma, ema, atr, rsi, adx, volumeRatio, detectRegime } from '../../gettueapp/src/entities/hanh/features/research/indicators/core.js'
import { detectFVG, scanFVGs, detectOrderBlocks, findSwingPoints } from '../../gettueapp/src/entities/hanh/features/research/indicators/smc.js'
import { detectPriceAction } from '../../gettueapp/src/entities/hanh/features/research/indicators/price-action.js'
import { detectVSA } from '../../gettueapp/src/entities/hanh/features/research/indicators/vsa.js'
import { detectWyckoffPhase } from '../../gettueapp/src/entities/hanh/features/research/indicators/wyckoff.js'
import { buildVolumeProfile } from '../../gettueapp/src/entities/hanh/features/research/indicators/volume-profile.js'
import { analyzeStructure } from '../../gettueapp/src/entities/hanh/features/research/indicators/structure.js'

type TueCandle = { t: number; o: number; h: number; l: number; c: number; v: number }

async function fetchBTC4H(): Promise<TueCandle[]> {
  const transport = new HttpTransport()
  const info = new InfoClient({ transport })
  const endTime = Date.now()
  const startTime = endTime - 200 * 4 * 60 * 60 * 1000  // ~200 4H bars

  const raw = await info.candleSnapshot({ coin: 'BTC', interval: '4h', startTime, endTime })
  return raw.slice(-200).map(c => ({
    t: c.t,
    o: parseFloat(c.o),
    h: parseFloat(c.h),
    l: parseFloat(c.l),
    c: parseFloat(c.c),
    v: parseFloat(c.v),
  }))
}

async function main() {
  console.log('Fetching 200 BTC 4H candles from HL...')
  const candles = await fetchBTC4H()
  console.log(`Got ${candles.length} candles`)

  const outDir = join(import.meta.dir, '../test/fixtures')
  mkdirSync(outDir, { recursive: true })

  const idx = candles.length - 1

  // ── core ──────────────────────────────────────────────────────────────────
  const coreFixture = {
    candles,
    sma7: sma(candles, idx, 7),
    sma30: sma(candles, idx, 30),
    ema14: ema(candles, idx, 14),
    atr14: atr(candles, idx, 14),
    rsi14: rsi(candles, idx, 14),
    adx14: adx(candles, idx, 14),
    volRatio20: volumeRatio(candles, idx, 20),
    regime: detectRegime(candles, idx),
    // Also capture a slice of sma7 values over last 30 bars to verify incremental correctness
    sma7Series: Array.from({ length: 30 }, (_, i) => sma(candles, idx - 29 + i, 7)),
    atr14Series: Array.from({ length: 30 }, (_, i) => atr(candles, idx - 29 + i, 14)),
  }
  writeFileSync(join(outDir, 'core.json'), JSON.stringify(coreFixture, null, 2))
  console.log('✓ core.json')

  // ── smc ───────────────────────────────────────────────────────────────────
  const smcFixture = {
    fvgAtIdx: detectFVG(candles, idx),
    activeFVGs: scanFVGs(candles, idx),
    orderBlocks: detectOrderBlocks(candles, idx, { lookback: 50 }),
    swingPoints: findSwingPoints(candles, idx, 3),
  }
  writeFileSync(join(outDir, 'smc.json'), JSON.stringify(smcFixture, null, 2))
  console.log('✓ smc.json')

  // ── price-action ──────────────────────────────────────────────────────────
  const paFixture = {
    patternsAtIdx: detectPriceAction(candles, idx),
    // Scan last 20 bars
    patternScan: Array.from({ length: 20 }, (_, i) => ({
      idx: idx - 19 + i,
      patterns: detectPriceAction(candles, idx - 19 + i),
    })),
  }
  writeFileSync(join(outDir, 'price-action.json'), JSON.stringify(paFixture, null, 2))
  console.log('✓ price-action.json')

  // ── vsa ───────────────────────────────────────────────────────────────────
  const vsaFixture = {
    vsaAtIdx: detectVSA(candles, idx),
    vsaScan: Array.from({ length: 20 }, (_, i) => ({
      idx: idx - 19 + i,
      signals: detectVSA(candles, idx - 19 + i),
    })),
  }
  writeFileSync(join(outDir, 'vsa.json'), JSON.stringify(vsaFixture, null, 2))
  console.log('✓ vsa.json')

  // ── wyckoff ───────────────────────────────────────────────────────────────
  const wyckoffFixture = {
    wyckoffAtIdx: detectWyckoffPhase(candles, idx),
    wyckoffScan: Array.from({ length: 10 }, (_, i) => ({
      idx: idx - 9 + i,
      result: detectWyckoffPhase(candles, idx - 9 + i),
    })),
  }
  writeFileSync(join(outDir, 'wyckoff.json'), JSON.stringify(wyckoffFixture, null, 2))
  console.log('✓ wyckoff.json')

  // ── volume-profile ────────────────────────────────────────────────────────
  const vpFixture = {
    profile: buildVolumeProfile(candles, idx - 99, idx, { numBins: 50 }),
    profileShort: buildVolumeProfile(candles, idx - 49, idx, { numBins: 50 }),
  }
  writeFileSync(join(outDir, 'volume-profile.json'), JSON.stringify(vpFixture, null, 2))
  console.log('✓ volume-profile.json')

  // ── structure ─────────────────────────────────────────────────────────────
  const structureFixture = {
    structure: analyzeStructure(candles, idx),
  }
  writeFileSync(join(outDir, 'structure.json'), JSON.stringify(structureFixture, null, 2))
  console.log('✓ structure.json')

  console.log(`\nAll fixtures written to ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
