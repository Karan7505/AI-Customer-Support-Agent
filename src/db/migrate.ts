/**
 * Apply versioned schema migrations to the active database driver.
 *   npx tsx src/db/migrate.ts            # apply pending migrations (idempotent)
 *   npx tsx src/db/migrate.ts --reset    # SQLite only: drop the file + rebuild
 *
 * Driver selection is automatic:
 *   - DATABASE_URL set      -> Postgres/Supabase (migrations/*.pg.sql)
 *   - otherwise             -> local SQLite at DATABASE_PATH (migrations/*.sql)
 *
 * The same runner executes at server boot (src/instrumentation.ts), so this
 * script is the manual/dev convenience path; both share one code path.
 */
import fs from "node:fs";
import { dbMode, logRuntimeMode } from "@/lib/env";
import { resolveDbPath } from "./client";
import { runSqliteMigrations, runPostgresMigrations } from "./migration-runner";
import Database from "better-sqlite3";

async function run() {
  logRuntimeMode();
  const reset = process.argv.includes("--reset");

  if (dbMode() === "postgres") {
    const n = await runPostgresMigrations();
    console.log(`[migrate] ${n} migration(s) applied to Supabase/Postgres (DATABASE_URL).`);
    return;
  }

  // ---- SQLite ----
  const p = resolveDbPath();
  if (reset) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const f = p + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    console.log(`[migrate] removed ${p}`);
  }
  const raw = new Database(p);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  const n = runSqliteMigrations(raw);
  raw.close();
  console.log(`[migrate] ${n} migration(s) applied to SQLite at ${p}`);
}

run().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
