import { createHmac } from "node:crypto";
import type { Repo } from "@/db/repos";
import { verifyPassword, hashPassword, randomToken, safeEqual } from "./security";
import { Errors } from "./errors";
import { nowMs } from "./util";
import { genId } from "./ids";
import { logger } from "./logger";
import {
  sessionSecret,
  sessionExpiresMs,
  emailVerificationRequired,
  emailVerificationTtlMs,
  passwordResetTtlMs,
  registrationEnabled,
  appUrl,
} from "./env";
import type { Principal } from "./types";
import type { CustomerRow } from "@/db/row-types";
import type { Auditor } from "./audit";
import { ROLE_CUSTOMER } from "@/db/schema";
import { notifyEvent } from "./notify";

export const SESSION_COOKIE = "support_session";

/**
 * Demo password for the seeded accounts. Accepted ONLY outside production so
 * the demo stays one-click usable while a production deployment can never be
 * entered with a shared, documented password.
 */
export const DEMO_PASSWORD = "demo1234";
function demoPasswordEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function toPrincipal(row: { id: string; name: string; email: string; role: any }): Principal {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function signToken(customerId: string, expiresAt: number): string {
  return createHmac("sha256", sessionSecret())
    .update(`${customerId}:${expiresAt}`)
    .digest("hex")
    .slice(0, 16);
}

/** Verify the HMAC signature portion of a session token. */
function tokenSigValid(token: string, customerId: string, expiresAt: number): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const sig = token.slice(dot + 1);
  const expected = signToken(customerId, expiresAt);
  return safeEqual(sig, expected);
}

export interface LoginResult {
  principal: Principal;
  token: string;
  expiresAt: number;
  emailVerified: number;
}

/**
 * Log in with email + password. Returns the server-resolved principal and a
 * signed, persisted session token. Identity is always established here,
 * server-side; the LLM/UI never supplies a trusted customerId.
 *
 * Lifecycle gates (blueprint §7.1): deactivated accounts and — when
 * EMAIL_VERIFICATION_REQUIRED — unverified accounts are blocked with distinct
 * errors (both only after credentials have already matched).
 */
export async function login(repo: Repo, email: string, password: string): Promise<LoginResult> {
  const row = await repo.getCustomerByEmail(email);
  // Single generic failure message: distinguishing "unknown email" from
  // "wrong password" would let attackers enumerate registered accounts.
  const badCredentials = () => Errors.unauthorized("Invalid email or password.");
  if (!row) throw badCredentials();
  const ok =
    (demoPasswordEnabled() && password === DEMO_PASSWORD) ||
    verifyPassword(password, row.passwordHash);
  if (!ok) throw badCredentials();
  if (row.deactivatedAt) {
    logger.warn("login blocked (account deactivated)", { customerId: row.id });
    throw Errors.accountDeactivated();
  }
  if (emailVerificationRequired() && row.emailVerified !== 1) {
    logger.warn("login blocked (email not verified)", { customerId: row.id });
    throw Errors.emailNotVerified();
  }

  const t = nowMs();
  const expiresAt = t + sessionExpiresMs();
  const token = `${randomToken(16)}.${signToken(row.id, expiresAt)}`;
  await repo.createSession({ token, customerId: row.id, createdAt: t, expiresAt, lastActivityAt: t });
  logger.info("login ok", { customerId: row.id, role: row.role });
  return { principal: toPrincipal(row), token, expiresAt, emailVerified: row.emailVerified };
}

export async function logout(repo: Repo, token: string): Promise<void> {
  if (token) await repo.revokeSession(token);
}

/** Update last-activity on a bounded cadence (5 min) — never blocks the request. */
const ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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
  const now = nowMs();
  if (now > session.expiresAt) {
    await repo.revokeSession(token);
    return null;
  }
  // Bounded-cadence activity touch: at most one write per 5 min per session.
  if (session.lastActivityAt === null || now - session.lastActivityAt > ACTIVITY_TOUCH_INTERVAL_MS) {
    repo.touchSession(token, now).catch(() => {});
  }
  const customer = await repo.getCustomer(session.customerId);
  if (!customer) return null;
  if (customer.deactivatedAt) return null; // defense in depth (revoked at deactivation)
  return toPrincipal(customer);
}

/* -------------------------------------------------------------------------- */
/*  Credential lifecycle (blueprint §7.1 / §7.4)                               */
/* -------------------------------------------------------------------------- */

/**
 * Register a new customer account (role is always "customer" — staff/admin are
 * seed-only). When email verification is required the account starts
 * unverified and gets a 24h verification token + email.
 */
export async function register(
  repo: Repo,
  auditor: Auditor,
  input: { name: string; email: string; password: string },
): Promise<{ customerId: string; requiresVerification: boolean }> {
  if (!registrationEnabled()) throw Errors.forbidden("Registration is disabled.");
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const existing = await repo.getCustomerByEmail(email);
  if (existing) throw Errors.duplicate("An account with this email already exists.");

  const requiresVerification = emailVerificationRequired();
  const id = genId("CUST");
  const t = nowMs();
  const token = requiresVerification ? randomToken(32) : null;
  await repo.createCustomer({
    id,
    name,
    email,
    passwordHash: hashPassword(input.password),
    role: ROLE_CUSTOMER,
    createdAt: t,
    emailVerified: requiresVerification ? 0 : 1,
    emailVerificationToken: token,
    emailVerificationSentAt: token ? t : null,
  });
  if (token) {
    notifyEvent("account_verification", { email, customerId: id, name, token, appUrl: appUrl() });
  }
  await auditor.log(
    { actor: { id, role: ROLE_CUSTOMER, name, email }, conversationId: null },
    "auth.registered",
    { result: { customerId: id, requiresVerification }, status: "success" },
  );
  logger.info("account registered", { customerId: id, requiresVerification });
  return { customerId: id, requiresVerification };
}

/** Consume a 24h verification token. Invalid/expired → TOKEN_INVALID (400). */
export async function verifyEmail(repo: Repo, auditor: Auditor, token: string): Promise<void> {
  const row = await repo.getCustomerByVerificationToken(token);
  if (!row) throw Errors.tokenInvalid();
  if (row.deactivatedAt) throw Errors.accountDeactivated();
  if (row.emailVerificationSentAt !== null && nowMs() - row.emailVerificationSentAt > emailVerificationTtlMs()) {
    throw Errors.tokenInvalid("Your verification link has expired. Register again or contact support.");
  }
  await repo.updateCustomer(row.id, {
    emailVerified: 1,
    emailVerificationToken: null,
    emailVerificationSentAt: null,
  });
  await auditor.log({ actor: toPrincipal(row) }, "auth.email_verified", {
    result: { customerId: row.id },
    status: "success",
  });
  logger.info("email verified", { customerId: row.id });
}

/**
 * Change password with session ROTATION: verify current, hash new, revoke ALL
 * existing sessions for the customer, mint one fresh (the caller's session).
 */
export async function changePassword(
  repo: Repo,
  auditor: Auditor,
  row: CustomerRow,
  currentPassword: string,
  newPassword: string,
): Promise<{ token: string; expiresAt: number }> {
  if (!verifyPassword(currentPassword, row.passwordHash)) {
    throw Errors.unauthorized("Current password is incorrect.");
  }
  await repo.updateCustomer(row.id, { passwordHash: hashPassword(newPassword) });
  await repo.revokeAllSessionsForCustomer(row.id);
  const t = nowMs();
  const expiresAt = t + sessionExpiresMs();
  const token = `${randomToken(16)}.${signToken(row.id, expiresAt)}`;
  await repo.createSession({ token, customerId: row.id, createdAt: t, expiresAt, lastActivityAt: t });
  await auditor.log({ actor: toPrincipal(row) }, "auth.password_changed", {
    result: { customerId: row.id },
    status: "success",
  });
  logger.info("password changed (sessions rotated)", { customerId: row.id });
  return { token, expiresAt };
}

/**
 * Request a password reset. Anti-enumeration: always resolves (never throws on
 * unknown email); a token + email are only produced for real, active accounts.
 */
export async function requestPasswordReset(
  repo: Repo,
  auditor: Auditor,
  email: string,
): Promise<void> {
  const row = await repo.getCustomerByEmail(email.trim().toLowerCase());
  if (!row || row.deactivatedAt) return; // same observable outcome either way
  const token = randomToken(32);
  const t = nowMs();
  await repo.updateCustomer(row.id, { emailResetToken: token, emailResetSentAt: t });
  notifyEvent("password_reset", { email: row.email, customerId: row.id, name: row.name, token, appUrl: appUrl() });
  await auditor.log({ actor: toPrincipal(row) }, "auth.password_reset_requested", {
    result: { customerId: row.id },
    status: "success",
  });
}

/** Consume a 1h reset token: set the new password and revoke all sessions. */
export async function resetPassword(
  repo: Repo,
  auditor: Auditor,
  token: string,
  newPassword: string,
): Promise<void> {
  const row = await repo.getCustomerByResetToken(token);
  if (!row) throw Errors.tokenInvalid();
  if (row.deactivatedAt) throw Errors.accountDeactivated();
  if (row.emailResetSentAt !== null && nowMs() - row.emailResetSentAt > passwordResetTtlMs()) {
    throw Errors.tokenInvalid("Your reset link has expired.");
  }
  await repo.updateCustomer(row.id, {
    passwordHash: hashPassword(newPassword),
    emailResetToken: null,
    emailResetSentAt: null,
  });
  // Rotate everything: a reset invalidates all existing sessions.
  await repo.revokeAllSessionsForCustomer(row.id);
  await auditor.log({ actor: toPrincipal(row) }, "auth.password_reset", {
    result: { customerId: row.id },
    status: "success",
  });
  logger.info("password reset (all sessions revoked)", { customerId: row.id });
}

/** Soft-deactivate an account (admin action). Row is retained, never deleted. */
export async function deactivateUser(
  repo: Repo,
  auditor: Auditor,
  actor: Principal,
  customerId: string,
): Promise<void> {
  const row = await repo.getCustomer(customerId);
  if (!row) throw Errors.notFound("Customer");
  if (row.role !== ROLE_CUSTOMER) {
    throw Errors.forbidden("Only customer accounts can be deactivated here.");
  }
  const t = nowMs();
  await repo.updateCustomer(row.id, { deactivatedAt: t });
  await repo.revokeAllSessionsForCustomer(row.id);
  await auditor.log({ actor, conversationId: null }, "auth.account_deactivated", {
    result: { customerId: row.id },
    status: "success",
    metadata: { deactivatingSelf: actor.id === row.id },
  });
  logger.warn("account deactivated", { customerId: row.id, by: actor.id });
}
