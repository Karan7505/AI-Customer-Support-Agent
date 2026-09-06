import { createHmac } from "node:crypto";
import type { Repo } from "@/db/repos";
import { verifyPassword, randomToken } from "./security";
import { Errors } from "./errors";
import { nowMs } from "./util";
import { sessionSecret } from "./env";
import type { Principal } from "./types";

export const SESSION_COOKIE = "support_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Demo password accepted by login for every seeded account so the demo is
 * trivially usable (e.g. jane@example.com / demo1234). Not a production scheme.
 */
export const DEMO_PASSWORD = "demo1234";

/**
 * Log in with email + password. Returns the server-resolved principal and a
 * signed, persisted session token. Identity is always established here,
 * server-side; the LLM/UI never supplies a trusted customerId.
 */
export function login(
  repo: Repo,
  email: string,
  password: string,
): { principal: Principal; token: string; expiresAt: number } {
  const row = repo.getCustomerByEmail(email);
  if (!row) throw Errors.unauthorized("No account found for that email.");
  const ok = password === DEMO_PASSWORD || verifyPassword(password, row.passwordHash);
  if (!ok) throw Errors.unauthorized("Incorrect password.");

  const t = nowMs();
  const expiresAt = t + SESSION_TTL_MS;
  const token = `${randomToken(16)}.${signToken(row.id, expiresAt)}`;
  repo.createSession({ token, customerId: row.id, createdAt: t, expiresAt });
  return { principal: toPrincipal(row), token, expiresAt };
}

function signToken(customerId: string, expiresAt: number): string {
  return createHmac("sha256", sessionSecret())
    .update(`${customerId}:${expiresAt}`)
    .digest("hex")
    .slice(0, 16);
}

export function logout(repo: Repo, token: string): void {
  if (token) repo.revokeSession(token);
}

/** Resolve the authenticated principal from a raw cookie token, or null. */
export function getPrincipal(repo: Repo, token: string | undefined): Principal | null {
  if (!token) return null;
  const session = repo.getSession(token);
  if (!session) return null;
  if (nowMs() > session.expiresAt) {
    repo.revokeSession(token);
    return null;
  }
  const customer = repo.getCustomer(session.customerId);
  if (!customer) return null;
  return toPrincipal(customer);
}

function toPrincipal(row: { id: string; name: string; email: string; role: any }): Principal {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}
