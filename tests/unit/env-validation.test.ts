import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateProductionEnv, assertProductionEnv } from "@/lib/env-validation";

const VALID = {
  NODE_ENV: "production",
  // localhost host: the pre-commit credential guard rejects non-localhost
  // postgres connection strings in the repo.
  DATABASE_URL: "postgres://user:pw@localhost:5432/aurora",
  SESSION_SECRET: "boot-secret-0123456789abcdef0123",
};

describe("validateProductionEnv (blueprint §11.2)", () => {
  it("accepts a valid production environment", () => {
    expect(validateProductionEnv(VALID)).toEqual([]);
  });

  it("accepts the postgresql:// scheme", () => {
    expect(validateProductionEnv({ ...VALID, DATABASE_URL: "postgresql://u:p@localhost:5432/db" })).toEqual([]);
  });

  it("rejects a missing DATABASE_URL", () => {
    const issues = validateProductionEnv({ ...VALID, DATABASE_URL: "" });
    expect(issues.some((i) => i.path === "DATABASE_URL")).toBe(true);
  });

  it("rejects a non-Postgres DATABASE_URL (production is Postgres-only)", () => {
    for (const url of ["mysql://u:p@h:3306/db", "sqlite:///data/app.db", "http://x"]) {
      const issues = validateProductionEnv({ ...VALID, DATABASE_URL: url });
      expect(issues.some((i) => i.path === "DATABASE_URL")).toBe(true);
    }
  });

  it("rejects an empty or placeholder SESSION_SECRET", () => {
    expect(validateProductionEnv({ ...VALID, SESSION_SECRET: "" }).some((i) => i.path === "SESSION_SECRET")).toBe(true);
    expect(
      validateProductionEnv({ ...VALID, SESSION_SECRET: "change-me-to-a-long-random-string" }).some(
        (i) => i.path === "SESSION_SECRET",
      ),
    ).toBe(true);
  });

  it("rejects a non-production NODE_ENV", () => {
    const issues = validateProductionEnv({ ...VALID, NODE_ENV: "development" });
    expect(issues.some((i) => i.path === "NODE_ENV")).toBe(true);
  });
});

describe("assertProductionEnv boot gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("no-ops outside production (dev stays zero-config)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("throws with every issue when the production env is invalid", () => {
    // Empty cwd so no stray .env file can rescue the resolution.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envval-"));
    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_SECRET", "");
      expect(() => assertProductionEnv()).toThrow(/REFUSING TO START/);
      expect(() => assertProductionEnv()).toThrow(/DATABASE_URL/);
      expect(() => assertProductionEnv()).toThrow(/SESSION_SECRET/);
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes with a valid production env", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", VALID.DATABASE_URL);
    vi.stubEnv("SESSION_SECRET", VALID.SESSION_SECRET);
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("resolves values from a raw .env file (Next boot order)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envval-"));
    const oldCwd = process.cwd();
    try {
      fs.writeFileSync(
        path.join(dir, ".env"),
        `DATABASE_URL=${VALID.DATABASE_URL}\nSESSION_SECRET=${VALID.SESSION_SECRET}\n`,
      );
      process.chdir(dir);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DATABASE_URL", "");
      vi.stubEnv("SESSION_SECRET", "");
      expect(() => assertProductionEnv()).not.toThrow();
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
