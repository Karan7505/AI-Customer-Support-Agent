import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** Returns the SQLite file path from env, defaulting to ./data/app.db. */
export function resolveDbPath(): string {
  const raw = process.env.DATABASE_PATH || "./data/app.db";
  const p = path.resolve(raw);
  if (p !== ":memory:") {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  return p;
}

/** Apply the schema DDL. Idempotent (uses CREATE TABLE IF NOT EXISTS). */
export function applySchema(db: Database.Database): void {
  const sqlFile = path.resolve(process.cwd(), ".db", "schema.sql");
  const sql = fs.readFileSync(sqlFile, "utf8");
  db.exec(sql);
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
