import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import * as pgSchema from "./schema.pg";
import { databaseUrl } from "@/lib/env";

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

/** Apply the schema DDL. Idempotent (uses CREATE TABLE IF NOT EXISTS). */
export function applySchema(db: Database.Database): void {
  const sqlFile = path.resolve(process.cwd(), ".db", "schema.sql");
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
    applySchema(_db);
  }
  return _db;
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
 * connection string) and applies the Postgres schema on first use.
 */
export function getPostgresDb(): PgDatabase {
  if (!_pgDb) {
    const url = databaseUrl();
    if (!url) {
      throw new Error("DATABASE_URL is not set; Postgres/Supabase mode requires it.");
    }
    _pg = postgres(url, { max: 5, onnotice: () => {} });
    _pgDb = drizzlePg(_pg, { schema: pgSchema });
  }
  return _pgDb;
}

/**
 * Idempotent forward migrations for Postgres (CREATE TABLE IF NOT EXISTS in
 * schema.pg.sql does not add columns to an existing table).
 */
const PG_MIGRATIONS = `
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

/** Apply the Postgres DDL. Idempotent (CREATE TABLE/INDEX IF NOT EXISTS). */
export async function applyPgSchema(): Promise<void> {
  getPostgresDb(); // ensure the client is initialised
  if (!_pg) throw new Error("Postgres client not initialised");
  const sqlFile = path.resolve(process.cwd(), ".db", "schema.pg.sql");
  const sql = fs.readFileSync(sqlFile, "utf8");
  // postgres-js simple-query protocol supports multiple statements in one call.
  await _pg.unsafe(sql);
  await _pg.unsafe(PG_MIGRATIONS);
}

export async function closePostgres(): Promise<void> {
  if (_pg) {
    await _pg.end({ timeout: 5 });
    _pg = undefined;
    _pgDb = undefined;
  }
}
