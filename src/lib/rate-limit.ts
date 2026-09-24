/**
 * Minimal in-process fixed-window rate limiter (single-server deployments).
 * For multi-instance deployments, replace the Map with a shared store
 * (e.g. Postgres/Redis) — the call sites stay identical.
 *
 * Memory-bounded: expired windows are evicted lazily once the map grows.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

function purgeExpired(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(key);
  }
}

/** Returns true when the request is allowed, false when the limit is hit. */
export function allowRequest(key: string, limit: number, windowMs: number): boolean {
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
