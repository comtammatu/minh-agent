/**
 * Sound Alerts — BEL character for local terminal notification.
 *
 * S15: Triggers on setup detection (grade B+) and circuit breaker events.
 *
 * Design:
 *   - Pure check function (shouldSound) + thin I/O wrapper (playSound)
 *   - BEL character (\x07) — works on macOS Terminal, iTerm2, most Linux terms
 */

import type { AgentAction } from '../agent/types.js'
import type { ConfluenceGrade } from '../types.js'

// ─── Sound-worthy grades ──────────────────────────────────────────────────

const SOUND_GRADES = new Set<ConfluenceGrade>(['B', 'A', 'A+'])

// ─── Check ────────────────────────────────────────────────────────────────

/**
 * Determine whether an action warrants a sound alert.
 * Returns true for:
 *   - Setup signals with grade B, A, or A+
 *   - Circuit breaker events
 */
export function shouldSound(action: AgentAction): boolean {
  if (action.type !== 'log_journal') return false

  if (action.eventType === 'signal') {
    const grade = action.details.grade as ConfluenceGrade | undefined
    return grade != null && SOUND_GRADES.has(grade)
  }

  if (action.eventType === 'circuit_break') {
    return true
  }

  return false
}

// ─── Play ─────────────────────────────────────────────────────────────────

/** Emit BEL character via stderr to avoid conflicting with ink's stdout control. */
export function playSound(): void {
  process.stderr.write('\x07')
}

/**
 * Check action and play sound if warranted.
 * Convenience wrapper for wiring: agent.on('action', maybeSoundAlert)
 */
export function maybeSoundAlert(action: AgentAction): void {
  if (shouldSound(action)) {
    playSound()
  }
}
