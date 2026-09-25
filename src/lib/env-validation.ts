import { z } from "zod";
import { envFileValue } from "./env";

/**
 * Production environment validation (blueprint §11.2).
 *
 * A production deployment MUST run against Postgres (DATABASE_URL) and MUST
 * have a real session secret. Every other variable is optional with a
 * documented default (see .env.example). Validation is fail-fast: the
 * process is refused BEFORE any traffic is accepted.
 *
 * Env resolution mirrors assertProductionReady in src/lib/env.ts: process.env
 * wins; at boot Next may not have loaded .env files yet, so a raw
 * .env.production / .env read is the fallback.
 *
 * This module is edge-bundle-safe (zod only) so it can be imported from
 * src/instrumentation.ts, which Next compiles for the edge runtime too.
 */

const PostgresUrl = z
  .string()
  .min(1, "DATABASE_URL is empty")
  .refine(
    (u) => u.startsWith("postgres://") || u.startsWith("postgresql://"),
    "DATABASE_URL must be a postgres:// or postgresql:// connection string (Postgres is required in production)",
  );

const SessionSecret = z
  .string()
  .min(1, "SESSION_SECRET is empty (generate one with: openssl rand -hex 32)")
  .refine(
    (s) => !s.includes("change-me"),
    "SESSION_SECRET is still the dev/example placeholder (generate one with: openssl rand -hex 32)",
  );

const ProductionEnv = z.object({
  NODE_ENV: z.literal("production", {
    message: "NODE_ENV must be exactly 'production' for a production deployment",
  }),
  DATABASE_URL: PostgresUrl,
  SESSION_SECRET: SessionSecret,
});

export interface ProductionEnvIssue {
  path: string;
  message: string;
}

function resolveEnvValue(key: string): string {
  const fromProcess = (process.env[key] ?? "").trim();
  if (fromProcess) return fromProcess;
  return (envFileValue(process.cwd(), [".env.production", ".env"], key) ?? "").trim();
}

/**
 * Validate a resolved production environment. Returns the list of issues
 * (empty when valid). Pure — no process.env access — so it is trivially
 * testable.
 */
export function validateProductionEnv(
  env: { NODE_ENV?: string; DATABASE_URL?: string; SESSION_SECRET?: string },
): ProductionEnvIssue[] {
  const result = ProductionEnv.safeParse({
    NODE_ENV: env.NODE_ENV ?? "",
    DATABASE_URL: env.DATABASE_URL ?? "",
    SESSION_SECRET: env.SESSION_SECRET ?? "",
  });
  if (result.success) return [];
  return result.error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

/**
 * Boot-time gate: resolve the production variables (process.env, then raw
 * .env files), validate them, and THROW with every issue on failure. The
 * throw propagates out of instrumentation register() and terminates the
 * process before the HTTP server accepts traffic (same fail mode as
 * assertProductionReady).
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  const issues = validateProductionEnv({
    NODE_ENV: "production",
    DATABASE_URL: resolveEnvValue("DATABASE_URL"),
    SESSION_SECRET: resolveEnvValue("SESSION_SECRET"),
  });
  if (issues.length === 0) return;
  const lines = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
  throw new Error(`REFUSING TO START: invalid production environment:\n${lines}\nSee .env.example for the expected variables.`);
}
