import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { createRepo } from "@/db/repos";
import { AppError } from "@/lib/errors";
import { getPrincipal, SESSION_COOKIE } from "@/lib/auth";
import type { Principal } from "@/lib/types";
import type { Repo } from "@/db/repos";

export function json(data: unknown, init?: { status?: number }) {
  return NextResponse.json(data, { status: init?.status ?? 200 });
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
  return NextResponse.json(
    { error: { code: "INTERNAL", message: e instanceof Error ? e.message : "Internal error" } },
    { status: 500 },
  );
}

/** Repo for the current request (all routes use the same sqlite handle). */
export function deps(): { repo: Repo } {
  return { repo: createRepo(getDb()) };
}

export async function currentPrincipal(): Promise<Principal | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const { repo } = deps();
  return getPrincipal(repo, token);
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: number) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // local http demo; set true in production https
    path: "/",
    expires: new Date(expiresAt),
  });
  return response;
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
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
