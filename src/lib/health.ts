import net from "node:net";
import { getDb, getPostgresDb } from "@/db/client";
import { databaseUrl, healthCheckIntervalMs, llmMode, openAiBaseUrl, openaiApiKey } from "./env";
import { logger } from "./logger";

/**
 * Readiness probing (blueprint §10.3). Results are cached for
 * HEALTH_CHECK_INTERVAL_MS (default 30s) so probes are cheap enough for
 * load-balancer health checks. The database is the only CRITICAL dependency:
 * when it is down the app is not ready (503). LLM/Redis/Stripe are
 * best-effort: they make the status "degraded" but never block readiness
 * (the LLM has a mock mode; Redis/Stripe are optional integrations).
 */

export interface DepStatus {
  status: "ok" | "down" | "disabled" | "mock";
  detail?: string;
  checkedAt: number;
}

export interface Readiness {
  status: "ok" | "degraded" | "down";
  ready: boolean;
  dependencies: { db: DepStatus; llm: DepStatus; redis: DepStatus; stripe: DepStatus };
  checkedAt: number;
}

let cached: Readiness | undefined;

/** Test hook: drop the readiness cache. */
export function clearReadinessCache(): void {
  cached = undefined;
}

async function safe(fn: () => Promise<DepStatus>): Promise<DepStatus> {
  try {
    return await fn();
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
}

async function checkDb(): Promise<DepStatus> {
  const t0 = Date.now();
  try {
    if (databaseUrl()) {
      const pg = (getPostgresDb() as unknown as { $client: { unsafe: (q: string) => Promise<unknown[]> } }).$client;
      const rows = await pg.unsafe("SELECT 1");
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("SELECT 1 returned no rows");
    } else {
      const raw = (getDb() as unknown as { $client: { prepare: (q: string) => { get: () => unknown } } }).$client;
      raw.prepare("SELECT 1").get();
    }
    return { status: "ok", detail: `${Date.now() - t0}ms`, checkedAt: Date.now() };
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
}

async function checkLlm(): Promise<DepStatus> {
  if (llmMode() !== "openai") return { status: "mock", checkedAt: Date.now() };
  try {
    const url = `${openAiBaseUrl().replace(/\/+$/, "")}/models`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${openaiApiKey()}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { status: "down", detail: `HTTP ${res.status}`, checkedAt: Date.now() };
    return { status: "ok", checkedAt: Date.now() };
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`connect timed out after ${timeoutMs}ms`));
    });
    socket.once("error", reject);
  });
}

async function checkRedis(): Promise<DepStatus> {
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) return { status: "disabled", checkedAt: Date.now() };
  try {
    const u = new URL(url);
    await tcpProbe(u.hostname || "127.0.0.1", Number(u.port || 6379), 2000);
    return { status: "ok", checkedAt: Date.now() };
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
}

async function checkStripe(): Promise<DepStatus> {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) return { status: "disabled", checkedAt: Date.now() };
  try {
    const res = await fetch("https://api.stripe.com/v1", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    // 401 means the key is rejected; anything else proves reachability.
    if (res.status === 401) return { status: "down", detail: "auth rejected (401)", checkedAt: Date.now() };
    return { status: "ok", checkedAt: Date.now() };
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
}

export async function readinessCheck(
  overrides?: { dbCheck?: () => Promise<DepStatus> },
): Promise<Readiness> {
  const ttl = healthCheckIntervalMs();
  if (cached && Date.now() - cached.checkedAt < ttl) return cached;

  const [db, llm, redis, stripe] = await Promise.all([
    overrides?.dbCheck ? safe(overrides.dbCheck) : safe(checkDb),
    safe(checkLlm),
    safe(checkRedis),
    safe(checkStripe),
  ]);

  const ready = db.status === "ok";
  const anyDown = [db, llm, redis, stripe].some((d) => d.status === "down");
  const result: Readiness = {
    status: ready ? (anyDown ? "degraded" : "ok") : "down",
    ready,
    dependencies: { db, llm, redis, stripe },
    checkedAt: Date.now(),
  };
  cached = result;

  if (!ready) logger.error("readiness: database unavailable", { detail: db.detail });
  else if (anyDown) logger.warn("readiness: degraded", { llm: llm.status, redis: redis.status, stripe: stripe.status });
  else logger.debug("readiness ok", { db: db.detail });

  return result;
}
