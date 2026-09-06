/** Centralised, typed access to environment configuration. */

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

/** Which LLM backend to use: "mock" (deterministic, offline) or "openai". */
export function llmProvider(): "mock" | "openai" {
  const v = envStr("LLM_PROVIDER", "mock").toLowerCase();
  return v === "openai" ? "openai" : "mock";
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
