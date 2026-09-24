/**
 * Structured logging (blueprint §10.1).
 *
 * - Output: single-line JSON (LOG_FORMAT=json, default in production) or
 *   key=value text (LOG_FORMAT=text, default in dev/test) on stdout.
 * - Levels: debug < info < warn < error < fatal, filtered by LOG_LEVEL
 *   (default: debug in dev/test, info in production).
 * - Correlation IDs: one per HTTP request, propagated through
 *   AsyncLocalStorage, attached to every log line as `corr` so the whole
 *   trace of a request (HTTP, agent loop, LLM, tools, DB) is joinable.
 *
 * EDGE-SAFETY: this module keeps NO static `node:*` imports — node builtins
 * are resolved at runtime via process.getBuiltinModule (same discipline as
 * env.ts), so the file stays bundlable even if it ends up in the edge
 * instrumentation graph. Logging must never break the app: every write is
 * wrapped and failures are swallowed.
 */

type Level = "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

type AsyncLocalStorageCtor = new () => {
  run<T>(store: string, fn: () => T): T;
  getStore(): string | undefined;
};

function builtin(id: string): unknown {
  const getter = (
    process as NodeJS.Process & { getBuiltinModule?: (i: string) => unknown }
  ).getBuiltinModule;
  return getter?.(id);
}

let storage: InstanceType<AsyncLocalStorageCtor> | null = null;
let storageResolved = false;

function als(): InstanceType<AsyncLocalStorageCtor> | null {
  if (!storageResolved) {
    storageResolved = true;
    const mod = builtin("node:async_hooks") as { AsyncLocalStorage?: AsyncLocalStorageCtor } | undefined;
    storage = mod?.AsyncLocalStorage ? new mod.AsyncLocalStorage() : null;
  }
  return storage;
}

/** Short random request id (16 hex chars). */
export function newCorrelationId(): string {
  const crypto = builtin("node:crypto") as { randomBytes?: (n: number) => { toString: (b: string) => string } } | undefined;
  if (crypto?.randomBytes) return crypto.randomBytes(8).toString("hex");
  let out = "";
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function getCorrelationId(): string | undefined {
  return als()?.getStore();
}

/** Run `fn` with `id` as the correlation id for all logs inside it (async-safe). */
export function runWithCorrelation<T>(id: string, fn: () => T): T {
  const s = als();
  if (!s) return fn();
  return s.run(id, fn);
}

function effectiveConfig(): { level: Level; format: "json" | "text" } {
  const rawLevel = (process.env.LOG_LEVEL ?? "").toLowerCase();
  const level: Level = rawLevel in LEVELS ? (rawLevel as Level) : process.env.NODE_ENV === "production" ? "info" : "debug";
  const rawFormat = (process.env.LOG_FORMAT ?? "").toLowerCase();
  const format: "json" | "text" =
    rawFormat === "json" || rawFormat === "text" ? rawFormat : process.env.NODE_ENV === "production" ? "json" : "text";
  return { level, format };
}

function normalize(value: unknown): unknown {
  if (value instanceof Error) return { message: value.message, name: value.name, stack: value.stack };
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  return value;
}

export function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const cfg = effectiveConfig();
  if (LEVELS[level] < LEVELS[cfg.level]) return;

  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  const corr = getCorrelationId();
  if (corr) entry.corr = corr;
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      const nv = normalize(v);
      if (nv !== undefined) entry[k] = nv;
    }
  }

  try {
    if (cfg.format === "json") {
      process.stdout.write(JSON.stringify(entry) + "\n");
    } else {
      const fields = Object.entries(entry)
        .filter(([k]) => k !== "ts" && k !== "level" && k !== "msg")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      const line = `${entry.ts} [${level.toUpperCase()}] ${msg}${fields ? " " + fields : ""}`;
      if (level === "error" || level === "fatal") console.error(line);
      else console.log(line);
    }
  } catch {
    /* logging must never break the application (e.g. circular ctx) */
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, ctx),
  fatal: (msg: string, ctx?: Record<string, unknown>) => log("fatal", msg, ctx),
};
