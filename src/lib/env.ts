/** Centralised, typed access to environment configuration.
 *
 * The app is API-key-CONFIGURABLE and production-oriented:
 *  - LLM:   OpenAI-compatible when OPENAI_API_KEY is set, otherwise the
 *           deterministic offline mock planner. (Can be forced with LLM_PROVIDER.)
 *  - Data:  Supabase/Postgres when DATABASE_URL is set, otherwise local SQLite.
 * No secrets are ever hardcoded; everything below is read from process.env.
 */

export function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

export function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The configured OpenAI API key, or "" when none is set. */
export function openaiApiKey(): string {
  return (process.env.OPENAI_API_KEY ?? "").trim();
}
export function openAiBaseUrl(): string {
  return envStr("OPENAI_BASE_URL", "https://api.openai.com/v1");
}
export function openAiModel(): string {
  return envStr("OPENAI_MODEL", "gpt-4o-mini");
}

/** Supabase/Postgres connection string, or "" when unset. */
export function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

export function sqlitePath(): string {
  return envStr("DATABASE_PATH", "./data/app.db");
}

/**
 * Which LLM backend is active.
 *  - explicit LLM_PROVIDER=mock|openai is honoured, EXCEPT openai-without-a-key,
 *    which safely falls back to mock (the OpenAI client would otherwise throw);
 *  - otherwise auto: openai when a key is present, else mock.
 */
export type LlmMode = "mock" | "openai";
export function llmMode(): LlmMode {
  const forced = envStr("LLM_PROVIDER", "").toLowerCase();
  if (forced === "mock") return "mock";
  if (forced === "openai" && openaiApiKey()) return "openai";
  return openaiApiKey() ? "openai" : "mock";
}

export type DbMode = "sqlite" | "postgres";
/** Postgres (Supabase) when a DATABASE_URL is provided, else local SQLite. */
export function dbMode(): DbMode {
  return databaseUrl() ? "postgres" : "sqlite";
}

export function agentMaxIterations(): number {
  return envInt("AGENT_MAX_ITERATIONS", 6);
}

export function approvalTtlMs(): number {
  return envInt("APPROVAL_TTL_HOURS", 72) * 60 * 60 * 1000;
}

const DEV_SESSION_SECRET = "dev-insecure-secret-change-me";

export function sessionSecret(): string {
  const secret = (process.env.SESSION_SECRET ?? "").trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      // Fail loudly instead of signing tokens with a public dev constant.
      throw new Error(
        "SESSION_SECRET is required in production (e.g. `openssl rand -hex 32`).",
      );
    }
    return DEV_SESSION_SECRET;
  }
  return secret;
}

/**
 * Resolve node builtins at runtime, without any static `node:*` import
 * reference: webpack resolves both `import x from "node:x"` and
 * `await import("node:x")` at build time, and both break the edge-runtime
 * compilation of src/instrumentation.ts, which imports this module. On
 * non-Node runtimes (edge) the raw .env fallback is simply skipped
 * (process.env is used instead).
 */
function loadNodeModules(): { fs: typeof import("node:fs"); path: typeof import("node:path") } | undefined {
  const getter = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (!getter) return undefined;
  const fs = getter("node:fs") as typeof import("node:fs") | undefined;
  const path = getter("node:path") as typeof import("node:path") | undefined;
  return fs && path ? { fs, path } : undefined;
}

/** Read a value straight from a raw .env file (used at boot, before Next loads env). */
function envFileValue(dir: string, filenames: string[], key: string): string | undefined {
  const mods = loadNodeModules();
  if (!mods) return undefined;
  for (const name of filenames) {
    try {
      const text = mods.fs.readFileSync(mods.path.join(dir, name), "utf8");
      const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    } catch {
      /* file absent — keep looking */
    }
  }
  return undefined;
}

/**
 * Production readiness check, run from src/instrumentation.ts at boot.
 * - SESSION_SECRET must be set (never the dev constant) or the process exits.
 * - A mock LLM in production is a misconfiguration, not a crash: warn loudly.
 * Reads raw .env files because at build/boot time Next has not loaded them
 * into process.env yet; process.env wins when present (runtime mode).
 */
export function assertProductionReady(): void {
  if (process.env.NODE_ENV !== "production") return;
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    envFileValue(process.cwd(), [".env.production", ".env"], "SESSION_SECRET");
  if (!secret || secret === DEV_SESSION_SECRET) {
    throw new Error(
      "REFUSING TO START: SESSION_SECRET must be set to a long random string in production (SESSION_SECRET=... or .env.production).",
    );
  }
  const llmProvider =
    process.env.LLM_PROVIDER?.trim().toLowerCase() ||
    envFileValue(process.cwd(), [".env.production", ".env"], "LLM_PROVIDER")?.toLowerCase();
  const hasKey =
    !!(process.env.OPENAI_API_KEY ?? "").trim() ||
    !!envFileValue(process.cwd(), [".env.production", ".env"], "OPENAI_API_KEY");
  if (llmProvider === "mock" || (!hasKey && !llmProvider)) {
    // eslint-disable-next-line no-console
    console.warn(
      "[aurora] WARNING: production is running with the MOCK LLM planner — chat replies will be canned. Set OPENAI_API_KEY (or LLM_PROVIDER) for real answers.",
    );
  }
}

export function appUrl(): string {
  return envStr("APP_URL", "http://localhost:3000");
}

export interface RuntimeConfig {
  llm: LlmMode;
  db: DbMode;
  openAiModel: string;
  openAiBaseUrl: string;
  sqlitePath: string;
  hasOpenAiKey: boolean;
  hasDatabaseUrl: boolean;
  agentMaxIterations: number;
}

export function runtimeSummary(): RuntimeConfig {
  return {
    llm: llmMode(),
    db: dbMode(),
    openAiModel: openAiModel(),
    openAiBaseUrl: openAiBaseUrl(),
    sqlitePath: sqlitePath(),
    hasOpenAiKey: !!openaiApiKey(),
    hasDatabaseUrl: !!databaseUrl(),
    agentMaxIterations: agentMaxIterations(),
  };
}

/**
 * Log once per process which backends are active. Never logs key/URL values -
 * only their presence - so secrets stay out of the logs.
 */
let logged = false;
export function logRuntimeMode(): void {
  if (logged || process.env.NODE_ENV === "test") return;
  logged = true;
  const c = runtimeSummary();
  // Warn if the user asked for OpenAI but no key is present (we fall back to mock).
  const forced = envStr("LLM_PROVIDER", "").toLowerCase();
  if (forced === "openai" && !c.hasOpenAiKey) {
    // eslint-disable-next-line no-console
    console.warn("[aurora] LLM_PROVIDER=openai but OPENAI_API_KEY is empty -> using MOCK planner.");
  }
  const llmDetail =
    c.llm === "openai"
      ? `model=${c.openAiModel} base=${c.openAiBaseUrl}`
      : "deterministic offline planner (no OPENAI_API_KEY)";
  const dbDetail =
    c.db === "postgres"
      ? "Supabase/Postgres (DATABASE_URL set)"
      : `local SQLite at ${c.sqlitePath}`;
  const notifyDetail =
    notificationsEnabled()
      ? resendApiKey()
        ? "enabled (Resend key set)"
        : "enabled (no RESEND_API_KEY; notifications are no-ops)"
      : "disabled";
  // eslint-disable-next-line no-console
  console.info(
    [
      "[aurora] ───────────────────────────────",
      "[aurora] runtime mode",
      `[aurora]   LLM:    ${c.llm.toUpperCase().padEnd(7)} ${llmDetail}`,
      `[aurora]   Data:   ${c.db.padEnd(7)} ${dbDetail}`,
      `[aurora]   Track:  ${trackingProvider().padEnd(7)} ${easypostApiKey() ? "(EasyPost key set)" : "(mock carrier data)"}`,
      `[aurora]   Notify: ${notifyDetail}`,
      `[aurora]   Stripe: ${stripeSecretKey() ? "key set (live refunds)" : "no key (DB-only refunds)"}`,
      `[aurora]   Queue:  ${queueProvider().padEnd(7)} retries=${jobMaxRetries()} backoff=${jobRetryBackoffMs()}ms`,
      `[aurora]   max tool iterations: ${c.agentMaxIterations}`,
      "[aurora]   (set OPENAI_API_KEY / DATABASE_URL / provider keys to switch to real services)",
      "[aurora] ───────────────────────────────",
    ].join("\n"),
  );
}

/* -------------------------------------------------------------------------- */
/*  Observability (blueprint §10)                                             */
/* -------------------------------------------------------------------------- */

/** Metrics exporter on a localhost-only port; disabled only on explicit false. */
export function metricsEnabled(): boolean {
  const v = (process.env.METRICS_ENABLED ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

export function metricsPort(): number {
  const n = parseInt(process.env.METRICS_PORT ?? "9090", 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 9090;
}

/** Readiness-probe cache TTL (blueprint: 30s default). 0 disables caching. */
export function healthCheckIntervalMs(): number {
  const n = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS ?? "30000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

/* -------------------------------------------------------------------------- */
/*  Integrations (blueprint §5) — all key-gated; offline stays zero-config    */
/* -------------------------------------------------------------------------- */

// --- LLM hardening (§5.1) ---------------------------------------------------

/** Per-call timeout for the OpenAI provider (retries run within this window). */
export function llmTimeoutMs(): number {
  const n = parseInt(process.env.LLM_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/** Per-turn cost guardrail in CENTS (default $1.00); the turn aborts above it. */
export function llmMaxCostCents(): number {
  const n = parseInt(process.env.LLM_MAX_COST_CENTS ?? "100", 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

// --- Stripe refunds (§5.4) ----------------------------------------------------

export function stripeSecretKey(): string {
  return envStr("STRIPE_SECRET_KEY", "");
}

/** Overridable for tests/compat gateways. */
export function stripeApiBase(): string {
  return envStr("STRIPE_API_BASE", "https://api.stripe.com/v1");
}

// --- EasyPost tracking (§5.3) -------------------------------------------------

export function easypostApiKey(): string {
  return envStr("EASYPOST_API_KEY", "");
}

export function easypostApiBase(): string {
  return envStr("EASYPOST_API_BASE", "https://api.easypost.com");
}

/** Explicit TRACKING_PROVIDER wins; otherwise easypost is used iff a key is set. */
export function trackingProvider(): "mock" | "easypost" {
  const forced = envStr("TRACKING_PROVIDER", "").toLowerCase();
  if (forced === "easypost" || forced === "mock") return forced;
  return easypostApiKey() ? "easypost" : "mock";
}

// --- Resend notifications (§5.5) ----------------------------------------------

export function resendApiKey(): string {
  return envStr("RESEND_API_KEY", "");
}

/** Overridable for tests/compat gateways. */
export function resendApiBase(): string {
  return envStr("RESEND_API_BASE", "https://api.resend.com");
}

/** Default on; notifications are still no-ops without a RESEND_API_KEY. */
export function notificationsEnabled(): boolean {
  const v = (process.env.NOTIFICATIONS_ENABLED ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

export function notificationsFrom(): string {
  return envStr("NOTIFICATIONS_FROM", "Aurora Support <noreply@aurora-support.local>");
}

function emailList(name: string): string[] {
  return envStr(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Comma-separated recipients for approval alerts. */
export function adminEmailList(): string[] {
  return emailList("ADMIN_EMAIL_LIST");
}

/** Comma-separated recipients for ticket updates. */
export function supportTeamEmailList(): string[] {
  return emailList("SUPPORT_TEAM_EMAIL_LIST");
}

// --- Background job queue (§5.6) ----------------------------------------------

export function queueProvider(): "memory" | "redis" {
  const v = envStr("QUEUE_PROVIDER", "memory").toLowerCase();
  return v === "redis" ? "redis" : "memory";
}

export function jobMaxRetries(): number {
  const n = parseInt(process.env.JOB_MAX_RETRIES ?? "3", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

/** Exponential backoff base: base, base*2, base*4 ... (default 1s → 2s → 4s). */
export function jobRetryBackoffMs(): number {
  const n = parseInt(process.env.JOB_RETRY_BACKOFF_MS ?? "1000", 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/* -------------------------------------------------------------------------- */
/*  Reliability (blueprint §7.6 / §8)                                          */
/* -------------------------------------------------------------------------- */

/** Per-request timeout for provider HTTP calls (default 10s). */
export function providerTimeoutMs(): number {
  const n = parseInt(process.env.PROVIDER_TIMEOUT_MS ?? "10000", 10);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/** Transient-failure retries for provider calls (default 3, i.e. 4 attempts). */
export function providerMaxRetries(): number {
  const n = envInt("PROVIDER_MAX_RETRIES", 3);
  return n >= 0 && n <= 10 ? n : 3;
}

/** Exponential backoff base for provider retries (default 1s → 2s → 4s). */
export function providerRetryBackoffMs(): number {
  const n = envInt("PROVIDER_RETRY_BACKOFF_MS", 1000);
  return n > 0 ? n : 1000;
}

/** Chat messages per customer per hour (default 20, blueprint §7.6). */
export function rateLimitMsgPerHour(): number {
  return envInt("RATE_LIMIT_MSG_PER_HOUR", 20);
}

/** Refund requests per customer per day (default 5, blueprint §7.6). */
export function rateLimitRefundPerDay(): number {
  return envInt("RATE_LIMIT_REFUND_PER_DAY", 5);
}

/** API calls per IP per minute across all /api routes (default 100, §7.6). */
export function rateLimitApiPerMin(): number {
  return envInt("RATE_LIMIT_API_PER_MIN", 100);
}

export function rateLimitProvider(): "memory" | "redis" {
  const v = envStr("RATE_LIMIT_PROVIDER", "memory").toLowerCase();
  return v === "redis" ? "redis" : "memory";
}

/** Cumulative LLM spend per customer per day, in CENTS (default $50). */
export function llmDailyCostCents(): number {
  return envInt("LLM_DAILY_COST_CENTS", 5000);
}

/* -------------------------------------------------------------------------- */
/*  Identity lifecycle (blueprint §7.1 / §7.4)                                 */
/* -------------------------------------------------------------------------- */

function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return def;
}

export function registrationEnabled(): boolean {
  return envBool("REGISTRATION_ENABLED", true);
}

export function emailVerificationRequired(): boolean {
  return envBool("EMAIL_VERIFICATION_REQUIRED", true);
}

export function passwordMinLength(): number {
  const n = parseInt(process.env.PASSWORD_MIN_LENGTH ?? "8", 10);
  return Number.isFinite(n) && n >= 6 ? n : 8;
}

/** Absolute session lifetime (default 7 days). */
export function sessionExpiresMs(): number {
  const def = 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(process.env.SESSION_EXPIRES_MS ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Email-verification link TTL (default 24h). */
export function emailVerificationTtlMs(): number {
  const def = 24 * 60 * 60 * 1000;
  const n = parseInt(process.env.EMAIL_VERIFICATION_TTL_MS ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Password-reset link TTL (default 1h). */
export function passwordResetTtlMs(): number {
  const def = 60 * 60 * 1000;
  const n = parseInt(process.env.PASSWORD_RESET_TTL_MS ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
