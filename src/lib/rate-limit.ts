import { logger } from "./logger";
import { llmDailyCostCents, rateLimitProvider } from "./env";

/**
 * Minimal in-process fixed-window rate limiter (single-server deployments).
 * For multi-instance deployments, replace the Map with a shared store
 * (e.g. Postgres/Redis) — the call sites stay identical.
 *
 * Blueprint §7.6 keys: `login:<account|ip>`, `chat:<id>`, `msg:<customerId>`,
 * `refund:<customerId>`, `api:<ip>`.
 *
 * Memory-bounded: expired windows are evicted lazily once the map grows.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

let redisWarned = false;
function noteProvider(): void {
  if (rateLimitProvider() === "redis" && !redisWarned) {
    redisWarned = true;
    logger.warn("RATE_LIMIT_PROVIDER=redis is a documented extension point; using the in-process limiter", {
      provider: "redis",
    });
  }
}

function purgeExpired(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(key);
  }
}

/** Returns true when the request is allowed, false when the limit is hit. */
export function allowRequest(key: string, limit: number, windowMs: number): boolean {
  noteProvider();
  const now = Date.now();
  const w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    purgeExpired(now);
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

/** Test helper: drop all windows. */
export function resetRateLimits(): void {
  buckets.clear();
}

/* -------------------------------------------------------------------------- */
/*  LLM daily spend guard (blueprint §7.6: reject above $50/customer/day)     */
/* -------------------------------------------------------------------------- */

const llmDailyCosts = new Map<string, number>();

function utcDayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Accumulate a customer's LLM cost (cents) for the current UTC day. */
export function recordLlmDailyCost(customerId: string, cents: number): void {
  if (!cents || cents <= 0) return;
  const day = utcDayStamp();
  const key = `llmcost:${customerId}:${day}`;
  llmDailyCosts.set(key, (llmDailyCosts.get(key) ?? 0) + cents);
  if (llmDailyCosts.size > 10_000) {
    for (const [k] of llmDailyCosts) {
      if (!k.endsWith(day)) llmDailyCosts.delete(k);
    }
  }
}

export function llmDailyCostTodayCents(customerId: string): number {
  return llmDailyCosts.get(`llmcost:${customerId}:${utcDayStamp()}`) ?? 0;
}

/** True once today's cumulative spend strictly exceeds the configured cap. */
export function llmDailyCostExceeded(customerId: string): boolean {
  return llmDailyCostTodayCents(customerId) > llmDailyCostCents();
}

/** Test helper. */
export function resetLlmDailyCostsForTesting(): void {
  llmDailyCosts.clear();
}
