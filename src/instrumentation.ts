/**
 * Boot-time safety checks (Next.js instrumentation hook).
 * Runs once per process for the Node runtime — before the server accepts
 * traffic — and refuses to boot a production deployment with unsafe defaults
 * (missing SESSION_SECRET). See assertProductionReady in src/lib/env.ts.
 *
 * NOTE (blueprint §6.2): versioned schema migrations are deliberately NOT
 * run from here. Next.js compiles instrumentation for the edge runtime too,
 * where the native better-sqlite3 driver cannot be loaded (its require('fs')
 * is unresolvable in the edge bundle), so importing the DB layer here breaks
 * `next dev`. In production the deploy gate (§11.3) runs them in a separate
 * process instead: the Docker entrypoint executes `node migrate.mjs` (esbuild
 * bundle of scripts/migrate-cli.ts) BEFORE starting `server.js`. Locally,
 * migrations run at first database use — before any other DB work
 * (src/db/client.ts → runSqliteMigrations) — which is fail-closed: a failing
 * or tampered migration makes every DB-backed request 500 until fixed, and
 * `npm run db:migrate` surfaces the error explicitly.
 *
 * Everything this module imports must therefore stay edge-bundle-safe:
 * src/lib/env.ts resolves node:fs/node:path at runtime (process.getBuiltinModule)
 * for the same reason, and src/db/postgres-check.ts probes Postgres with a raw
 * TCP connect (node:net resolved at runtime) instead of importing the postgres
 * driver, whose net/tls requires are unresolvable in the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertProductionReady } = await import("@/lib/env");
  assertProductionReady();

  // Production env gate (§11.2): DATABASE_URL (Postgres) + SESSION_SECRET must
  // be valid before any traffic is accepted.
  const { assertProductionEnv } = await import("@/lib/env-validation");
  assertProductionEnv();

  // Postgres mode: fail-fast at boot when the DB is unreachable (§5.2)
  if (process.env.DATABASE_URL) {
    const { checkPostgresBoot } = await import("@/db/postgres-check");
    await checkPostgresBoot();
  }
}
