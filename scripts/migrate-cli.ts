/**
 * Deploy-time migration gate (blueprint §11.3).
 *
 * Standalone Node script bundled by esbuild into the Docker image (see
 * Dockerfile) and executed by docker-entrypoint.sh BEFORE the server starts:
 *
 *   node migrate.mjs
 *
 * Exits non-zero (container never serves traffic) when DATABASE_URL is
 * missing/non-Postgres or any migration fails. The migrations directory is
 * resolved from the process cwd — the image ships it at /app/migrations.
 *
 * Never import this file (or anything it pulls in, e.g. the postgres driver)
 * from app code that Next bundles for the edge runtime.
 */
import { runPostgresMigrations } from "../src/db/migration-runner";

const dbUrl = (process.env.DATABASE_URL ?? "").trim();
if (!dbUrl) {
  console.error("[migrate] DATABASE_URL is not set — production requires a Postgres connection string.");
  process.exit(1);
}
if (!dbUrl.startsWith("postgres://") && !dbUrl.startsWith("postgresql://")) {
  console.error("[migrate] DATABASE_URL must be a postgres:// or postgresql:// URL.");
  process.exit(1);
}

try {
  const applied = await runPostgresMigrations();
  console.log(`[migrate] OK — ${applied} migration(s) applied; schema is up to date.`);
  process.exit(0);
} catch (e) {
  console.error("[migrate] FAILED — refusing to start the server:", e instanceof Error ? e.message : e);
  process.exit(1);
}
