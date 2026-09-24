import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runSqliteMigrations, migrationsDir } from "@/db/migration-runner";
import { applySchema } from "@/db/client";

const BASE = "001_initial.sql";
const EXPECTED_TABLES = [
  "customers",
  "orders",
  "support_tickets",
  "refunds",
  "approval_requests",
  "audit_logs",
  "sessions",
  "conversations",
  "messages",
];

const fresh = () => {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  return raw;
};

const tablesOf = (d: Database.Database) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();

describe("Versioned migrations (sqlite)", () => {
  let raw: Database.Database | undefined;
  afterEach(() => {
    raw?.close();
    raw = undefined;
  });

  it("applies the base migration and records name/checksum/timestamp", () => {
    raw = fresh();
    expect(runSqliteMigrations(raw)).toBe(3); // 001_initial + 002_audit_enrichment + 003_integration_columns
    expect(tablesOf(raw).sort()).toEqual([...EXPECTED_TABLES, "migrations"].sort());
    const row = raw.prepare("SELECT name, checksum, applied_at FROM migrations").get() as any;
    expect(row.name).toBe(BASE);
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row.applied_at).toBeGreaterThan(0);
  });

  it("is idempotent: a second run applies nothing", () => {
    raw = fresh();
    runSqliteMigrations(raw);
    expect(runSqliteMigrations(raw)).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) c FROM migrations").get() as any).c).toBe(3);
  });

  it("refuses to run when an applied migration was modified (checksum mismatch)", () => {
    const db = fresh();
    raw = db;
    runSqliteMigrations(db);
    db.prepare("UPDATE migrations SET checksum = 'deadbeef'").run();
    expect(() => runSqliteMigrations(db)).toThrow(/checksum mismatch/);
  });

  it("refuses to run on invalid SQL and leaves the failed migration unapplied", () => {
    const db = fresh();
    raw = db;
    const bad = path.join(migrationsDir(), "999_tmp_bad.sql");
    runSqliteMigrations(db); // base migrations apply while the directory is clean
    fs.writeFileSync(bad, "CREATE TABLE no_such_syntax (;\n");
    try {
      expect(() => runSqliteMigrations(db)).toThrow(); // the bad 999 migration fails the run
      const names = (db.prepare("SELECT name FROM migrations").all() as any[]).map((r) => r.name);
      expect(names).toEqual([BASE, "002_audit_enrichment.sql", "003_integration_columns.sql"]); // failed migration NOT recorded → retriable
    } finally {
      if (fs.existsSync(bad)) fs.rmSync(bad);
    }
  });

  it("applies the legacy column guard to pre-versioning databases", () => {
    raw = fresh();
    // Simulate an old database: table exists but predates internal_notes.
    raw.exec(
      "CREATE TABLE support_tickets (id TEXT PRIMARY KEY, customer_id TEXT, order_id TEXT, subject TEXT, description TEXT, priority TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)",
    );
    runSqliteMigrations(raw);
    const cols = (raw.prepare("PRAGMA table_info(support_tickets)").all() as any[]).map((r) => r.name);
    expect(cols).toContain("internal_notes");
  });

  it("plain DDL path (tests) yields the same tables as the versioned runner", () => {
    const a = fresh();
    const b = fresh();
    applySchema(a);
    runSqliteMigrations(b);
    expect(tablesOf(a)).toEqual(tablesOf(b).filter((t) => t !== "migrations"));
    a.close();
    b.close();
  });
});
