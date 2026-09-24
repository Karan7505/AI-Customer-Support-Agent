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
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionReady } = await import("@/lib/env");
    assertProductionReady();
  }
}
