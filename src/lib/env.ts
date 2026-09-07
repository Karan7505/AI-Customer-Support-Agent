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

export function sessionSecret(): string {
  return envStr("SESSION_SECRET", "dev-insecure-secret-change-me");
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
  // eslint-disable-next-line no-console
  console.info(
    [
      "[aurora] ───────────────────────────────",
      `[aurora] runtime mode`,
      `[aurora]   LLM:    ${c.llm.toUpperCase().padEnd(7)} ${llmDetail}`,
      `[aurora]   Data:   ${c.db.padEnd(7)} ${dbDetail}`,
      `[aurora]   max tool iterations: ${c.agentMaxIterations}`,
      `[aurora]   (set OPENAI_API_KEY and/or DATABASE_URL to switch to real services)`,
      `[aurora] ───────────────────────────────`,
    ].join("\n"),
  );
}
