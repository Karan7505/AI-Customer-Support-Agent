import { createHmac } from "node:crypto";
import type { Repo } from "@/db/repos";
import { verifyPassword, randomToken, safeEqual } from "./security";
import { Errors } from "./errors";
import { nowMs } from "./util";
import { sessionSecret } from "./env";
import type { Principal } from "./types";

export const SESSION_COOKIE = "support_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Demo password for the seeded accounts (e.g. jane@example.com / demo1234).
 * Accepted ONLY outside production so the demo stays one-click usable while a
 * production deployment can never be entered with a shared, documented password.
 */
export const DEMO_PASSWORD = "demo1234";
function demoPasswordEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Log in with email + password. Returns the server-resolved principal and a
 * signed, persisted session token. Identity is always established here,
 * server-side; the LLM/UI never supplies a trusted customerId.
 */
export async function login(
  repo: Repo,
  email: string,
  password: string,
): Promise<{ principal: Principal; token: string; expiresAt: number }> {
  const row = await repo.getCustomerByEmail(email);
  // Single generic failure message: distinguishing "unknown email" from
  // "wrong password" would let attackers enumerate registered accounts.
  const badCredentials = () => Errors.unauthorized("Invalid email or password.");
  if (!row) throw badCredentials();
  const ok =
    (demoPasswordEnabled() && password === DEMO_PASSWORD) ||
    verifyPassword(password, row.passwordHash);
  if (!ok) throw badCredentials();

  const t = nowMs();
  const expiresAt = t + SESSION_TTL_MS;
  const token = `${randomToken(16)}.${signToken(row.id, expiresAt)}`;
  await repo.createSession({ token, customerId: row.id, createdAt: t, expiresAt });
  return { principal: toPrincipal(row), token, expiresAt };
}

function signToken(customerId: string, expiresAt: number): string {
  return createHmac("sha256", sessionSecret())
    .update(`${customerId}:${expiresAt}`)
    .digest("hex")
    .slice(0, 16);
}

export async function logout(repo: Repo, token: string): Promise<void> {
  if (token) await repo.revokeSession(token);
}

/** Verify the HMAC signature portion of a session token. */
function tokenSigValid(token: string, customerId: string, expiresAt: number): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const sig = token.slice(dot + 1);
  const expected = signToken(customerId, expiresAt);
  return safeEqual(sig, expected);
}

/** Resolve the authenticated principal from a raw cookie token, or null. */
export async function getPrincipal(repo: Repo, token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const session = await repo.getSession(token);
  if (!session) return null;
  // Defense in depth: the random token alone is the primary check (DB lookup);
  // the HMAC additionally binds the token to this deployment's SESSION_SECRET,
  // so a token copied from a leaked DB copy is useless without the secret.
  if (!tokenSigValid(token, session.customerId, session.expiresAt)) {
    await repo.revokeSession(token);
    return null;
  }
  if (nowMs() > session.expiresAt) {
    await repo.revokeSession(token);
    return null;
  }
  const customer = await repo.getCustomer(session.customerId);
  if (!customer) return null;
  return toPrincipal(customer);
}

function toPrincipal(row: { id: string; name: string; email: string; role: any }): Principal {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
