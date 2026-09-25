import { logger } from "./logger";
import { providerMaxRetries, providerRetryBackoffMs } from "./env";

/**
 * Shared retry policy for external provider calls (blueprint §8.3).
 *
 * Defaults: up to 3 retries, exponential backoff 1s -> 2s -> 4s (tunable via
 * PROVIDER_MAX_RETRIES / PROVIDER_RETRY_BACKOFF_MS). Only TRANSIENT failures
 * are retried: 408/429/5xx, timeouts, and network errors. Auth and other 4xx
 * errors (401/403/400) are permanent — they are logged and fail fast, never
 * retried (blueprint §8.1).
 *
 * Retry safety: every call wrapped here must be idempotent (Stripe
 * Idempotency-Key, GET lookups, or client-side dedupe) so a retry after an
 * unknown-outcome network error cannot double-act.
 */

export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for transient provider failures worth a retry (see file header). */
export function isTransientProviderError(e: unknown): boolean {
  if (e instanceof ProviderHttpError) return RETRYABLE_STATUS.has(e.status);
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
    const m = e.message.toLowerCase();
    return (
      m.includes("fetch failed") ||
      m.includes("econnreset") ||
      m.includes("enotfound") ||
      m.includes("etimedout")
    );
  }
  return false;
}

export interface RetryOptions {
  /** Operation label for retry logs, e.g. "stripe refund". */
  label: string;
  maxRetries?: number;
  backoffMs?: number;
  retryOn?: (e: unknown) => boolean;
  /** Called before each backoff sleep; the default logs a structured warning. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxRetries = opts.maxRetries ?? providerMaxRetries();
  const baseMs = opts.backoffMs ?? providerRetryBackoffMs();
  const retryOn = opts.retryOn ?? isTransientProviderError;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!retryOn(e) || attempt === maxRetries) break;
      const delayMs = baseMs * 2 ** attempt;
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, delayMs, e);
      } else {
        logger.warn("provider request retrying", {
          label: opts.label,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          error: errMsg(e),
        });
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
