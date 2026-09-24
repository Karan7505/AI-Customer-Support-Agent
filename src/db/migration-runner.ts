/**
 * Versioned schema migrations (blueprint §6.2).
 *
 * Migration files live in <repo root>/migrations and are named
 * `NNN_name.sql` (SQLite) / `NNN_name.pg.sql` (Postgres). They are applied:
 *   - in numeric order, once each, each inside a single transaction;
 *   - tracked in a `migrations` table (name, sha256 checksum, applied_at);
 *   - verified by checksum on every run: editing an already-applied file
 *     fails the run (migrations are immutable once applied).
 *
 * The server applies pending migrations at first database use, BEFORE any
 * other DB work (src/db/client.ts opens the handle through this runner);
 * a failing or tampered migration makes every DB-backed request fail
 * closed. `npm run db:migrate` runs the same code path manually.
 *
 * Tests use the plain DDL path (createDb/applySchema) and do not touch the
 * migrations table.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import postgres from "postgres";
import { databaseUrl } from "@/lib/env";

const MIGRATIONS_TABLE_SQLITE = `
CREATE TABLE IF NOT EXISTS migrations (
  name       TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

const MIGRATIONS_TABLE_PG = `
CREATE TABLE IF NOT EXISTS "migrations" (
  "name"      TEXT PRIMARY KEY,
  "checksum"  TEXT NOT NULL,
  "appliedAt" INTEGER NOT NULL
);
`;

/**
 * Legacy forward guards for databases created before versioned migrations
 * existed (CREATE TABLE IF NOT EXISTS never adds columns to existing tables).
 * Each statement is a no-op once applied.
 */
const LEGACY_SQLITE = `
ALTER TABLE support_tickets ADD COLUMN internal_notes TEXT;
`;
const LEGACY_PG = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'support_tickets' AND column_name = 'internalNotes'
  ) THEN
    ALTER TABLE "support_tickets" ADD COLUMN "internalNotes" TEXT;
  END IF;
END $$;
`;

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function migrationsDir(): string {
  const fromCwd = path.resolve(process.cwd(), "migrations");
  if (fs.existsSync(fromCwd)) return fromCwd;
  // Fallback for environments where CWD is not the repo root.
  return path.resolve(__dirname, "..", "..", "migrations");
}

function loadMigrations(driver: "sqlite" | "postgres"): Migration[] {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`[migrate] migrations directory not found: ${dir}`);
  }
  const isTarget = (f: string) =>
    driver === "postgres" ? f.endsWith(".pg.sql") : f.endsWith(".sql") && !f.endsWith(".pg.sql");
  return fs
    .readdirSync(dir)
    .filter(isTarget)
    .sort() // zero-padded numeric prefixes sort lexicographically
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      return { name: f, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

function checksumMismatch(name: string): Error {
  return new Error(
    `[migrate] checksum mismatch for ${name}: an already-applied migration file was modified. ` +
      `Restore the original file or fix the database manually; never edit applied migrations.`,
  );
}

/**
 * Apply pending SQLite migrations to an open handle.
 * Returns the number of newly applied migrations. Throws on any failure
 * (including checksum mismatch), which fails boot.
 */
export function runSqliteMigrations(db: Database.Database): number {
  db.exec(MIGRATIONS_TABLE_SQLITE);
  const rows = db
    .prepare("SELECT name, checksum FROM migrations")
    .all() as { name: string; checksum: string }[];
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const insert = db.prepare(
    "INSERT INTO migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
  );
  let count = 0;
  for (const m of loadMigrations("sqlite")) {
    const prev = applied.get(m.name);
    if (prev !== undefined) {
      if (prev !== m.checksum) throw checksumMismatch(m.name);
      continue;
    }
    const applyOne = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.name, m.checksum, Date.now());
    });
    applyOne();
    count++;
    console.log(`[migrate] applied ${m.name} (sqlite)`);
  }
  // Legacy column guard for pre-versioning databases (no-op otherwise).
  const cols = new Set(
    (db.prepare("PRAGMA table_info(support_tickets)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (cols.size > 0 && !cols.has("internal_notes")) {
    db.exec(LEGACY_SQLITE);
    console.log("[migrate] legacy column guard applied (internal_notes)");
  }
  return count;
}

/**
 * Apply pending Postgres migrations on a short-lived dedicated connection
 * (independent of the app pool). Returns the number newly applied.
 */
export async function runPostgresMigrations(): Promise<number> {
  const url = databaseUrl();
  if (!url) {
    throw new Error("[migrate] DATABASE_URL is not set; cannot run Postgres migrations.");
  }
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await pg.unsafe(MIGRATIONS_TABLE_PG);
    const rows: { name: string; checksum: string }[] =
      await pg`SELECT "name", "checksum" FROM "migrations"`;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    let count = 0;
    for (const m of loadMigrations("postgres")) {
      const prev = applied.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) throw checksumMismatch(m.name);
        continue;
      }
      // postgres-js simple-query protocol: one multi-statement batch per file.
      await pg.unsafe(`BEGIN;\n${m.sql}\nCOMMIT;`);
      await pg`INSERT INTO "migrations" ("name", "checksum", "appliedAt") VALUES (${m.name}, ${m.checksum}, ${Date.now()})`;
      count++;
      console.log(`[migrate] applied ${m.name} (postgres)`);
    }
    // Legacy column guard for pre-versioning databases (no-op otherwise).
    await pg.unsafe(LEGACY_PG);
    return count;
  } finally {
    await pg.end({ timeout: 5 });
  }
}
