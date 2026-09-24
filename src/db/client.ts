import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import * as pgSchema from "./schema.pg";
import { databaseUrl } from "@/lib/env";
import { migrationsDir, runSqliteMigrations } from "./migration-runner";

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type PgDatabase = PostgresJsDatabase<typeof pgSchema>;

/** Returns the SQLite file path from env, defaulting to ./data/app.db. */
export function resolveDbPath(): string {
  const raw = process.env.DATABASE_PATH || "./data/app.db";
  const p = path.resolve(raw);
  if (p !== ":memory:") {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  return p;
}

/**
 * Idempotent forward migrations for databases created before a column existed
 * (CREATE TABLE IF NOT EXISTS in schema.sql does not add columns to an existing
 * table). Each is guarded so it is a no-op once applied.
 */
function applyMigrations(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(support_tickets)").all() as { name: string }[]).map((r) => r.name),
  );
  if (!cols.has("internal_notes")) {
    db.exec("ALTER TABLE support_tickets ADD COLUMN internal_notes TEXT");
  }
}

/**
 * Apply the base schema DDL (tests / in-memory databases). Idempotent.
 * The canonical base DDL is migrations/001_initial.sql — the same file the
 * versioned runner applies at boot, so tests and the server never drift.
 */
export function applySchema(db: Database.Database): void {
  const sqlFile = path.join(migrationsDir(), "001_initial.sql");
  const sql = fs.readFileSync(sqlFile, "utf8");
  db.exec(sql);
  applyMigrations(db);
}

let _db: Database.Database | undefined;

/**
 * Process-wide SQLite handle for the server (dev/prod). Tests create their own
 * in-memory databases via createDb(":memory:") so they stay isolated.
 */
export function getDbFile(): Database.Database {
  if (!_db) {
    const p = resolveDbPath();
    _db = new Database(p);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    // Versioned migrations at first use (blueprint §6.2); no-ops when current.
    runSqliteMigrations(_db);
    hardenFilePermissions(p);
  }
  return _db;
}

/**
 * Restrict the database file (and WAL sidecars) to the owning user on unix
 * hosts: it contains password hashes, session tokens and chat PII, and
 * better-sqlite3 otherwise creates it with the process umask (often 0644).
 * No-op on Windows and for in-memory databases.
 */
function hardenFilePermissions(p: string): void {
  if (process.platform === "win32" || p === ":memory:") return;
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* WAL/SHM sidecars may not exist yet */
    }
  }
}

export function getDb(): AppDatabase {
  return drizzle(getDbFile(), { schema });
}

export interface DbPair {
  db: AppDatabase;
  raw: Database.Database;
}

/**
 * Create a fresh, isolated database. Used by tests.
 * @param fileOrMemory  pass ":memory:" for a transient db.
 */
export function createDb(fileOrMemory?: string): DbPair {
  const p = fileOrMemory ?? ":memory:";
  const raw = new Database(p);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applySchema(raw);
  return { db: drizzle(raw, { schema }), raw };
}

/** Close the server handle (useful for clean shutdown in scripts/tests). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Postgres / Supabase (used only when DATABASE_URL is set)                  */
/* -------------------------------------------------------------------------- */

let _pg: postgres.Sql | undefined;
let _pgDb: PgDatabase | undefined;

/**
 * Process-wide Postgres/Supabase handle. Reads DATABASE_URL (the Supabase
 * connection string). The schema is applied at boot by the versioned
 * migration runner (see migration-runner.ts), not here.
 */
export function getPostgresDb(): PgDatabase {
  if (!_pgDb) {
    const url = databaseUrl();
    if (!url) {
      throw new Error("DATABASE_URL is not set; Postgres/Supabase mode requires it.");
    }
    // Pool grows lazily up to `max` (postgres-js has no min setting); 20 is
    // the production ceiling (blueprint §5.2).
    _pg = postgres(url, { max: 20, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} });
    _pgDb = drizzlePg(_pg, { schema: pgSchema });
  }
  return _pgDb;
}

export async function closePostgres(): Promise<void> {
  if (_pg) {
    await _pg.end({ timeout: 5 });
    _pg = undefined;
    _pgDb = undefined;
  }
}
