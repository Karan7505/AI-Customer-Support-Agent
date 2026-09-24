import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, principal } from "../helpers";
import {
  login,
  register,
  verifyEmail,
  changePassword,
  requestPasswordReset,
  resetPassword,
  deactivateUser,
  getPrincipal,
  DEMO_PASSWORD,
} from "@/lib/auth";
import { nowMs } from "@/lib/util";

describe("identity lifecycle (blueprint §7.1/§7.4)", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_VERIFICATION_REQUIRED", "true");
    vi.stubEnv("REGISTRATION_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", ""); // no email delivery in unit tests
  });
  afterEach(() => vi.unstubAllEnvs());

  function row(raw: any, email: string) {
    return raw.prepare("SELECT * FROM customers WHERE email = ?").get(email) as any;
  }

  it("registration creates an unverified account and blocks login until verified", async () => {
    const env = makeEnv();
    await expect(login(env.repo, "new@t.com", DEMO_PASSWORD)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const r = await register(env.repo, env.auditor, { name: "New User", email: "new@t.com", password: "password123" });
    expect(r.requiresVerification).toBe(true);
    const rec = row(env.raw, "new@t.com");
    expect(rec.email_verified).toBe(0);
    expect(rec.email_verification_token).toBeTruthy();

    await expect(login(env.repo, "new@t.com", "password123")).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

    await verifyEmail(env.repo, env.auditor, rec.email_verification_token);
    expect(row(env.raw, "new@t.com").email_verified).toBe(1);
    const s = await login(env.repo, "new@t.com", "password123");
    expect(s.emailVerified).toBe(1);
  });

  it("rejects duplicate email and short passwords are validated at the route (lib: duplicate here)", async () => {
    const env = makeEnv();
    await register(env.repo, env.auditor, { name: "A User", email: "dup@t.com", password: "password123" });
    await expect(
      register(env.repo, env.auditor, { name: "B User", email: "dup@t.com", password: "password456" }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("verification token is single-use and expires after 24h", async () => {
    const env = makeEnv();
    await register(env.repo, env.auditor, { name: "Tok User", email: "tok@t.com", password: "password123" });
    const token = row(env.raw, "tok@t.com").email_verification_token;

    // Expire it by backdating sent_at.
    env.raw.prepare("UPDATE customers SET email_verification_sent_at = ? WHERE email = 'tok@t.com'").run(nowMs() - 25 * 3600 * 1000);
    await expect(verifyEmail(env.repo, env.auditor, token)).rejects.toMatchObject({ code: "TOKEN_INVALID" });

    // Fresh token verifies, then is consumed (second use fails).
    env.raw.prepare("UPDATE customers SET email_verification_sent_at = NULL WHERE email = 'tok@t.com'").run();
    await verifyEmail(env.repo, env.auditor, token);
    await expect(verifyEmail(env.repo, env.auditor, token)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    await expect(verifyEmail(env.repo, env.auditor, "bogus-token-value")).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("EMAIL_VERIFICATION_REQUIRED=false verifies new accounts immediately", async () => {
    vi.stubEnv("EMAIL_VERIFICATION_REQUIRED", "false");
    const env = makeEnv();
    const r = await register(env.repo, env.auditor, { name: "NoVerify", email: "nv@t.com", password: "password123" });
    expect(r.requiresVerification).toBe(false);
    expect(row(env.raw, "nv@t.com").email_verified).toBe(1);
    const s = await login(env.repo, "nv@t.com", "password123");
    expect(s.principal.email).toBe("nv@t.com");
  });

  it("change password rotates sessions: old token dead, new token works", async () => {
    const env = makeEnv();
    const first = await login(env.repo, "jane@t.com", DEMO_PASSWORD);
    expect(await getPrincipal(env.repo, first.token)).toBeTruthy();

    const jane = await env.repo.getCustomerByEmail("jane@t.com");
    await expect(
      changePassword(env.repo, env.auditor, jane!, "wrong-password", "newpassword1"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const rotated = await changePassword(env.repo, env.auditor, jane!, DEMO_PASSWORD, "newpassword1");
    expect(rotated.token).not.toBe(first.token);
    expect(await getPrincipal(env.repo, first.token)).toBeNull(); // old session revoked
    const fresh = await getPrincipal(env.repo, rotated.token);
    expect(fresh?.id).toBe(jane!.id);
    // The new password works. (Note: in test env the dev-only DEMO_PASSWORD
    // bypass from auth.ts still admits demo1234 — production has no bypass.)
    const s2 = await login(env.repo, "jane@t.com", "newpassword1");
    expect(s2.principal.id).toBe(jane!.id);
  });

  it("forgot-password is anti-enumeration; reset token works once and revokes sessions", async () => {
    const env = makeEnv();
    // Unknown email: resolves fine, no token anywhere.
    await expect(requestPasswordReset(env.repo, env.auditor, "ghost@t.com")).resolves.toBeUndefined();

    const session = await login(env.repo, "jane@t.com", DEMO_PASSWORD);
    await requestPasswordReset(env.repo, env.auditor, "jane@t.com");
    let jane = row(env.raw, "jane@t.com");
    expect(jane.email_reset_token).toBeTruthy();
    const token = jane.email_reset_token;

    // Expired reset token is rejected.
    env.raw.prepare("UPDATE customers SET email_reset_sent_at = ? WHERE email = 'jane@t.com'").run(nowMs() - 2 * 3600 * 1000);
    await expect(resetPassword(env.repo, env.auditor, token, "resetpass123")).rejects.toMatchObject({ code: "TOKEN_INVALID" });

    // Fresh reset: new password works, all sessions revoked, token consumed.
    env.raw.prepare("UPDATE customers SET email_reset_sent_at = NULL WHERE email = 'jane@t.com'").run();
    await resetPassword(env.repo, env.auditor, token, "resetpass123");
    expect(await getPrincipal(env.repo, session.token)).toBeNull();
    await expect(resetPassword(env.repo, env.auditor, token, "resetpass456")).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    const s2 = await login(env.repo, "jane@t.com", "resetpass123");
    expect(s2.principal.email).toBe("jane@t.com");
  });

  it("deactivated accounts cannot log in or use existing sessions", async () => {
    const env = makeEnv();
    const session = await login(env.repo, "jane@t.com", DEMO_PASSWORD);
    expect(await getPrincipal(env.repo, session.token)).toBeTruthy();

    const admin = principal("ADMIN-1", "admin");
    await deactivateUser(env.repo, env.auditor, admin, "CUST-1");

    expect(row(env.raw, "jane@t.com").deactivated_at).toBeGreaterThan(0);
    expect(await getPrincipal(env.repo, session.token)).toBeNull();
    await expect(login(env.repo, "jane@t.com", DEMO_PASSWORD)).rejects.toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
  });

  it("staff roles cannot be deactivated via this endpoint", async () => {
    const env = makeEnv();
    const admin = principal("ADMIN-1", "admin");
    await expect(deactivateUser(env.repo, env.auditor, admin, "ADMIN-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
