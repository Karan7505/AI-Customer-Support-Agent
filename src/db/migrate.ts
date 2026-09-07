/**
 * Apply the schema to the active database driver.
 *   npx tsx src/db/migrate.ts            # apply (idempotent)
 *   npx tsx src/db/migrate.ts --reset    # SQLite only: drop the file + rebuild
 *
 * Driver selection is automatic:
 *   - DATABASE_URL set      -> Supabase/Postgres (applies .db/schema.pg.sql)
 *   - otherwise             -> local SQLite at DATABASE_PATH (default ./data/app.db)
 */
import fs from "node:fs";
import path from "node:path";
import { dbMode, logRuntimeMode } from "@/lib/env";
import { resolveDbPath, applyPgSchema, closePostgres } from "./client";
import Database from "better-sqlite3";

async function run() {
  logRuntimeMode();
  const reset = process.argv.includes("--reset");

  if (dbMode() === "postgres") {
    await applyPgSchema();
    console.log("[migrate] schema applied to Supabase/Postgres (DATABASE_URL).");
    await closePostgres();
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
  const sql = fs.readFileSync(path.resolve(process.cwd(), ".db", "schema.sql"), "utf8");
  raw.exec(sql);
  raw.close();
  console.log(`[migrate] schema applied to SQLite at ${p}`);
}

run().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
