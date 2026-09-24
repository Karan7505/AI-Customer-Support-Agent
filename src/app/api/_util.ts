import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { getPrincipal, SESSION_COOKIE } from "@/lib/auth";
import { logRuntimeMode } from "@/lib/env";
import { newCorrelationId, runWithCorrelation, logger } from "@/lib/logger";
import { recordHttpRequest, ensureMetricsServer } from "@/lib/metrics";
import { nowMs } from "@/lib/util";
import type { Principal } from "@/lib/types";
import { getRepo, type Repo } from "@/db/repos";

export function json(data: unknown, init?: { status?: number }) {
  return NextResponse.json(data, { status: init?.status ?? 200 });
}

/**
 * Uniform request wrapper (blueprint §10.1/§10.2):
 *  - correlation id: honours a client-supplied X-Request-Id (alphanumeric,
 *    ≤64 chars) or generates one; propagated to every log line in the
 *    request and echoed back in the X-Request-Id response header;
 *  - structured request/response logging;
 *  - http_requests_total + http_request_duration_seconds metrics;
 *  - lazy start of the localhost /metrics server.
 * The `path` argument is a STATIC label (e.g. "/api/tickets/:id"), never the
 * raw URL, so metric label cardinality stays bounded.
 */
export async function apiRequest(
  req: Request,
  method: string,
  path: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  ensureMetricsServer();
  const header = (req.headers.get("x-request-id") ?? "").trim().slice(0, 64);
  const corr = /^[A-Za-z0-9_-]+$/.test(header) ? header : newCorrelationId();
  const t0 = nowMs();
  let res: Response;
  try {
    res = await runWithCorrelation(corr, async () => {
      logger.debug("http request", { method, path });
      try {
        return await fn();
      } catch (e) {
        return httpError(e);
      }
    });
  } catch (e) {
    res = httpError(e);
  }
  const durationMs = nowMs() - t0;
  recordHttpRequest(method, path, res.status, durationMs);
  logger.info("http response", { method, path, status: res.status, durationMs });
  try {
    res.headers.set("x-request-id", corr);
  } catch {
    /* locked headers — extremely rare; correlation still in logs */
  }
  return res;
}

export function httpError(e: unknown): NextResponse {
  if (e instanceof AppError) {
    const status =
      e.code === "UNAUTHORIZED" ? 401 :
      e.code === "FORBIDDEN" ? 403 :
      e.code === "NOT_FOUND" || e.code === "APPROVAL_NOT_FOUND" ? 404 :
      e.code === "VALIDATION_ERROR" ? 400 :
      e.code === "DUPLICATE" ? 409 :
      500;
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details } },
      { status },
    );
  }
  // Never echo raw driver/exception messages to the client: DB errors can
  // contain SQL fragments, table/constraint names, and file paths. Log the
  // full error server-side, return a generic body.
  console.error("[aurora] unhandled request error:", e);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Internal error." } },
    { status: 500 },
  );
}

/** Best-effort client IP (first X-Forwarded-For hop behind a proxy, else unknown). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Repo for the current request (shared handle; SQLite or Postgres by env). */
export function deps(): { repo: Repo } {
  logRuntimeMode();
  return { repo: getRepo() };
}

export async function currentPrincipal(): Promise<Principal | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const { repo } = deps();
  return await getPrincipal(repo, token);
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: number) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure cookies only make sense over HTTPS; keep local http usable.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
  return response;
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function requireRole(roles: string[]): Promise<Principal | { error: NextResponse }> {
  const principal = await currentPrincipal();
  if (!principal)
    return { error: json({ error: { code: "UNAUTHORIZED", message: "Sign in required." } }, { status: 401 }) };
  if (!roles.includes(principal.role))
    return { error: json({ error: { code: "FORBIDDEN", message: "Insufficient role." } }, { status: 403 }) };
  return principal;
}
