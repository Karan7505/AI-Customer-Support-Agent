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
 * `next dev`. Migrations instead run at first database use — before any other
 * DB work (src/db/client.ts → runSqliteMigrations) — which is fail-closed:
 * a failing or tampered migration makes every DB-backed request 500 until
 * fixed, and `npm run db:migrate` surfaces the error explicitly.
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

  // Postgres mode: fail fast at boot if the database is unreachable
  // (blueprint §5.2). Reachability probe only — see postgres-check.ts for
  // the edge-safety rationale and the credential-validation boundary.
  if (process.env.DATABASE_URL) {
    const { checkPostgresBoot } = await import("@/db/postgres-check");
    await checkPostgresBoot();
  }
}
