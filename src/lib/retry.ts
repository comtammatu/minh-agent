/**
 * Reusable retry-with-exponential-backoff utility (S13: Self-Healing).
 *
 * Pure logic — no I/O, no side effects.
 * The actual delay is injected via the `delay` parameter for testability.
 */

import { RETRY } from '../config.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Max number of attempts (including initial). Default: RETRY.exchangeMaxAttempts */
  maxAttempts?: number
  /** Initial delay in ms before first retry. Default: RETRY.initialDelayMs */
  initialDelayMs?: number
  /** Maximum delay cap in ms. Default: RETRY.maxDelayMs */
  maxDelayMs?: number
  /** Backoff multiplier per attempt. Default: RETRY.backoffMultiplier */
  backoffMultiplier?: number
  /** Random jitter fraction (0–1). Default: RETRY.jitterFraction */
  jitterFraction?: number
  /** Should we retry this error? Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** Called on each retry (for logging). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export interface RetryResult<T> {
  success: boolean
  value: T | null
  attempts: number
  lastError: unknown
}

// ─── Backoff Calculation (pure) ─────────────────────────────────────────────

/**
 * Calculate delay for a given attempt with exponential backoff + jitter.
 * attempt starts at 1 (first retry).
 */
export function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitterFraction: number,
): number {
  const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1)
  const capped = Math.min(baseDelay, maxDelayMs)
  const jitter = capped * jitterFraction * Math.random()
  return Math.round(capped + jitter)
}

// ─── Retry Wrapper ──────────────────────────────────────────────────────────

/**
 * Execute `fn` with exponential backoff retry.
 *
 * Returns RetryResult with value on success or lastError on exhaustion.
 * Does NOT throw — caller decides how to handle failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? RETRY.exchangeMaxAttempts
  const initialDelay = opts.initialDelayMs ?? RETRY.initialDelayMs
  const maxDelay = opts.maxDelayMs ?? RETRY.maxDelayMs
  const multiplier = opts.backoffMultiplier ?? RETRY.backoffMultiplier
  const jitter = opts.jitterFraction ?? RETRY.jitterFraction
  const shouldRetry = opts.shouldRetry ?? (() => true)

  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn()
      return { success: true, value, attempts: attempt, lastError: null }
    } catch (err) {
      lastError = err

      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break
      }

      const delayMs = calculateDelay(attempt, initialDelay, maxDelay, multiplier, jitter)
      opts.onRetry?.(err, attempt, delayMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  return { success: false, value: null, attempts: maxAttempts, lastError }
}

// ─── 503 Detection ──────────────────────────────────────────────────────────

/**
 * Check if an error indicates exchange maintenance (503 Service Unavailable).
 * Works with Error objects, fetch Response errors, or string messages.
 */
export function is503(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes('503') || msg.includes('service unavailable') || msg.includes('maintenance')
  }
  if (typeof error === 'string') {
    const msg = error.toLowerCase()
    return msg.includes('503') || msg.includes('service unavailable') || msg.includes('maintenance')
  }
  return false
}

/**
 * Check if error is a rate limit (429).
 */
export function is429(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('429') || error.message.toLowerCase().includes('rate limit')
  }
  if (typeof error === 'string') {
    return error.includes('429') || error.toLowerCase().includes('rate limit')
  }
  return false
}

/**
 * Default shouldRetry: retry on 503 and transient errors, NOT on validation errors.
 */
export function isRetryableExchangeError(error: unknown): boolean {
  // 503 = exchange maintenance → retry
  if (is503(error)) return true
  // 429 = rate limited → retry (rate limiter should handle, but belt-and-suspenders)
  if (is429(error)) return true

  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    // Network errors → retry
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('fetch failed')) return true
    // Validation / business logic → do NOT retry
    if (msg.includes('unknown asset') || msg.includes('minimum') || msg.includes('not initialized')) return false
  }

  // Default: retry unknown errors
  return true
}
