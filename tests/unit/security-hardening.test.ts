import { describe, it, expect, vi, afterEach } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEnv, principal } from "../helpers";
import { hashPassword, verifyPassword, safeEqual, randomToken } from "@/lib/security";
import { login, getPrincipal, DEMO_PASSWORD, SESSION_COOKIE } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { authorize } from "@/lib/policy";
import { runTool } from "@/lib/tools";
import { allowRequest, resetRateLimits } from "@/lib/rate-limit";
import { genId } from "@/lib/ids";
import { assertProductionReady, sessionSecret } from "@/lib/env";
import nextConfig from "../../next.config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetRateLimits();
});

describe("F1: demo password is a dev-only convenience", () => {
  it("works outside production", async () => {
    const env = makeEnv();
    const res = await login(env.repo, "jane@t.com", DEMO_PASSWORD);
    expect(res.principal.id).toBe("CUST-1");
  });

  it("is REJECTED when NODE_ENV=production for accounts with a different real password", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const env = makeEnv();
    // Give CUST-2 a real, non-demo password so the demo string is not its
    // legitimate password.
    env.raw
      .prepare("UPDATE customers SET password_hash = ? WHERE id = 'CUST-2'")
      .run(hashPassword("alex-real-pw-9x"));
    // The shared demo password must NOT work in production...
    await expect(login(env.repo, "alex@t.com", DEMO_PASSWORD)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    // ...but the account's real password does.
    const real = await login(env.repo, "alex@t.com", "alex-real-pw-9x");
    expect(real.principal.id).toBe("CUST-2");
  });
});

describe("F7: login errors do not reveal which part failed", () => {
  it("returns the identical message for unknown email and wrong password", async () => {
    const env = makeEnv();
    const unknown = await login(env.repo, "nobody@t.com", "whatever123").catch((e) => e);
    const wrongPw = await login(env.repo, "jane@t.com", "wrongpass1").catch((e) => e);
    expect(unknown).toBeInstanceOf(AppError);
    expect(wrongPw).toBeInstanceOf(AppError);
    expect((unknown as AppError).message).toBe((wrongPw as AppError).message);
    expect((unknown as AppError).message).toBe("Invalid email or password.");
  });
});

describe("F12: password hashing strength + legacy compatibility", () => {
  it("hashes with 600k iterations and verifies", () => {
    const stored = hashPassword("s3cret-pw");
    expect(stored).toMatch(/^pbkdf2\$600000\$[0-9a-f]{32}\$/);
    expect(verifyPassword("s3cret-pw", stored)).toBe(true);
    expect(verifyPassword("s3cret-pw!", stored)).toBe(false);
  });

  it("still verifies legacy 120k-iteration hashes", () => {
    const salt = randomBytes(8);
    const hash = pbkdf2Sync("legacy-pw", salt, 120_000, 32, "sha256").toString("hex");
    const legacy = `pbkdf2$120000$${salt.toString("hex")}$${hash}`;
    expect(verifyPassword("legacy-pw", legacy)).toBe(true);
    expect(verifyPassword("nope", legacy)).toBe(false);
  });

  it("safeEqual is constant-time equality", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("F6: session secret enforcement + token signature verification", () => {
  it("sessionSecret() falls back to the dev constant only outside production", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(sessionSecret()).toBe("dev-insecure-secret-change-me");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET is required in production/);
  });

  it("accepts a properly signed token and rejects a mismatched signature", async () => {
    const env = makeEnv();
    // Valid: token issued by login() verifies against the DB row.
    const { token } = await login(env.repo, "jane@t.com", DEMO_PASSWORD);
    expect(await getPrincipal(env.repo, token)).toMatchObject({ id: "CUST-1" });

    // Forged: DB row exists, but the HMAC portion does not match.
    const forged = randomToken(16) + ".deadbeefdeadbeef";
    await env.repo.createSession({
      token: forged,
      customerId: "CUST-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(await getPrincipal(env.repo, forged)).toBeNull();
    // The mismatched row is revoked on detection.
    expect(await env.repo.getSession(forged)).toBeUndefined();
  });

  it("SESSION_COOKIE is a stable constant", () => {
    expect(SESSION_COOKIE).toBeTruthy();
  });
});

describe("Boot gate: production start is refused with an unsafe SESSION_SECRET", () => {
  const savedCwd = process.cwd();
  afterEach(() => {
    process.chdir(savedCwd);
  });

  it("accepts the secret from process.env or a raw .env file, rejects nothing/dev-constant", () => {
    vi.stubEnv("NODE_ENV", "production");
    // Work in an empty temp dir so the raw .env file reads are deterministic.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-bootgate-"));
    process.chdir(tmp);
    try {
      // No secret anywhere -> refuses to boot.
      vi.stubEnv("SESSION_SECRET", "");
      expect(() => assertProductionReady()).toThrow(/SESSION_SECRET/);

      // The public dev constant is never an acceptable production secret.
      vi.stubEnv("SESSION_SECRET", "dev-insecure-secret-change-me");
      expect(() => assertProductionReady()).toThrow(/SESSION_SECRET/);

      // A secret in a raw .env file (node:fs read path) is accepted.
      vi.stubEnv("SESSION_SECRET", "");
      fs.writeFileSync(path.join(tmp, ".env"), "SESSION_SECRET=bootgate-secret-0123456789abcdef\n");
      expect(() => assertProductionReady()).not.toThrow();

      // process.env wins over the file when both are present.
      vi.stubEnv("SESSION_SECRET", "env-secret-0123456789abcdef0123456789abcd");
      expect(() => assertProductionReady()).not.toThrow();
    } finally {
      // Windows locks the process cwd: chdir back before the dir can be removed.
      process.chdir(savedCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("F10: update_support_ticket is staff-only (policy + handler)", () => {
  it("authorize() denies customers, allows staff", () => {
    expect(authorize("update_support_ticket", principal("CUST-1", "customer")).allowed).toBe(false);
    expect(authorize("update_support_ticket", principal("SUPP-1", "support_agent")).allowed).toBe(true);
    expect(authorize("update_support_ticket", principal("ADMIN-1", "admin")).allowed).toBe(true);
  });

  it("the handler itself rejects a customer principal (direct runTool call)", async () => {
    const env = makeEnv();
    const created = await runTool(
      { repo: env.repo, auditor: env.auditor, principal: principal("CUST-1", "customer"), conversationId: null },
      "create_support_ticket",
      { subject: "My issue", description: "Something broke.", priority: "low" },
    );
    const id = created.ok ? (created.data as any).ticket.id : "";
    expect(id).toMatch(/^TCK-/);
    const res = await runTool(
      { repo: env.repo, auditor: env.auditor, principal: principal("CUST-1", "customer"), conversationId: null },
      "update_support_ticket",
      { ticketId: id, status: "resolved" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });
});

describe("F3/F11: fixed-window rate limiter", () => {
  it("allows up to the limit, then blocks within the window", () => {
    expect(allowRequest("k", 3, 60_000)).toBe(true);
    expect(allowRequest("k", 3, 60_000)).toBe(true);
    expect(allowRequest("k", 3, 60_000)).toBe(true);
    expect(allowRequest("k", 3, 60_000)).toBe(false);
    // Independent keys are unaffected.
    expect(allowRequest("other", 3, 60_000)).toBe(true);
  });

  it("reopens after the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(allowRequest("k2", 2, 60_000)).toBe(true);
    expect(allowRequest("k2", 2, 60_000)).toBe(true);
    expect(allowRequest("k2", 2, 60_000)).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(allowRequest("k2", 2, 60_000)).toBe(true);
  });
});

describe("F13: id generation is fully CSPRNG-backed", () => {
  it("matches the format and has no collisions across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = genId("TCK");
      expect(id).toMatch(/^TCK-\d{4}[0-9a-f]{4}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(2000);
  });
});

describe("F8: security response headers (strict CSP in prod, dev toolchain exempt)", () => {
  const headersFor = async (nodeEnv: string) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    const [{ headers }] = await nextConfig.headers!();
    return headers;
  };
  const value = (headers: { key: string; value: string }[], key: string) =>
    headers.find((h) => h.key === key)?.value;

  it("production sends a strict CSP plus hardening headers", async () => {
    const headers = await headersFor("production");
    expect(value(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(value(headers, "X-Frame-Options")).toBe("DENY");
    expect(value(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(value(headers, "Strict-Transport-Security")).toMatch(/max-age=63072000; includeSubDomains; preload/);
    const csp = value(headers, "Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("development omits the CSP (dev toolchain needs eval) but keeps the rest", async () => {
    const headers = await headersFor("development");
    expect(value(headers, "Content-Security-Policy")).toBeUndefined();
    expect(value(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(value(headers, "X-Frame-Options")).toBe("DENY");
  });
});
