/**
 * Apply the schema to the configured SQLite file.
 *   npx tsx src/db/migrate.ts            # apply (idempotent)
 *   npx tsx src/db/migrate.ts --reset    # drop the file and rebuild
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDbPath } from "./client";
import Database from "better-sqlite3";

const reset = process.argv.includes("--reset");
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
const sql = fs.readFileSync(path.resolve(process.cwd(), ".db/schema.sql"), "utf8");
raw.exec(sql);
raw.close();
console.log(`[migrate] schema applied to ${p}`);
