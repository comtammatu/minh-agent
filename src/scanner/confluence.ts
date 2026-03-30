/**
 * Confluence scoring — grade C/B/A/A+ based on layer confirmations.
 *
 * Count factors:
 *   +1 if bias confidence >= 0.6  (Layer 1 clear)
 *   +1 if structure == 'confirm'  (Layer 2 confirms)
 *   +0.5 if structure == 'neutral'
 *   +1 if zone has multiple origins (Layer 3 multi-source)
 *   +1 if zone.vsaBoost > 0       (Layer 4 VSA)
 *   +1 if zone.vpBoost > 0        (Layer 4 VP)
 *   +0.5 if zone.oiBoost > 0      (Layer 4 OI — Phase D)
 *   +1 if trigger exists           (Layer 5 PA)
 *   +1 if regime aligned           (Regime context)
 *
 * Grade: C(< 3), B(3-4), A(5-6), A+(7+)
 *
 * Pure function. Zero I/O.
 */

import type {
  BiasResult,
  StructureVerdict,
  ZoneConfirmation,
  Signal,
  ConfluenceGrade,
  MarketRegime,
} from '../types.js'

export interface ConfluenceResult {
  grade: ConfluenceGrade
  count: number
  confidence: number
}

/**
 * Score confluence from all pipeline layers + regime.
 */
export function scoreConfluence(
  bias: BiasResult,
  structureVerdict: StructureVerdict,
  zone: ZoneConfirmation | null,
  trigger: Signal | null,
  regime: MarketRegime,
): ConfluenceResult {
  let count = 0

  // Layer 1: Bias clarity
  if (bias.confidence >= 0.6) count += 1

  // Layer 2: Structure confirmation
  if (structureVerdict === 'confirm') count += 1
  else if (structureVerdict === 'neutral') count += 0.5

  // Layer 3: Zone quality (multi-source zones are stronger)
  if (zone) {
    const origins = new Set<string>()
    origins.add(zone.zone.origin)
    // A zone compiled from multiple sources (OB + swing + FVG) is stronger
    // For now, each zone has one origin. Multi-source bonus if origin is compound.
    if (zone.zone.strength > 0.6) count += 1
  }

  // Layer 4: VSA + VP + Order Flow boosts
  if (zone && zone.vsaBoost > 0) count += 1
  if (zone && zone.vpBoost > 0) count += 1
  if (zone && (zone.deltaBoost ?? 0) > 0) count += 1
  if (zone && (zone.bookBoost ?? 0) > 0) count += 1
  if (zone && (zone.fundingBoost ?? 0) > 0) count += 0.5
  if (zone && (zone.oiBoost ?? 0) > 0) count += 0.5

  // Layer 5: Trigger pattern
  if (trigger) count += 1

  // Regime alignment
  if (trigger) {
    const aligned =
      (trigger.side === 'long' && regime === 'BULL') ||
      (trigger.side === 'short' && regime === 'BEAR')
    if (aligned) count += 1
  }

  // Grade
  const grade = gradeFromCount(count)

  // Confidence: aggregate from zone + trigger + boosts
  let confidence = bias.confidence
  if (zone) {
    confidence = (confidence + zone.zone.strength + zone.vsaBoost + zone.vpBoost) / 2
  }
  if (trigger) {
    confidence = (confidence + trigger.confidence) / 2
  }
  confidence = Math.min(Math.max(confidence, 0), 1)

  return { grade, count, confidence }
}

function gradeFromCount(count: number): ConfluenceGrade {
  if (count >= 8) return 'A+'
  if (count >= 6) return 'A'
  if (count >= 3) return 'B'
  return 'C'
}
